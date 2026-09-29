// HTMLTools Browser — engine unit tests. Run: node tests/test.mjs
import { encodeUrl, decodeUrl } from '../client/encoder.js';
import { rewriteHtml, rewriteCss } from '../client/rewrite.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
