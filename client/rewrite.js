// HTMLTools Browser — HTML/CSS URL rewriter.
// Pure string functions (no DOM) so they run in the service worker AND in
// Node for testing. Regex-based on purpose: fast, zero dependencies.
// Roadmap: streaming rewriter so huge pages never buffer fully.

const SKIP_RE = /^(#|data:|blob:|about:|mailto:|tel:|sms:|javascript:|file:|cid:|intent:|ws:|wss:|ftp:)/i;

/** Resolve any href/src-ish value against the page URL and encode it, or
 *  return it untouched when it's not proxiable. */
function proxify(value, base, encode) {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  if (!v || SKIP_RE.test(v)) return value;
  try {
    const abs = new URL(v, base);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return value;
    return encode(abs.href);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, base, encode) {
  return value
    .split(',')
    .map((part) => {
      const t = part.trim();
      if (!t) return part;
      const m = t.match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;
      return proxify(m[1], base, encode) + (m[2] || '');
    })
    .join(', ');
}

const ATTRS =
  'href|src|action|formaction|poster|background|cite|longdesc|data-src|data-href|data-url|data-poster';

/** Rewrite every proxiable URL inside an HTML document. */
export function rewriteHtml(html, baseUrl, encode) {
  // Honor <base href> if the page declares one.
  let base = baseUrl;
  const baseTag = html.match(/<base\s[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (baseTag) {
    try {
      base = new URL(baseTag[1], baseUrl).href;
    } catch {}
  }

  // 1. Standard URL attributes (double + single + unquoted values).
  const attrRe = new RegExp(
    `(\\s(href|src|action|formaction|poster|background|cite|longdesc|data-src|data-href|data-url|data-poster|srcset|imagesrcset)\\s*=\\s*)("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'gi'
  );
  html = html.replace(attrRe, (m, eq, name, _q, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : uq;
    const done = /srcset/i.test(name) ? rewriteSrcset(raw, base, encode) : proxify(raw, base, encode);
    return eq + '"' + String(done ?? '').replace(/"/g, '&quot;') + '"';
  });

  // 2. Inline style="..." attributes.
  html = html.replace(/(\sstyle\s*=\s*")([^"]*)(")/gi, (m, a, css, z) =>
    a + rewriteCss(css, base, encode) + z
  );

  // 3. <style> blocks.
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) =>
    open + rewriteCss(css, base, encode) + close
  );

  // 4. <meta http-equiv="refresh" content="5; url=...">
  html = html.replace(
    /(<meta\s[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*?content\s*=\s*["']?)([^"'>]+)/gi,
    (m, pre, content) => {
      const out = content.replace(/(url\s*=\s*)(\S+)/i, (mm, u, target) => {
        const t = target.replace(/^['"]|['"]$/g, '');
        return u + proxify(t, base, encode);
      });
      return pre + out;
    }
  );

  return html;
}

/** Rewrite url(...) and @import inside CSS. */
export function rewriteCss(css, base, encode) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const done = proxify(u, base, encode);
      return `url("${String(done).replace(/"/g, '%22')}")`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      return `@import "${String(proxify(u, base, encode)).replace(/"/g, '%22')}"`;
    });
}
