// A small DER reader for the X.509 certificates of an Android key attestation (ADR 0541). Only what
// those need: definite lengths in their shortest form (DER, not BER), high tag numbers (the attestation's [701], [709] …), INTEGER,
// ENUMERATED, BOOLEAN, OCTET STRING, BIT STRING, OID, NULL, SET, SEQUENCE and the two time types.
// Every read is bounds-checked: anything malformed throws a DerError, never reads past the buffer.

export class DerError extends Error {}

/** One TLV. Offsets are into `buf`. */
export interface Der {
  buf: Uint8Array;
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  tag: number;
  /** Where the header starts. */
  start: number;
  /** Where the content starts. */
  body: number;
  /** One past the content's end. */
  end: number;
}

export const UNIVERSAL = 0;
export const CONTEXT = 2;
export const T = {
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OID: 6,
  ENUMERATED: 10,
  UTF8: 12,
  SEQUENCE: 16,
  SET: 17,
  UTC_TIME: 23,
  GENERALIZED_TIME: 24,
} as const;

/** Reads the TLV at `offset`, which must end at or before `limit`. */
export function readDer(buf: Uint8Array, offset = 0, limit = buf.length): Der {
  let i = offset;
  const byte = () => {
    if (i >= limit) throw new DerError("truncated");
    return buf[i++] as number;
  };
  const first = byte();
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    for (let n = 0; ; n++) {
      if (n > 3) throw new DerError("tag number too long");
      const b = byte();
      if (n === 0 && b === 0x80) throw new DerError("tag number not minimal");
      tag = tag * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    if (tag < 0x1f) throw new DerError("tag number not minimal");
  }
  let length = byte();
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0) throw new DerError("indefinite length");
    if (count > 4) throw new DerError("length too long");
    length = 0;
    for (let n = 0; n < count; n++) {
      const b = byte();
      // DER: the shortest form only. No leading zero byte, and the long form only past 127.
      if (n === 0 && b === 0) throw new DerError("length not minimal");
      length = length * 256 + b;
    }
    if (length < 0x80) throw new DerError("length not minimal");
  }
  const body = i;
  const end = body + length;
  if (end > limit) throw new DerError("length past the end");
  return { buf, cls, constructed, tag, start: offset, body, end };
}

/** The content bytes. */
export const content = (d: Der) => d.buf.subarray(d.body, d.end);
/** The whole TLV, header included (what a signature covers). */
export const raw = (d: Der) => d.buf.subarray(d.start, d.end);

/** The TLVs inside a constructed one. */
export function children(d: Der): Der[] {
  if (!d.constructed) throw new DerError("not constructed");
  const out: Der[] = [];
  for (let at = d.body; at < d.end; ) {
    const c = readDer(d.buf, at, d.end);
    out.push(c);
    at = c.end;
  }
  return out;
}

export function expect(d: Der | undefined, tag: number, cls = UNIVERSAL): Der {
  if (!d || d.tag !== tag || d.cls !== cls) {
    throw new DerError(`expected tag ${cls}:${tag}, got ${d ? `${d.cls}:${d.tag}` : "nothing"}`);
  }
  return d;
}

/** A whole buffer that is exactly one TLV. */
export function parseOne(buf: Uint8Array): Der {
  const d = readDer(buf);
  if (d.end !== buf.length) throw new DerError("trailing bytes");
  return d;
}

/** INTEGER or ENUMERATED as a bigint (two's complement). */
export function bigInt(d: Der): bigint {
  const bytes = content(d);
  if (bytes.length === 0) throw new DerError("empty integer");
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  if ((bytes[0] as number) & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return v;
}

/** INTEGER or ENUMERATED that must fit a safe JS number. */
export function int(d: Der): number {
  const v = bigInt(d);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DerError("integer too large");
  }
  return Number(v);
}

export function bool(d: Der): boolean {
  const c = content(expect(d, T.BOOLEAN));
  if (c.length !== 1) throw new DerError("bad boolean");
  return c[0] !== 0;
}

export function oid(d: Der): string {
  const c = content(expect(d, T.OID));
  if (c.length === 0) throw new DerError("empty oid");
  const parts: number[] = [];
  let v = 0;
  for (const b of c) {
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  const head = parts.shift() ?? 0;
  const a = head < 40 ? 0 : head < 80 ? 1 : 2;
  return [a, head - a * 40, ...parts].join(".");
}

/** A BIT STRING's bytes (only whole bytes: unused bits must be 0). */
export function bits(d: Der): Uint8Array {
  const c = content(expect(d, T.BIT_STRING));
  if (c.length === 0 || c[0] !== 0) throw new DerError("bit string with unused bits");
  return c.subarray(1);
}

/** UTCTime or GeneralizedTime (Z only), as epoch ms. */
export function time(d: Der): number {
  const text = new TextDecoder().decode(content(d));
  const m =
    d.tag === T.UTC_TIME
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : d.tag === T.GENERALIZED_TIME
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
        : null;
  if (!m) throw new DerError(`bad time ${text}`);
  let year = Number(m[1]);
  if (d.tag === T.UTC_TIME) year += year < 50 ? 2000 : 1900;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const std = text.replaceAll("-", "+").replaceAll("_", "/").replace(/\s+/g, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
