// ─────────────────────────────────────────────────────────────────────────
// HTMLTools Browser — page runtime (injected into every proxied page).
//
// Runs INSIDE the proxied page and teaches it our URL scheme:
//   fetch / XHR / window.open / links / forms / history / dynamic DOM.
// Also emulates document.cookie per real origin.
//
// __HT_KEY__ and __HT_PREFIX__ are replaced by the service worker at
// install time with the real values, so this always matches the engine.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  if (window.__htmltools) return;
  window.__htmltools = true;

  var KEY = '__HT_KEY__';
  var PREFIX = '__HT_PREFIX__';

  // The real URL of this page (injected just before this script loads).
  var REAL_URL =
    (document.currentScript && document.currentScript.getAttribute('data-real-url')) ||
    window.__HT_REAL_URL__ ||
    ('https://' + location.hostname + '/');

  function xorStr(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      out += String.fromCharCode(s.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length));
    }
    return out;
  }
  function b64url(s) {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function toProxy(abs) {
    if (!/^https?:/i.test(abs)) return abs;
    return PREFIX + '~/' + b64url(xorStr(encodeURIComponent(abs)));
  }
  function resolve(u) {
    try {
      return new URL(String(u), REAL_URL).href;
    } catch (e) {
      return String(u);
    }
  }
  var SKIP = /^(#|data:|blob:|about:|mailto:|tel:|sms:|javascript:)/i;
  // value → proxied value (only if it can be a real http(s) URL)
  function px(u) {
    var v = String(u);
    if (!v || SKIP.test(v.trim())) return u;
    var abs = resolve(v);
    return toProxy(abs);
  }

  var realOrigin;
  try { realOrigin = new URL(REAL_URL).origin; } catch (e) { realOrigin = 'https://example.com'; }

  // ── 1. fetch ───────────────────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) input = px(String(input));
      else if (input && input.url) input = new Request(px(input.url), input);
    } catch (e) {}
    return _fetch.call(this, input, init);
  };

  // ── 2. XMLHttpRequest ──────────────────────────────────────────────────
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return _open.apply(this, [method, px(url)].concat(rest));
  };

  // ── 3. window.open ─────────────────────────────────────────────────────
  var _wopen = window.open;
  window.open = function (u, name, feats) {
    try { if (u != null) u = toProxy(resolve(u)); } catch (e) {}
    return _wopen.call(this, u, name, feats);
  };

  // ── 4. history API ─────────────────────────────────────────────────────
  try {
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function (s, t, u) {
      return _push.call(history, s, t, u == null ? u : toProxy(resolve(u)));
    };
    history.replaceState = function (s, t, u) {
      return _replace.call(history, s, t, u == null ? u : toProxy(resolve(u)));
    };
  } catch (e) {}

  // ── 5. links + forms (capture phase, before the page can react) ────────
  document.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
      var abs = resolve(href);
      if (!/^https?:/i.test(abs)) return;
      e.preventDefault();
      if (a.target === '_blank' || e.metaKey || e.ctrlKey || e.button === 1) {
        _wopen.call(window, toProxy(abs), '_blank');
      } else {
        location.href = toProxy(abs);
      }
    },
    true
  );
  document.addEventListener(
    'submit',
    function (e) {
      var f = e.target;
      if (!f || !f.getAttribute) return;
      var action = f.getAttribute('action');
      var abs = resolve(action || REAL_URL);
      if (/^https?:/i.test(abs)) f.setAttribute('action', toProxy(abs));
    },
    true
  );

  // ── 6. document.cookie emulation (per real origin) ─────────────────────
  var JAR_KEY = 'ht-jar:' + realOrigin;
  function jarGet() {
    try { return sessionStorage.getItem(JAR_KEY) || ''; } catch (e) { return ''; }
  }
  function jarSet(s) {
    try { sessionStorage.setItem(JAR_KEY, s); } catch (e) {}
    pushCookies(s);
  }
  function jarMap(str) {
    var m = {}, parts = (str || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], idx = p.indexOf('=');
      if (idx > 0) m[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    }
    return m;
  }
  function jarString(m) {
    var out = [];
    for (var k in m) out.push(k + '=' + m[k]);
    return out.join('; ');
  }
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () { return jarGet(); },
      set: function (v) {
        v = String(v);
        var eq = v.indexOf('=');
        if (eq < 1) return;
        var name = v.slice(0, eq).trim();
        var value = v.slice(eq + 1).split(';')[0];
        var expired = /expires=thu, 01 jan 1970|max-age=0/i.test(v) || value === '';
        var m = jarMap(jarGet());
        if (expired) delete m[name]; else m[name] = value;
        jarSet(jarString(m));
      },
    });
  } catch (e) {}

  function pushCookies(cookie) {
    try {
      _fetch(PREFIX + '~/__ht/cookies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: realOrigin, cookie: cookie }),
      });
    } catch (e) {}
  }

  // Boot: pull any upstream Set-Cookie the SW saved for us, merge into jar.
  (function syncCookies() {
    _fetch(PREFIX + '~/__ht/sync?o=' + encodeURIComponent(realOrigin))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.setCookie || !data.setCookie.length) return;
        var m = jarMap(jarGet());
        for (var i = 0; i < data.setCookie.length; i++) {
          var first = String(data.setCookie[i]).split(';')[0];
          var eq = first.indexOf('=');
          if (eq > 0) m[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
        }
        var s = jarString(m);
        try { sessionStorage.setItem(JAR_KEY, s); } catch (e) {}
      })
      .catch(function () {});
  })();

  // ── 7. dynamic DOM: rewrite nodes the page adds later ──────────────────
  var obs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (!n || n.nodeType !== 1) continue;
        try {
          if (n.src && typeof n.src === 'string' && n.src.indexOf(PREFIX + '~/') !== 0) {
            var abs = resolve(n.src);
            if (/^https?:/i.test(abs) && abs.indexOf(location.origin + PREFIX) !== 0) n.src = toProxy(abs);
          }
          if (n.href && (n.tagName === 'LINK' || n.tagName === 'A') &&
              typeof n.href === 'string' && n.href.indexOf(PREFIX + '~/') !== 0) {
            var abs2 = resolve(n.getAttribute('href') || '');
            if (/^https?:/i.test(abs2)) n.setAttribute('href', toProxy(abs2));
          }
          if (n.tagName === 'IFRAME' && n.getAttribute('src')) {
            var abs3 = resolve(n.getAttribute('src'));
            if (/^https?:/i.test(abs3)) n.setAttribute('src', toProxy(abs3));
          }
        } catch (e) {}
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
