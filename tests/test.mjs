// HTMLTools Browser — engine unit tests. Run: node tests/test.mjs
import { encodeUrl, decodeUrl } from '../client/encoder.js';
import { rewriteHtml, rewriteCss } from '../client/rewrite.js';
import { makeStore, parseSetCookie, domainMatch, pathMatch, defaultPath } from '../client/cookiestore.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  if (Object.is(actual, expected)) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.error('FAIL  ' + label + '\n   got: ' + JSON.stringify(actual) + '\n   exp: ' + JSON.stringify(expected)); }
}
function ok(cond, label) { eq(!!cond, true, label); }

console.log('\n─ encoder ─');
const round1 = encodeUrl('https://example.com/page?x=1&y=hi#frag', '/');
eq(decodeUrl(round1), 'https://example.com/page?x=1&y=hi#frag', 'roundtrip with query + hash');
const round2 = encodeUrl('https://例え.テスト/パス?q=日本語', '/browser/');
ok(round2.startsWith('/browser/~/'), 'prefix respected (/browser/)');
eq(decodeUrl(round2), 'https://例え.テスト/パス?q=日本語', 'unicode roundtrip through prefixed path');
eq(decodeUrl('/about'), null, 'non-proxied path → null');
eq(decodeUrl('/browser/~/' + round1.split('/~/')[1]), 'https://example.com/page?x=1&y=hi#frag', 'decode tolerates foreign prefix');

console.log('\n─ html rewriting ─');
const enc = (u) => encodeUrl(u, '/');
const page = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/main.css">
<style>body { background: url(img/bg.png); } @import "more.css";</style>
</head><body>
<a href="https://google.com/search?q=test">abs</a>
<a href="/relative/page">rel</a>
<a href="#section">hash</a>
<a href="javascript:void(0)">js</a>
<img src="/i/hero.png" srcset="/i/a.png 1x, /i/b.png 2x">
<iframe src="https://frames.example/embed"></iframe>
<meta http-equiv="refresh" content="5; url=/next">
<div style="background-image: url('/x.png')">styled</div>
<script>var keep = "href='/not/this'";</script>
</body></html>`;
const out = rewriteHtml(page, 'https://target.example/deep/page.html', enc);

ok(out.includes('href="' + enc('https://target.example/css/main.css') + '"'), 'relative <link> resolved against page URL');
ok(out.includes('url("' + enc('https://target.example/deep/img/bg.png') + '")'), '<style> url() rewritten');
ok(out.includes('@import "' + enc('https://target.example/deep/more.css') + '"'), '@import rewritten');
ok(out.includes('href="' + enc('https://google.com/search?q=test') + '"'), 'absolute link rewritten');
ok(out.includes('href="' + enc('https://target.example/relative/page') + '"'), 'root-relative link rewritten');
ok(out.includes('href="#section"'), '#fragment untouched');
ok(out.includes('href="javascript:void(0)"'), 'javascript: untouched');
ok(out.includes('src="' + enc('https://target.example/i/hero.png') + '"'), '<img src> rewritten');
ok(out.includes(enc('https://target.example/i/a.png') + ' 1x'), 'srcset item 1 rewritten');
ok(out.includes(enc('https://target.example/i/b.png') + ' 2x'), 'srcset item 2 rewritten');
ok(out.includes('src="' + enc('https://frames.example/embed') + '"'), '<iframe src> rewritten');
ok(out.includes('url=' + enc('https://target.example/next')), 'meta refresh rewritten');
ok(out.includes('url(\'' + enc('https://target.example/x.png') + '\')') || out.includes(`url("${enc('https://target.example/x.png')}"`) || out.includes(enc('https://target.example/x.png')), 'inline style url() rewritten');
ok(out.includes("href='/not/this'"), 'script contents untouched');
ok(/<head[^>]*>/.test(out), '<head> preserved for runtime injection');

console.log('\n─ css rewriting ─');
const css = `@font-face { src: url(https://fonts.example/f.woff2) format('woff2'); }
.a { background: url("/abs.png"); }
.b { background: url( rel.png ); }`;
const cssOut = rewriteCss(css, 'https://target.example/dir/page.html', enc);
ok(cssOut.includes('url("' + enc('https://fonts.example/f.woff2') + '")'), 'absolute url() rewritten');
ok(cssOut.includes('url("' + enc('https://target.example/abs.png') + '")'), 'root-relative url() rewritten');
ok(cssOut.includes('url("' + enc('https://target.example/dir/rel.png') + '")'), 'relative url() rewritten');


console.log('\n\u2500 cookie store (v1.1) \u2500');
{
  const base = 'https://accounts.example.com/login';

  const c1 = parseSetCookie('session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax', base);
  ok(c1 && c1.name === 'session' && c1.value === 'abc123', 'basic parse');
  ok(c1 && c1.httpOnly === true && c1.secure === true, 'HttpOnly + Secure parsed');

  const c2 = parseSetCookie('prefs=dark; Domain=example.com; Max-Age=3600', base);
  ok(c2 && c2.hostOnly === false && c2.domain === 'example.com', 'Domain attr makes it a domain cookie');
  ok(c2 && c2.expiresTs !== null && c2.expiresTs > Date.now(), 'Max-Age sets expiry');

  const c3 = parseSetCookie('x=1; Domain=other.com', base);
  eq(c3, null, 'cookie for wrong domain rejected');

  const c4 = parseSetCookie('x=1; Secure', 'http://example.com/');
  eq(c4, null, 'Secure cookie rejected over http');

  ok(domainMatch('a.b.example.com', 'example.com'), 'domain suffix match');
  ok(!domainMatch('example.com', 'a.example.com'), 'parent does not match subdomain cookie');
  ok(!domainMatch('notexample.com', 'example.com'), 'suffix must be dot-bounded');
  ok(pathMatch('/a/b/c', '/a'), 'path prefix match');
  ok(!pathMatch('/abc', '/a'), 'path must be segment-bounded');
  eq(defaultPath('/a/b/c.html'), '/a/b', 'default path = directory');

  const s = makeStore();
  s.set(parseSetCookie('a=1; Path=/', 'https://example.com/x/y'));
  s.set(parseSetCookie('b=2; Path=/x', 'https://example.com/x/y'));
  s.set(parseSetCookie('pub=3; Domain=example.com', 'https://example.com/'));
  s.set(parseSetCookie('secret=9; Path=/; HttpOnly', 'https://example.com/'));
  eq(s.forUrl('https://example.com/x/y'), 'b=2; a=1; pub=3; secret=9', 'longer paths first, all included in header');
  const visible = s.forUrlVisible('https://example.com/x/y');
  ok(visible.includes('a=1') && !visible.includes('secret=9'), 'HttpOnly hidden from document.cookie');

  s.set(parseSetCookie('gone=1; Max-Age=0', 'https://example.com/'));
  eq(s.forUrl('https://example.com/').includes('gone=1'), false, 'Max-Age=0 deletes');

  const expired = parseSetCookie('old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://example.com/');
  ok(expired && expired.expiresTs === 0, 'past Expires \u2192 expired');

  s.set(parseSetCookie('sess=ok', 'https://example.com/deep/path'));
  eq(s.forUrl('https://example.com/other').includes('sess=ok'), false, 'default-path cookie scoped to /deep');
  ok(s.forUrl('https://example.com/deep/anything').includes('sess=ok'), 'default-path cookie matches its subtree');

  s.set(parseSetCookie('sub=1; Domain=example.com', 'https://example.com/'));
  ok(s.forUrl('https://api.example.com/v1').includes('sub=1'), 'domain cookie reaches subdomains');

  const secStore = makeStore();
  secStore.set(parseSetCookie('s=1; Secure', 'https://example.com/'));
  eq(secStore.forUrl('http://example.com/'), '', 'Secure cookie not sent over http');
  ok(secStore.forUrl('https://example.com/').includes('s=1'), 'Secure cookie sent over https');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
