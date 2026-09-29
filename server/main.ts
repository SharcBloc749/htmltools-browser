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

Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8787) }, async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

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
      fwd = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(hd.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
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
});
