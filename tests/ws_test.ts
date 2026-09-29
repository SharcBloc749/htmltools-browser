// HTMLTools Browser — WebSocket relay end-to-end test.
// Run: deno run -A tests/ws_test.ts
//
// Starts (1) a local echo WebSocket server, (2) the real proxy backend,
// then pushes a text frame AND a binary frame through /proxyws and checks
// both come back intact.

import { handler } from '../server/main.ts';

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let pass = 0, fail = 0;
const check = (cond: boolean, label: string) => {
  if (cond) { pass++; console.log('  ok  ' + label); } else { fail++; console.error('FAIL  ' + label); }
};

const timer = setTimeout(() => {
  console.error('TIMEOUT — relay did not finish in 15s');
  Deno.exit(1);
}, 15_000);

// 1. echo server (fire and forget — do NOT await .finished)
const ECHO_PORT = 8791;
Deno.serve({ port: ECHO_PORT }, (req) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('no', { status: 404 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onmessage = (e) => socket.send(e.data);
  return response;
});

// 2. proxy backend (fire and forget)
const PROXY_PORT = 8792;
Deno.serve({ port: PROXY_PORT }, handler);

// 3. client through the relay
const target = `ws://127.0.0.1:${ECHO_PORT}/`;
const hd = b64url(JSON.stringify({ cookie: 'sid=test42', origin: 'https://chat.example.com' }));
const ws = new WebSocket(
  `ws://127.0.0.1:${PROXY_PORT}/proxyws?u=${encodeURIComponent(target)}&hd=${encodeURIComponent(hd)}`
);
ws.binaryType = 'arraybuffer';

const opened = new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error('relay open failed'));
});
await opened;
check(true, 'relay connection opened');

// text frame
const textBack = new Promise<string>((res) => {
  ws.onmessage = (e) => { if (typeof e.data === 'string') res(e.data); };
});
ws.send('hello-through-proxy');
check((await textBack) === 'hello-through-proxy', 'text frame round-trips');

// binary frame
const binBack = new Promise<ArrayBuffer>((res) => {
  ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) res(e.data); };
});
const payload = new Uint8Array([1, 2, 3, 250, 251]).buffer;
ws.send(payload);
const got = new Uint8Array(await binBack);
check(got.length === 5 && got[4] === 251, 'binary frame round-trips');

// binary payload stays binary (not stringified)
check(typeof (await textBack) === 'string', 'text/binary distinction preserved');

ws.close(1000, 'done');
await new Promise((r) => setTimeout(r, 150));

clearTimeout(timer);
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
