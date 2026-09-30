// HTMLTools Browser — proxy backend v2.0.0  (Deno Deploy, free tier)
//
// Same protocol as v1 (the app needs no changes to talk to it):
//   GET/POST/... /proxy?url=<target>&hd=<base64url JSON of request headers>
//       -> always HTTP 200; real status in  x-proxy-status ; upstream headers in x-proxy-headers (JSON)
//   WebSocket  /proxyws?u=<wss target>&hd=<base64url JSON {cookie, origin, protocol}>
//   GET /  (health)
//
// What's new in v2:
//   * OPTIONAL ORIGIN LOCK (OFF by default – works from any site, like v1).
//                    To restrict it to htmltools.me later, set the env var  LOCK_ORIGINS = 1
//                    (extra allowed origins: env var ALLOW_ORIGINS = "https://a.example,https://b.example")
//   * FULL HEADER FORWARDING – every header the page set (x-goog-api-key, x-csrf-token,
//     sec-ch-ua, sec-fetch-*, ...) now reaches the target site. v1 only forwarded ~10, which
//     broke YouTube's bot-check API, many logins and many SPAs.
//   * Blocks requests aimed at private/internal addresses (SSRF protection).

const VERSION = "2.0.1";
const LOCK = Deno.env.get("LOCK_ORIGINS") === "1";

const ALLOWED = new Set<string>([
  "https://htmltools.me",
  "https://www.htmltools.me",
]);
for (const o of (Deno.env.get("ALLOW_ORIGINS") || "").split(",")) {
  const t = o.trim().replace(/\/+$/, "");
  if (t) ALLOWED.add(t);
}

// Request headers that must never be forwarded upstream.
const DROP_REQ =
  /^(host|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|x-forwarded-.*|x-real-ip|forwarded|via|cdn-loop|x-deno-.*|traceparent|tracestate|accept-encoding|expect)$/i;

// Upstream response headers handed back to the app (inside x-proxy-headers).
const KEEP_RES = new Set([
  "content-type", "content-range", "accept-ranges", "cache-control", "etag",
  "last-modified", "expires", "content-disposition", "www-authenticate", "vary",
  "location", "refresh", "link",
]);

function callerOrigin(req: Request): string {
  const o = req.headers.get("origin");
  if (o) return o;
  const r = req.headers.get("referer");
  if (r) { try { return new URL(r).origin; } catch { /* ignore */ } }
  return "";
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "vary": "origin",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "x-proxy-status, x-proxy-headers",
    "access-control-max-age": "86400",
  };
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return h.includes(":");
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [parseInt(m[1]), parseInt(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return false;
}

function b64urlDecodeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const bin = atob(b);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

// HTTP header values must be ASCII: escape everything else as \uXXXX inside the JSON.
function asciiJson(o: unknown): string {
  return JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}

async function handleProxy(req: Request, url: URL, cors: Record<string, string>): Promise<Response> {
  const target = url.searchParams.get("url") || "";
  let t: URL;
  try { t = new URL(target); } catch { return new Response("bad or missing ?url=", { status: 400, headers: cors }); }
  if (t.protocol !== "http:" && t.protocol !== "https:") {
    return new Response("bad or missing ?url=", { status: 400, headers: cors });
  }
  if (isPrivateHost(t.hostname)) return json(403, { error: "blocked_target" }, cors);

  const hd = b64urlDecodeJson(url.searchParams.get("hd"));
  const headers = new Headers();
  for (const [k, v] of Object.entries(hd)) {
    if (typeof v !== "string" || !v || DROP_REQ.test(k)) continue;
    try { headers.set(k, v); } catch { /* invalid header name/value: skip */ }
  }

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  // Timeout applies to receiving the response HEADERS only (streams can run long).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  let up: Response;
  try {
    up = await fetch(t.href, { method, headers, body, redirect: "manual", signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    return json(504, { error: "upstream_failed", detail: String((e as Error)?.message || e) }, cors);
  }
  clearTimeout(timer);

  const meta: Record<string, unknown> = {};
  up.headers.forEach((v, k) => { if (KEEP_RES.has(k.toLowerCase())) meta[k.toLowerCase()] = v; });
  const sc = up.headers.getSetCookie?.() ?? [];
  if (sc.length) meta["set-cookie"] = sc;

  const noBody = method === "HEAD" || up.status === 204 || up.status === 304 || (up.status >= 100 && up.status < 200);
  return new Response(noBody ? null : up.body, {
    status: 200,
    headers: {
      ...cors,
      "content-type": "application/octet-stream",
      "x-proxy-status": String(up.status),
      "x-proxy-headers": asciiJson(meta),
    },
  });
}

function handleWs(req: Request, url: URL): Response {
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const target = url.searchParams.get("u") || "";
  let t: URL;
  try { t = new URL(target); } catch { return new Response("bad ?u=", { status: 400 }); }
  if ((t.protocol !== "wss:" && t.protocol !== "ws:") || isPrivateHost(t.hostname)) {
    return new Response("bad ?u=", { status: 400 });
  }
  const hd = b64urlDecodeJson(url.searchParams.get("hd"));

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  client.binaryType = "arraybuffer";

  const hdrs: Record<string, string> = {};
  if (typeof hd.cookie === "string" && hd.cookie) hdrs["cookie"] = hd.cookie;
  hdrs["origin"] = typeof hd.origin === "string" && hd.origin ? hd.origin : t.origin.replace(/^ws/, "http");
  const protocols = Array.isArray(hd.protocol) ? (hd.protocol as string[]) : typeof hd.protocol === "string" ? [hd.protocol] : undefined;

  let upstream: WebSocket;
  try {
    // deno-lint-ignore no-explicit-any
    upstream = new (WebSocket as any)(t.href, { headers: hdrs, protocols });
  } catch {
    try { upstream = new WebSocket(t.href, protocols); } catch { client.close(1011, "upstream_failed"); return response; }
  }
  upstream.binaryType = "arraybuffer";

  const queue: (string | ArrayBuffer)[] = [];
  client.onmessage = (e) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(e.data);
    else queue.push(e.data);
  };
  upstream.onopen = () => { for (const m of queue.splice(0)) upstream.send(m); };
  upstream.onmessage = (e) => { if (client.readyState === WebSocket.OPEN) client.send(e.data); };
  const safeClose = (ws: WebSocket, code?: number, reason?: string) => {
    try {
      if (ws.readyState <= WebSocket.OPEN) {
        const ok = code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 && code !== 1015;
        ws.close(ok ? code : 1000, reason || "");
      }
    } catch { /* ignore */ }
  };
  client.onclose = (e) => safeClose(upstream, e.code, e.reason);
  upstream.onclose = (e) => safeClose(client, e.code, e.reason);
  upstream.onerror = () => safeClose(client, 1011, "upstream_error");
  client.onerror = () => safeClose(upstream, 1011, "client_error");
  return response;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Health check stays public.
  if (url.pathname === "/" || url.pathname === "/health") {
    return json(200, { service: "htmltools-proxy", ok: true, version: VERSION }, { "access-control-allow-origin": "*" });
  }

  // ── origin lock ──
  const origin = callerOrigin(req);
  if (LOCK && !ALLOWED.has(origin)) {
    return new Response("Forbidden: this proxy only works on htmltools.me", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
  const cors = corsHeaders(LOCK ? origin : "*");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/proxy") return handleProxy(req, url, cors);
  if (url.pathname === "/proxyws") return handleWs(req, url);
  return new Response("not found", { status: 404, headers: cors });
}

Deno.serve(handler);
