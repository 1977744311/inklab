// ws-lite.mjs — 最小的服务端 WebSocket（RFC 6455 文本帧 + ping/pong + close），不依赖第三方包。
// 只给真机「模拟 IMU」实时通道用：一条连接、消息几 KB，不需要扩展、压缩、二进制。

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

function frame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  return Buffer.concat([head, payload]);
}

/**
 * 接一个 upgrade 请求。返回的连接对象上挂 onMessage(text) / onClose() 回调，调 send(text) / close()。
 * 握手不合法时直接回 400 并返回 null。
 */
export function acceptWebSocket(req, socket, head = Buffer.alloc(0)) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay?.(true);
  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let closed = false;
  const conn = {
    onMessage: () => {},
    onClose: () => {},
    get open() { return !closed; },
    send(text) { if (!closed) socket.write(frame(0x1, Buffer.from(String(text)))); },
    close(code = 1000, reason = '') {
      if (closed) return;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      try { socket.end(frame(0x8, body)); } catch { /* 已断 */ }
      finish();
    },
  };
  function finish() {
    if (closed) return;
    closed = true;
    try { conn.onClose(); } catch { /* 回调里的错不影响收尾 */ }
  }
  function parse() {
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (len > MAX_MESSAGE) { conn.close(1009, 'too big'); return; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + len) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= buffer[maskAt + (i & 3)];
      buffer = buffer.subarray(offset + len);
      if (opcode === 0x8) { try { socket.end(frame(0x8)); } catch { /* 已断 */ } finish(); return; }
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          try { conn.onMessage(text); } catch { /* 回调里的错不断连接 */ }
        }
      }
    }
  }
  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
  socket.on('close', finish);
  socket.on('error', finish);
  if (buffer.length) queueMicrotask(parse);
  return conn;
}
