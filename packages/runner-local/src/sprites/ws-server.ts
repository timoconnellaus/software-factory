// Test support: a minimal WebSocket server side (RFC 6455) over a Node `http` upgrade, for the fake
// Sprites API's exec endpoint. Node 24 has a WebSocket client but no server, and the repo adds no
// dependency for a test double. Text and binary frames, ping/pong, close; fragmented frames are
// reassembled. Not used at runtime.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface ServerSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  onMessage(fn: (data: Buffer, binary: boolean) => void): void;
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Completes the upgrade and returns the socket. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): ServerSocket {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  const messageFns: ((data: Buffer, binary: boolean) => void)[] = [];
  const closeFns: (() => void)[] = [];
  let closed = false;
  let buf = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let partsBinary = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn();
  };
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0] ?? 0;
      const b1 = buf[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = (payload[i] ?? 0) ^ (buf[maskOff + (i % 4)] ?? 0);
        }
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) {
        if (!socket.destroyed) socket.end(frame(0x8, payload.subarray(0, 2)));
        finish();
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        parts = [payload];
        partsBinary = opcode === 0x2;
      } else if (opcode === 0x0) {
        parts.push(payload);
      }
      if (fin) {
        const data = Buffer.concat(parts);
        parts = [];
        for (const fn of messageFns) fn(data, partsBinary);
      }
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);
  return {
    send(data) {
      if (closed || socket.destroyed) return;
      socket.write(
        typeof data === "string" ? frame(0x1, Buffer.from(data)) : frame(0x2, Buffer.from(data)),
      );
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      if (!socket.destroyed) socket.end(frame(0x8, body));
      finish();
    },
    onMessage: (fn) => void messageFns.push(fn),
    onClose: (fn) => void closeFns.push(fn),
    get closed() {
      return closed;
    },
  };
}
