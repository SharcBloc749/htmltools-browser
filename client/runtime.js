// ─────────────────────────────────────────────────────────────────────────
// HTMLTools Browser — page runtime (injected into every proxied page). v1.1
//
// Teaches proxied pages our URL scheme and makes them behave like they run
// on their real origin, the way a real browser would:
//   fetch / XHR / WebSocket / EventSource / sendBeacon / Worker /
//   window.open / links / forms / history / dynamic DOM
//   document.cookie (per real origin, HttpOnly-aware)
//   localStorage + sessionStorage (per real origin, namespaced)
//
// __HT_KEY__ / __HT_PREFIX__ / __HT_BACKEND__ are replaced by the service
// worker at install time, so this always matches the engine.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  if (window.__htmltools) return;
  window.__htmltools = true;

  var KEY = '__HT_KEY__';
  var PREFIX = '__HT_PREFIX__';
  var BACKEND = '__HT_BACKEND__';
  var WS_BACKEND = BACKEND.replace(/^http/i, 'ws');

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
  function unb64url(s) {
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return atob(b);
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

  // Boot: pull upstream Set-Cookie the SW saved (non-HttpOnly only) → jar.
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

  // ── 7. localStorage / sessionStorage emulation (per real origin) ───────
  // All proxied sites share the real htmltools.me storage, so every key is
  // namespaced with the site's origin. Pages see clean per-site storage.
  (function () {
    var nativeLS = window.localStorage;
    var nativeSS = window.sessionStorage;
    var NS = '__ht__' + b64url(realOrigin) + '__';

    function NsStore(native) {
      this._n = native;
    }
    NsStore.prototype = {
      _keys: function () {
        var out = [], n = this._n;
        for (var i = 0; i < n.length; i++) {
          var k = n.key(i);
          if (k && k.indexOf(NS) === 0) out.push(k.slice(NS.length));
        }
        return out;
      },
      getItem: function (k) { return this._n.getItem(NS + String(k)); },
      setItem: function (k, v) { this._n.setItem(NS + String(k), String(v)); },
      removeItem: function (k) { this._n.removeItem(NS + String(k)); },
      key: function (i) { return this._keys()[i] || null; },
      clear: function () {
        var n = this._n;
        this._keys().forEach(function (k) { n.removeItem(NS + k); });
      },
    };
    Object.defineProperty(NsStore.prototype, 'length', {
      get: function () { return this._keys().length; },
    });

    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: function () { return lsShim; },
      });
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: function () { return ssShim; },
      });
    } catch (e) {}
    var lsShim = new NsStore(nativeLS);
    var ssShim = new NsStore(nativeSS);
  })();

  // ── 8. WebSocket proxying ──────────────────────────────────────────────
  // Connects to OUR backend over wss; the backend dials the real ws://
  // server and pipes frames both ways, preserving text/binary.
  var _WS = window.WebSocket;
  function resolveWs(u) {
    var s = String(u || '');
    var abs;
    try {
      if (/^wss?:/i.test(s)) {
        abs = s;
      } else if (s.indexOf('//') === 0) {
        abs = (location.protocol === 'https:' ? 'wss:' : 'ws:') + s;
      } else {
        abs = new URL(s, REAL_URL).href;
        abs = abs.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
      }
    } catch (e) {
      abs = s;
    }
    return abs;
  }

  function HTWebSocket(url, protocols) {
    if (!(this instanceof HTWebSocket)) {
      throw new TypeError("Failed to construct 'WebSocket': use 'new'.");
    }
    var self = this;
    var abs = resolveWs(url);
    this._url = abs;
    this._binaryType = 'blob';
    this._ls = { open: [], message: [], error: [], close: [] };

    var handshake = b64url(JSON.stringify({
      cookie: jarGet(),
      origin: realOrigin,
      protocol: protocols || null,
    }));
    var wire = WS_BACKEND + '/proxyws?u=' + encodeURIComponent(abs) + '&hd=' + encodeURIComponent(handshake);
    // Protocols travel inside hd; none on the real handshake so the browser
    // never expects a Sec-WebSocket-Protocol echo.
    var real = new _WS(wire);
    this._real = real;

    real.addEventListener('open', function () { self._fire('open', new Event('open')); });
    real.addEventListener('error', function () { self._fire('error', new Event('error')); });
    real.addEventListener('close', function (e) {
      self._fire('close', new CloseEvent('close', { code: e.code, reason: e.reason, wasClean: e.wasClean }));
    });
    real.addEventListener('message', function (e) {
      var data = e.data;
      if (data instanceof Blob && self._binaryType === 'arraybuffer') {
        data.arrayBuffer().then(function (buf) {
          self._fire('message', new MessageEvent('message', { data: buf }));
        });
      } else {
        self._fire('message', new MessageEvent('message', { data: data }));
      }
    });
  }
  HTWebSocket.prototype._fire = function (type, event) {
    event.target = this;
    var list = this._ls[type].slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(this, event); } catch (e) {}
    }
    var h = this['on' + type];
    if (typeof h === 'function') {
      try { h.call(this, event); } catch (e) {}
    }
  };
  HTWebSocket.prototype.addEventListener = function (t, fn, opts) {
    if (this._ls[t]) this._ls[t].push(fn);
  };
  HTWebSocket.prototype.removeEventListener = function (t, fn) {
    var l = this._ls[t];
    if (!l) return;
    var i = l.indexOf(fn);
    if (i !== -1) l.splice(i, 1);
  };
  HTWebSocket.prototype.send = function (data) { return this._real.send(data); };
  HTWebSocket.prototype.close = function (code, reason) { this._real.close(code, reason); };
  Object.defineProperty(HTWebSocket.prototype, 'url', { get: function () { return this._url; } });
  Object.defineProperty(HTWebSocket.prototype, 'readyState', {
    get: function () { return this._real.readyState; },
  });
  Object.defineProperty(HTWebSocket.prototype, 'bufferedAmount', {
    get: function () { return this._real.bufferedAmount; },
  });
  Object.defineProperty(HTWebSocket.prototype, 'extensions', {
    get: function () { return this._real.extensions; },
  });
  Object.defineProperty(HTWebSocket.prototype, 'protocol', {
    get: function () { return this._real.protocol; },
  });
  Object.defineProperty(HTWebSocket.prototype, 'binaryType', {
    get: function () { return this._binaryType; },
    set: function (v) {
      this._binaryType = v === 'arraybuffer' ? 'arraybuffer' : 'blob';
      this._real.binaryType = 'blob';
    },
  });
  HTWebSocket.CONNECTING = 0;
  HTWebSocket.OPEN = 1;
  HTWebSocket.CLOSING = 2;
  HTWebSocket.CLOSED = 3;
  try { window.WebSocket = HTWebSocket; } catch (e) {}

  // ── 9. EventSource / sendBeacon / Workers ──────────────────────────────
  var _ES = window.EventSource;
  if (_ES) {
    var HTES = function (url, cfg) { return new _ES(px(url), cfg); };
    HTES.prototype = _ES.prototype;
    ['CONNECTING', 'OPEN', 'CLOSED'].forEach(function (k) { HTES[k] = _ES[k]; });
    try { window.EventSource = HTES; } catch (e) {}
  }

  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      try {
        _fetch(px(url), { method: 'POST', body: data, keepalive: true });
        return true;
      } catch (e) {
        return false;
      }
    };
  }

  var _Worker = window.Worker;
  if (_Worker) {
    var HTWorker = function (url, opts) {
      try { url = px(url); } catch (e) {}
      return new _Worker(url, opts);
    };
    HTWorker.prototype = _Worker.prototype;
    try { window.Worker = HTWorker; } catch (e) {}
  }
  var _SWC = window.SharedWorker;
  if (_SWC) {
    var HTSW = function (url, opts) {
      try { url = px(url); } catch (e) {}
      return new _SWC(url, opts);
    };
    HTSW.prototype = _SWC.prototype;
    try { window.SharedWorker = HTSW; } catch (e) {}
  }

  // ── 10. dynamic DOM: rewrite nodes the page adds later ─────────────────
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
