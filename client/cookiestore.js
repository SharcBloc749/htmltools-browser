// ─────────────────────────────────────────────────────────────────────────
// HTMLTools Browser — cookie store (RFC 6265-lite, Chrome-flavored).
// Pure module: runs in the service worker AND in Node for tests.
//
// Emulates what matters for logins:
//   • Domain attribute (host-only vs domain cookies, suffix matching)
//   • Path attribute + RFC default-path + path matching
//   • Expires / Max-Age (expired cookies vanish; no attrs = session cookie)
//   • Secure flag (only sent over https)
//   • HttpOnly flag (sent upstream in requests, hidden from document.cookie)
// ─────────────────────────────────────────────────────────────────────────

/** RFC 6265 §5.1.4 default-path */
export function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const i = pathname.lastIndexOf('/');
  return i === 0 ? '/' : pathname.slice(0, i);
}

/** Domain matching: exact host, or host is a subdomain of cookieDomain. */
export function domainMatch(host, cookieDomain) {
  host = host.toLowerCase();
  cookieDomain = String(cookieDomain).toLowerCase().replace(/^\./, '');
  return host === cookieDomain || host.endsWith('.' + cookieDomain);
}

/** RFC 6265 §5.1.4 path-match */
export function pathMatch(path, cookiePath) {
  if (!path) path = '/';
  if (path === cookiePath) return true;
  if (path.startsWith(cookiePath)) {
    if (cookiePath.endsWith('/')) return true;
    if (path[cookiePath.length] === '/') return true;
  }
  return false;
}

function parseDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse one Set-Cookie header value in the context of a request URL.
 * Returns a cookie record or null (rejected/invalid).
 */
export function parseSetCookie(setCookieValue, requestUrl) {
  let url;
  try { url = new URL(requestUrl); } catch { return null; }
  const str = String(setCookieValue).trim();
  if (!str) return null;

  const firstSemi = str.indexOf(';');
  const nv = firstSemi === -1 ? str : str.slice(0, firstSemi);
  const eq = nv.indexOf('=');
  if (eq < 1) return null; // no name=value → ignore (per RFC)
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name) return null;

  const attrs = firstSemi === -1 ? [] : str.slice(firstSemi + 1).split(';');
  let domain = url.hostname.toLowerCase();
  let hostOnly = true;
  let path = null;
  let expiresTs = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = 'Lax';

  for (const raw of attrs) {
    const i = raw.indexOf('=');
    const key = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : raw.slice(i + 1).trim();
    if (key === 'domain') {
      if (val) {
        domain = val.toLowerCase().replace(/^\./, '');
        hostOnly = false;
      }
    } else if (key === 'path') {
      path = val || null;
    } else if (key === 'expires') {
      const t = parseDate(val);
      if (t !== null) expiresTs = t;
    } else if (key === 'max-age') {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) {
        if (n <= 0) expiresTs = 0; // expired
        else expiresTs = Date.now() + n * 1000;
      }
    } else if (key === 'secure') {
      secure = true;
    } else if (key === 'httponly') {
      httpOnly = true;
    } else if (key === 'samesite') {
      sameSite = /^(strict|lax|none)$/i.test(val) ? val.toLowerCase() : 'Lax';
    }
  }

  // Domain attribute must match the request host, else the cookie is rejected.
  if (!hostOnly && !domainMatch(url.hostname, domain)) return null;

  // Secure cookies may only be set over https (Chrome-enforced).
  if (secure && url.protocol !== 'https:') return null;

  return {
    name,
    value,
    domain,
    hostOnly,
    path: path || defaultPath(url.pathname),
    expiresTs,
    secure,
    httpOnly,
    sameSite,
    createdAt: Date.now(),
  };
}

/** Cookie identity: same name+domain+path replaces. */
function keyOf(c) {
  return c.name + '|' + (c.hostOnly ? '' : '.') + c.domain + '|' + c.path;
}

export function makeStore() {
  // insertion-ordered Map = creation order for the RFC sort tiebreak
  const cookies = new Map();

  function prune() {
    const now = Date.now();
    for (const [k, c] of cookies) {
      if (c.expiresTs !== null && c.expiresTs <= now) cookies.delete(k);
    }
  }

  return {
    set(record) {
      if (!record) return;
      cookies.delete(keyOf(record)); // re-insert → newest creation time wins
      cookies.set(keyOf(record), record);
      // Soft caps, like a browser would enforce
      if (cookies.size > 5000) {
        const oldest = cookies.keys().next().value;
        cookies.delete(oldest);
      }
    },
    get count() {
      prune();
      return cookies.size;
    },
    /** Cookie header value to send to this URL (already RFC-sorted). */
    forUrl(url) {
      prune();
      let u;
      try { u = url instanceof URL ? url : new URL(url); } catch { return ''; }
      const host = u.hostname.toLowerCase();
      const isSecure = u.protocol === 'https:';
      const list = [];
      for (const c of cookies.values()) {
        if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
        if (!pathMatch(u.pathname, c.path)) continue;
        if (c.secure && !isSecure) continue;
        list.push(c);
      }
      list.sort((a, b) => b.path.length - a.path.length); // longer paths first
      return list.map((c) => c.name + '=' + c.value).join('; ');
    },
    /** Cookies visible to page JS (document.cookie) for this URL. */
    forUrlVisible(url) {
      return this.forUrl(url)
        .split('; ')
        .filter((pair) => {
          const name = pair.slice(0, pair.indexOf('='));
          const c = this._find(url, name);
          return c && !c.httpOnly;
        })
        .join('; ');
    },
    _find(url, name) {
      let u;
      try { u = url instanceof URL ? url : new URL(url); } catch { return null; }
      prune();
      for (const c of cookies.values()) {
        if (c.name !== name) continue;
        const host = u.hostname.toLowerCase();
        if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
        if (!pathMatch(u.pathname, c.path)) continue;
        return c;
      }
      return null;
    },
    /** Add a plain 'name=value' pair (set by page JS via document.cookie). */
    setFromPage(origin, name, value) {
      try {
        const u = new URL(origin);
        this.set(parseSetCookie(name + '=' + value, u.origin + '/'));
      } catch {}
    },
    toJSON() {
      prune();
      return [...cookies.values()];
    },
    load(list) {
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (c && c.name && c.domain && typeof c.value === 'string') {
          cookies.set(keyOf(c), c);
        }
      }
      prune();
    },
    clear() {
      cookies.clear();
    },
  };
}
