# HTMLTools Browser

A fast, self-hosted proxy browser engine for htmltools.me. Own frontend, own
backend, $0/month, no bank account needed anywhere.

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  htmltools.me/browser/  │        │  your-proxy.deno.dev  (free) │
│  Cloudflare Pages       │        │  Deno Deploy                 │
│                         │        │                              │
│  index.html + app.js    │        │  /proxy?url=…                │
│  sw.js  (the engine) ───┼──fetch─┼──▶ fetches the real site,    │
│  rewrites HTML/CSS      │◀───────┼─── streams bytes back        │
│  iframe renders result  │ stream │    (CORS open, headers folded)│
└─────────────────────────┘        └──────────────────────────────┘
```

## What's new in v1.1 — "real browser" mode

- **Persistent cookie store.** Real Domain/Path/Expires/Max-Age/Secure/
  HttpOnly semantics, saved to IndexedDB — **logins survive browser
  restarts** now. `document.cookie` emulation stays per-site and HttpOnly
  cookies stay invisible to page JS, exactly like Chrome.
- **Per-site localStorage + sessionStorage.** Every site gets its own
  namespaced storage — no more sites fighting over the same keys.
- **WebSocket proxying.** `/proxyws` on the backend dials real `ws(s)://`
  servers and pipes frames both ways (text + binary). The page runtime
  swaps in a drop-in `WebSocket`, so chat apps, live scores, and games
  light up.
- **EventSource (SSE), `navigator.sendBeacon`, and Worker URLs** are
  routed through the engine too.

## Why this is faster than GUST

| GUST | HTMLTools Browser |
|---|---|
| Every request goes through WASM libcurl over one WebSocket to a shared WISP relay | Plain streaming `fetch()` — no WASM, no WebSocket relay |
| Whole page buffered in RAM, then rewritten, then injected | Only HTML/CSS are rewritten; images, fonts, scripts, video **stream straight through** |
| Public relay servers = far away + overloaded | Backend is yours; swap hosts in one line |
| Single ~1 MB HTML file parses before anything runs | A few small files — the browser caches each one separately |
| Every request = WebSocket frame round-trips | Zero CORS preflights: headers ride in the URL (`?hd=`) |
| No caching | Subresources get normal browser caching (`cache-control` passthrough) |

## Deploy (about 10 minutes)

### 1. Backend → Deno Deploy (free, no card)

1. Push this folder to a GitHub repo (e.g. `htmltools-browser`).
2. Go to **dash.deno.com** → sign in **with GitHub** (no card anywhere).
3. **New Project → Deploy from GitHub** → pick the repo.
4. Set the entrypoint to `server/main.ts`. Deploy.
5. You get a URL like `https://htmltools-proxy.deno.dev` — copy it.

(No GitHub repo? You can also use a Deno Deploy **Playground**: paste the
contents of `server/main.ts`, save, done.)

### 2. Frontend → Cloudflare Pages (you already have this)

1. Edit **one file**: `client/config.js` → paste your backend URL into `BACKEND`.
2. Copy the contents of `client/` into your site repo under `/browser/`
   (or create a second Pages project from this repo with root = `client/`).
3. Push. Cloudflare Pages deploys it → **https://htmltools.me/browser/**

That's it. Works at any path — put it at `/browser/`, `/lab/`, whatever.
The service worker auto-detects its scope; nothing else to change.

### 3. Test it

Open your URL, type `example.com`, hit Enter. You should see Example Domain
inside the frame and the real URL in the address bar.

## Local development

```bash
deno run -A server/main.ts            # backend on :8787
python3 -m http.server 8080 -d client # frontend on :8080
```

Then in the browser devtools console (on localhost:8080), once:

```js
localStorage.setItem('ht-backend', 'http://localhost:8787')
```

(`localhost` counts as a secure context, so the service worker works.)

## Files

```
client/
  index.html    launcher UI (tabs/bookmarks can grow here later)
  app.js        UI logic, navigation, engine bootstrap
  sw.js         ★ the proxy engine (service worker)
  runtime.js    injected into proxied pages: fetch/XHR/link/form/history
                hooks, cookie emulation, dynamic-DOM rewriter
  encoder.js    URL scrambling codec (shared with tests)
  rewrite.js    HTML/CSS URL rewriter (shared with tests)
  config.js     ← the only file you edit
server/
  main.ts       stateless streaming proxy backend (Deno)
tests/
  test.mjs      23 engine unit tests — npm test
```

## Honest limitations (v1.1)

- **Google will still CAPTCHA you sometimes.** That's IP reputation, not
  engine quality — every proxy on a datacenter IP has this, including GUST.
  The fix is hosting the backend on an IP you control someday (small VPS),
  not more code. The engine is host-agnostic by design.
- Very JS-heavy SPAs that hardcode `https://...` strings inside scripts can
  still leak requests around the engine (full AST rewriting of JS is the
  roadmap item — that's what Ultraviolet/Scramjet spend years on).
- **Google logins**: technically better now (real cookie semantics), but
  still don't log your main Google account into any proxy — CAPTCHAs +
  account-security flags are about the IP, and your credentials traverse
  your backend. Use throwaways.
- IndexedDB inside proxied pages is still shared across sites (cookies and
  localStorage are separated; IDB is the remaining overlap).
- reCAPTCHA/hCaptcha widgets may still complain (they check the visible
  domain, which is htmltools.me).
- Deno Deploy supports WebSockets; if some specific WS target misbehaves
  there, run the same `server/main.ts` on a VPS — zero code changes.

## Roadmap ideas

- Streaming HTML rewriter (never buffer big pages)
- Tabs, bookmarks, history, themes (the GUST feature set)
- Multiple backends + automatic failover/fastest-pick
- IndexedDB namespacing per site
- Single-file export (build script), if you ever want GUST-style portability
