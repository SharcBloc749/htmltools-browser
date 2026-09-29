// HTMLTools Browser — URL codec.
// A proxied URL looks like:  <prefix>~/<base64url(xor-scrambled URL)>
// Example (site root):       /~/aHR0cHM6...  (well, scrambled, not plain b64)
// The XOR keeps the encoding compact and hides the destination from casual
// URL inspection. The service worker decodes it before calling the backend.
import { KEY } from './config.js';

function xorStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(s.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length));
  }
  return out;
}

export function b64urlEncode(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return atob(b);
}

/**
 * Encode an absolute http(s) URL into a proxied path.
 * @param {string} url    absolute URL, e.g. https://example.com/page
 * @param {string} prefix base path of the app, e.g. '/' or '/browser/'
 */
export function encodeUrl(url, prefix = '/') {
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  return p + '~/' + b64urlEncode(xorStr(encodeURIComponent(url)));
}

/**
 * Decode a proxied path back into the target URL.
 * Tolerates any prefix; returns null for non-proxied paths.
 */
export function decodeUrl(part) {
  const i = part.indexOf('~/');
  if (i === -1) return null;
  let tail = part.slice(i + 2);
  if (!tail) return null;
  try {
    return decodeURIComponent(xorStr(b64urlDecode(tail)));
  } catch {
    return null;
  }
}
