// ─────────────────────────────────────────────────────────────────────────
// HTMLTools Browser — proxy backend (Deno).
//
// Deliberately dumb and stateless: it receives a target URL + forwarded
// headers, streams the upstream response back with CORS opened up, and
// relays status/headers/set-cookies through two x-proxy-* headers.
// No WASM. No WebSocket relay. No storage. Deploy it anywhere Deno runs.
//
// Local:   deno run -A server/main.ts        → http://localhost:8787
// Deploy:  deno.dev → New Project → import this repo → entrypoint
//          server/main.ts. Free tier, no card.
// ─────────────────────────────────────────────────────────────────────────

function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b + '='.repeat((4 - (b.length % 4)) % 4);
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Request headers we allow through to the upstream site.
const REQ_ALLOW = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'origin',
  'range',
  'referer',
  'user-agent',
]);

// Response headers we relay back to the service worker (inside the JSON).
const RES_ALLOW = [
  'content-type',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'location',
  'refresh',
  'content-disposition',
  'www-authenticate',
  'vary',
];

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'x-proxy-status, x-proxy-headers',
  'access-control-max-age': '86400',
};

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === '/proxyws') return proxyWs(req);

  if (url.pathname === '/' || url.pathname === '/health') {
    return Response.json(
      { service: 'htmltools-proxy', ok: true, version: '1.0.0' },
      { headers: CORS },
    );
  }
  if (url.pathname !== '/proxy') {
    return new Response('not found', { status: 404, headers: CORS });
  }

  const target = url.searchParams.get('url') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad scheme');
  } catch {
    return new Response('bad or missing ?url=', { status: 400, headers: CORS });
  }

  // Forwarded headers ride in ?hd= (base64url JSON) to avoid CORS preflights.
  let fwd: Record<string, string> = {};
  const hd = url.searchParams.get('hd');
  if (hd) {
    try {
      fwd = JSON.parse(b64urlDecode(hd));
    } catch { /* ignore malformed */ }
  }

  const upstreamHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(fwd)) {
    if (REQ_ALLOW.has(k.toLowerCase()) && typeof v === 'string') upstreamHeaders[k.toLowerCase()] = v;
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsed.href, {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers: upstreamHeaders,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return Response.json(
      { error: 'upstream_failed', detail: String((err as Error)?.message ?? err) },
      { status: 504, headers: CORS },
    );
  }

  // Fold upstream status + headers into two inspectable headers.
  const meta: Record<string, string | string[]> = {};
  for (const h of RES_ALLOW) {
    const v = upstream.headers.get(h);
    if (v) meta[h] = v;
  }
  const setCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [];
  if (setCookies.length) meta['set-cookie'] = setCookies;

  const outHeaders: Record<string, string> = {
    ...CORS,
    'x-proxy-status': String(upstream.status),
    'x-proxy-headers': JSON.stringify(meta),
    'content-type': 'application/octet-stream', // real type travels in meta
  };

  return new Response(upstream.body, { status: 200, headers: outHeaders });
}

// ── WebSocket relay ──────────────────────────────────────────────────────
// /proxyws?u=<ws(s) target>&hd=<b64url JSON {cookie, origin, protocol}>
// Upgrades the browser connection, dials the real server, pipes frames.
function proxyWs(req: Request): Response {
  const url = new URL(req.url);
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 400, headers: CORS });
  }

  const target = url.searchParams.get('u') ?? '';
  let t: URL;
  try {
    t = new URL(target);
    if (t.protocol !== 'ws:' && t.protocol !== 'wss:') throw new Error('bad scheme');
  } catch {
    return new Response('bad or missing ?u=', { status: 400, headers: CORS });
  }

  let fwd: Record<string, unknown> = {};
  const hd = url.searchParams.get('hd');
  if (hd) {
    try {
      fwd = JSON.parse(b64urlDecode(hd));
    } catch { /* ignore malformed */ }
  }

  const { socket: client, response } = Deno.upgradeWebSocket(req);

  let upstream: WebSocket;
  try {
    const protocol = typeof fwd.protocol === 'string' && fwd.protocol ? [fwd.protocol] : [];
    upstream = protocol.length ? new WebSocket(t.href, protocol) : new WebSocket(t.href);
    upstream.binaryType = 'arraybuffer';
  } catch {
    try { client.close(1011, 'upstream dial failed'); } catch { /* ignore */ }
    return response;
  }

  // Buffer client frames until the upstream socket is open — the browser's
  // "open" fires on the *upgrade*, which can beat the upstream dial.
  const queue: (string | ArrayBuffer | Uint8Array)[] = [];
  let upstreamOpen = false;

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const f of queue.splice(0)) {
      try { upstream.send(f as string); } catch { /* ignore */ }
    }
  };
  upstream.onmessage = async (e: MessageEvent) => {
    try {
      let data: unknown = e.data;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      if (client.readyState === WebSocket.OPEN) client.send(data as string | ArrayBuffer);
    } catch { /* ignore */ }
  };
  upstream.onerror = () => {
    try { client.close(1011, 'upstream error'); } catch { /* ignore */ }
  };
  upstream.onclose = (e: CloseEvent) => {
    try { client.close(e.code, e.reason); } catch { /* ignore */ }
  };

  client.onmessage = async (e: MessageEvent) => {
    try {
      let data: unknown = e.data;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      if (!upstreamOpen) {
        queue.push(data as string);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data as string | ArrayBuffer);
    } catch { /* ignore */ }
  };
  client.onclose = (e: CloseEvent) => {
    try { upstream.close(e.code || 1000, e.reason); } catch { /* ignore */ }
  };
  client.onerror = () => {
    try { upstream.close(); } catch { /* ignore */ }
  };

  return response;
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8787) }, handler);
}
