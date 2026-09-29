// ─────────────────────────────────────────────────────────────────────────
// HTMLTools Browser — shared config. This is the ONLY file you edit after
// deploying. Everything else stays untouched.
// ─────────────────────────────────────────────────────────────────────────

// 1) URL of your proxy backend (deploy server/main.ts to deno.dev — free,
//    no card — then paste the URL you get here).
export const BACKEND = 'https://htmltools-proxy.deno.dev';

// 2) Default search engine for non-URL input in the address bar.
export const SEARCH = 'https://duckduckgo.com/?q=';

// 3) Secret used to scramble proxied URLs. Change it to any random string.
//    (runtime.js gets the real value baked in by the service worker, so you
//    only ever change it here.)
export const KEY = 'htmltools-change-me-9f2k';
