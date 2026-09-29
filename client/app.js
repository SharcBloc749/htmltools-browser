// HTMLTools Browser — launcher UI logic. Deliberately tiny.
import { BACKEND, SEARCH } from './config.js';
import { encodeUrl, decodeUrl } from './encoder.js';

const $ = (s) => document.querySelector(s);
const frame = $('#frame');
const bar = $('#url');
const statusEl = $('#status');
const BASE = new URL('./', location.href).pathname;

const enc = (u) => encodeUrl(u, BASE);
const dec = (p) => decodeUrl(p);

function banner(msg, isErr = true) {
  statusEl.textContent = msg;
  statusEl.style.color = isErr ? '#ff7b72' : '#7ee787';
}

function normalize(input) {
  let v = input.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  // looks like a domain? else search
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) || /^localhost(:\d+)?/.test(v)) return 'https://' + v;
  return SEARCH + encodeURIComponent(v);
}

async function init() {
  if (!('serviceWorker' in navigator)) {
    banner('This browser has no service worker support — the engine can\u2019t run here.');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { type: 'module' });
    // Allow runtime backend override (set in console: localStorage.htBackend=URL)
    const override = localStorage.getItem('ht-backend') || BACKEND;
    const send = () => reg.active && reg.active.postMessage({ type: 'backend', url: override });
    if (reg.active) send();
    navigator.serviceWorker.addEventListener('controllerchange', send);
    send();
    banner('Engine ready \u2014 type a URL and hit Enter.', false);
  } catch (e) {
    banner('Service worker failed to register: ' + e.message);
    return;
  }
  wire();
}

function navigate(value) {
  const target = normalize(value);
  if (!target) return;
  frame.src = enc(target);
}

function wire() {
  $('#go').addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(bar.value);
  });
  $('#back').addEventListener('click', () => frame.contentWindow && frame.contentWindow.history.back());
  $('#fwd').addEventListener('click', () => frame.contentWindow && frame.contentWindow.history.forward());
  $('#reload').addEventListener('click', () => {
    try { frame.contentWindow.location.reload(); } catch { frame.src = frame.src; }
  });
  $('#home').addEventListener('click', () => { frame.src = 'about:blank'; bar.value = ''; });

  frame.addEventListener('load', () => {
    try {
      const path = frame.contentWindow.location.pathname;
      const real = dec(path);
      if (real) bar.value = real;
    } catch {}
  });

  const q = new URLSearchParams(location.search).get('q');
  if (q) { bar.value = q; navigate(q); }
}

init();
