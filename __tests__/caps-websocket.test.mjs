import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkControl, OFFLINE_REASON } from '../lib/caps/net.mjs';

// Node 22 lacks this browser API; keep the shim inside this test's realm.
const nativeCloseEvent = globalThis.CloseEvent;
test.before(() => {
  globalThis.CloseEvent ??= class CloseEvent extends Event {
    constructor(type, { code = 0, reason = '', wasClean = false, ...init } = {}) {
      super(type, init);
      Object.assign(this, { code, reason, wasClean });
    }
  };
});
test.after(() => { if (!nativeCloseEvent) delete globalThis.CloseEvent; });

class Socket extends EventTarget {
  static instances = [];
  constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.sent = []; Socket.instances.push(this); }
  send(data) { this.sent.push(data); }
  open() { this.dispatchEvent(new Event('open')); }
  close(code = 1000, reason = '') { this.dispatchEvent(new CloseEvent('close', { code, reason })); }
}
const control = (extra = {}) => createNetworkControl({ externalOrigin: 'http://localhost:8788', ...extra });
const tick = () => new Promise((r) => setTimeout(r, 5));

test('WS is blocked before creating a real socket; errors and close reach Ink', async () => {
  const n = Socket.instances.length;
  const net = control(); const WS = net.wrapWebSocket(Socket);
  const socket = new WS('wss://example.com/room');
  const events = [];
  socket.onerror = () => events.push('error');
  socket.onclose = (e) => events.push(e.code);
  await tick();
  assert.deepEqual(events, ['error', 1006]);
  assert.equal(socket.readyState, WS.CLOSED);
  assert.equal(Socket.instances.length, n);
  assert.equal(net.requests[0].decision, 'block');
});
test('fetch and WS share allow rules; WS logs connections and message counts without bodies', async () => {
  const net = control({ allowExternal: ['*://example.com/*'] });
  const WS = net.wrapWebSocket(Socket); const socket = new WS('wss://example.com/room', ['test']);
  const native = Socket.instances.at(-1);
  native.open();
  assert.equal(socket.readyState, WS.OPEN);
  assert.deepEqual(native.protocols, ['test']);
  socket.binaryType = 'arraybuffer'; assert.equal(native.binaryType, 'arraybuffer');
  socket.send('private outbound');
  let data; socket.addEventListener('message', (e) => { data = e.data; });
  native.dispatchEvent(new MessageEvent('message', { data: 'private inbound' }));
  assert.equal(data, 'private inbound');
  const response = await net.wrapFetch(async () => new Response('ok'))('https://example.com/a');
  assert.equal(response.status, 200);
  assert.equal(net.requests.find((r) => r.layer === 'fetch').allowPattern, '*://example.com/*');
  socket.close();
  const close = net.requests.find((r) => r.layer === 'ws' && r.decision === 'close');
  assert.equal(close.sent, 1); assert.equal(close.received, 1);
  assert.ok(!net.toJSON().includes('private'));
});
test('offline closes live WS immediately, blocks reconnect, and online allows a fresh connection', async () => {
  const net = control({ allowExternal: ['example.com'] });
  const WS = net.wrapWebSocket(Socket); const socket = new WS('wss://example.com/room');
  Socket.instances.at(-1).open();
  let closed; socket.onclose = (e) => { closed = e.reason; };
  net.offline();
  assert.equal(socket.readyState, WS.CLOSED); assert.match(closed, /InkLab/);
  const n = Socket.instances.length;
  const retry = new WS('wss://example.com/room');
  await tick();
  assert.equal(retry.readyState, WS.CLOSED); assert.equal(Socket.instances.length, n);
  assert.equal(net.requests.find((r) => r.decision === 'block').reason, OFFLINE_REASON);
  net.online(); const next = new WS('wss://example.com/room');
  Socket.instances.at(-1).open();
  assert.equal(next.readyState, WS.OPEN);
  assert.equal(net.networkState().ws.length, 1);
  net.dispose(); assert.equal(net.networkState().ws.length, 0);
});
test('explicit block overrides allow and independent player networks do not cross', async () => {
  const a = control({ allowExternal: ['example.com'] }); const b = control({ allowExternal: ['example.com'] });
  const A = a.wrapWebSocket(Socket); const B = b.wrapWebSocket(Socket);
  const one = new A('wss://example.com/room'); Socket.instances.at(-1).open();
  const two = new B('wss://example.com/room'); Socket.instances.at(-1).open();
  a.offline(); assert.equal(one.readyState, A.CLOSED); assert.equal(two.readyState, B.OPEN);
  b.block('/room'); const denied = new B('wss://example.com/room'); await tick();
  assert.equal(denied.readyState, B.CLOSED);
  b.dispose();
});
test('download progress counts streamed bytes and binary logging does not clone entire audio', async () => {
  const net = control({ allowExternal: ['example.com'] });
  let source;
  const body = new ReadableStream({ start(c) { source = c; } });
  const original = new Response(body, { headers: { 'content-type': 'audio/mpeg', 'content-length': '6' } });
  Object.defineProperty(original, 'url', { value: 'https://example.com/song.mp3' });
  const response = await net.wrapFetch(async () => original)('https://example.com/song.mp3');
  assert.equal(response.url, original.url);
  assert.equal(response.clone().url, original.url);
  source.enqueue(new Uint8Array([1, 2, 3]));
  const reader = response.body.getReader(); await reader.read();
  assert.equal(net.networkState().downloads[0].received, 3);
  source.enqueue(new Uint8Array([4, 5, 6])); source.close();
  await reader.read(); await reader.read();
  assert.equal(net.networkState().downloads.length, 0);
  assert.equal(net.requests.find((r) => r.layer === 'download').received, 6);
});
