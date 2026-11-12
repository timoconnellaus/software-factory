// Android key attestation chains made in the test, under a TEST root that only the tests trust
// (`mobileTestSeams.roots`). They stand in for a phone's Keystore: a root, an intermediate and a
// leaf carrying the key description (OID 1.3.6.1.4.1.11129.2.1.17), all signed with WebCrypto.
// Every field the engine checks can be set, so each refusal has its own chain. The leaf's private
// key signs presence proofs, as the phone's Keystore key would after a fingerprint.
import type { PinnedRoot } from "@software-factory/core";

// ---- A small DER writer ----
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const len = (n: number) => {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, body: Uint8Array) =>
  concat(new Uint8Array([tag]), len(body.length), body);
const seq = (...items: Uint8Array[]) => tlv(0x30, concat(...items));
const set = (...items: Uint8Array[]) => tlv(0x31, concat(...items));
const octets = (b: Uint8Array) => tlv(0x04, b);
const nul = () => new Uint8Array([0x05, 0x00]);
const bool = (v: boolean) => new Uint8Array([0x01, 0x01, v ? 0xff : 0x00]);
function intBytes(v: number | bigint): Uint8Array {
  let n = BigInt(v);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return new Uint8Array(bytes);
}
const int = (v: number | bigint) => tlv(0x02, intBytes(v));
const enumerated = (v: number) => tlv(0x0a, intBytes(v));
function oid(text: string): Uint8Array {
  const [a, b, ...rest] = text.split(".").map(Number) as [number, number, ...number[]];
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(out));
}
/** [tag] EXPLICIT, high tag numbers included. */
function explicit(tag: number, body: Uint8Array): Uint8Array {
  if (tag < 31) return tlv(0xa0 | tag, body);
  const num: number[] = [tag & 0x7f];
  for (let v = Math.floor(tag / 128); v > 0; v = Math.floor(v / 128))
    num.unshift(0x80 | (v & 0x7f));
  return concat(new Uint8Array([0xbf, ...num]), len(body.length), body);
}
const generalizedTime = (ms: number) => {
  const d = new Date(ms).toISOString();
  return tlv(
    0x18,
    new TextEncoder().encode(
      `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}Z`,
    ),
  );
};
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode(cn)))));

function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(int(BigInt(`0x${hex(raw.slice(0, half))}`)), int(BigInt(`0x${hex(raw.slice(half))}`)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64url = (b: Uint8Array) =>
  b64(b).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

type Keys = CryptoKeyPair;
const newKeys = async () =>
  (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as Keys;
const spki = async (k: Keys) =>
  new Uint8Array((await crypto.subtle.exportKey("spki", k.publicKey)) as ArrayBuffer);

let serial = 1000n;
async function certificate(opts: {
  subject: string;
  issuer: string;
  subjectKeys: Keys;
  issuerKeys: Keys;
  notBefore?: number;
  notAfter?: number;
  extensions?: Uint8Array[];
  serial?: bigint;
}): Promise<{ der: Uint8Array; serial: string }> {
  const s = opts.serial ?? serial++;
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const tbs = seq(
    explicit(0, int(2)),
    int(s),
    ecdsaSha256,
    name(opts.issuer),
    seq(
      generalizedTime(opts.notBefore ?? Date.now() - 86_400_000),
      generalizedTime(opts.notAfter ?? Date.now() + 365 * 86_400_000),
    ),
    name(opts.subject),
    await spki(opts.subjectKeys),
    ...(opts.extensions?.length ? [explicit(3, seq(...opts.extensions))] : []),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.issuerKeys.privateKey, tbs),
  );
  const der = seq(tbs, ecdsaSha256, tlv(0x03, concat(new Uint8Array([0]), rawToDer(sig))));
  return { der, serial: s.toString(16) };
}

/** The test app's signing certificate digest (MOBILE_SIGNING_CERTS in vitest.config.ts). */
export const TEST_SIGNING_CERT = "5e".repeat(32);
export const TEST_PACKAGE = "com.zerobsai.factory";

export interface KeyOptions {
  challenge: Uint8Array;
  attestationSecurityLevel?: number;
  keyMintSecurityLevel?: number;
  purpose?: number[];
  algorithm?: number;
  ecCurve?: number;
  noAuthRequired?: boolean;
  /** 2 fingerprint, 1 password, 3 either; null leaves it out. */
  userAuthType?: number | null;
  authTimeout?: number | null;
  /** null leaves it out. */
  origin?: number | null;
  verifiedBootState?: number;
  /** 300 (KeyMint 3) unless set; Keymaster's were 1 to 4. */
  attestationVersion?: number;
  /** `YYYYMM`; this month unless set. */
  osPatchLevel?: number;
  /** Leave the CA extensions off the intermediate (an end-entity key vouching for another). */
  intermediateNotCa?: boolean;
  deviceLocked?: boolean;
  packageName?: string;
  signatureDigest?: string;
  /** Put a key description in the intermediate too (an attacker extending the chain). */
  extensionInIntermediate?: boolean;
  intermediateNotAfter?: number;
  /** An extension marked critical in the leaf, by OID (one the checker doesn't understand). */
  criticalInLeaf?: string;
}

function keyDescription(o: KeyOptions): Uint8Array {
  const appId = seq(
    set(seq(octets(new TextEncoder().encode(o.packageName ?? TEST_PACKAGE)), int(1))),
    set(
      octets(
        Uint8Array.from((o.signatureDigest ?? TEST_SIGNING_CERT).match(/../g) ?? [], (h) =>
          Number.parseInt(h, 16),
        ),
      ),
    ),
  );
  const software = seq(explicit(701, int(Date.now())), explicit(709, octets(appId)));
  const hardware = seq(
    explicit(1, set(...(o.purpose ?? [2]).map((p) => int(p)))),
    explicit(2, int(o.algorithm ?? 3)),
    explicit(3, int(256)),
    explicit(5, set(int(4))),
    explicit(10, int(o.ecCurve ?? 1)),
    ...(o.noAuthRequired ? [explicit(503, nul())] : []),
    ...(o.userAuthType === null ? [] : [explicit(504, int(o.userAuthType ?? 2))]),
    ...(o.authTimeout === null || o.authTimeout === undefined
      ? []
      : [explicit(505, int(o.authTimeout))]),
    ...(o.origin === null ? [] : [explicit(702, int(o.origin ?? 0))]),
    explicit(
      704,
      seq(
        octets(new Uint8Array(32).fill(7)),
        bool(o.deviceLocked ?? true),
        enumerated(o.verifiedBootState ?? 0),
        octets(new Uint8Array(32).fill(9)),
      ),
    ),
    explicit(705, int(140000)),
    explicit(706, int(o.osPatchLevel ?? thisMonth())),
    explicit(718, int(20261005)),
    explicit(719, int(20261005)),
  );
  return seq(
    int(o.attestationVersion ?? 300),
    enumerated(o.attestationSecurityLevel ?? 1),
    int(300),
    enumerated(o.keyMintSecurityLevel ?? 1),
    octets(o.challenge),
    octets(new Uint8Array()),
    software,
    hardware,
  );
}

const extension = (id: string, value: Uint8Array) => seq(oid(id), octets(value));

/** `YYYYMM` for the current month, as a phone patched this month reports it. */
export function thisMonth(at = Date.now()): number {
  const d = new Date(at);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}

/** basicConstraints cA TRUE and keyUsage keyCertSign + cRLSign, as Google's issuers carry. */
const caExtensions = () => [
  extension("2.5.29.19", seq(bool(true))),
  extension("2.5.29.15", tlv(0x03, new Uint8Array([0x01, 0x06]))),
];

/** A test root that only the tests trust. */
export async function testRoot(): Promise<{ keys: Keys; pinned: PinnedRoot; cn: string }> {
  const keys = await newKeys();
  const der = await spki(keys);
  const hash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", der)));
  return {
    keys,
    pinned: { name: "TEST root (tests only)", spkiSha256: hash, spki: b64(der) },
    cn: "Test Attestation Root",
  };
}

/** A phone's attested key: the chain to send, and a signer standing in for the fingerprint. */
export async function attestedKey(root: Awaited<ReturnType<typeof testRoot>>, o: KeyOptions) {
  const leafKeys = await newKeys();
  const midKeys = await newKeys();
  const kd = keyDescription(o);
  const rootCert = await certificate({
    subject: root.cn,
    issuer: root.cn,
    subjectKeys: root.keys,
    issuerKeys: root.keys,
    extensions: caExtensions(),
  });
  const mid = await certificate({
    subject: "Test StrongBox intermediate",
    issuer: root.cn,
    subjectKeys: midKeys,
    issuerKeys: root.keys,
    ...(o.intermediateNotAfter !== undefined ? { notAfter: o.intermediateNotAfter } : {}),
    extensions: [
      ...(o.intermediateNotCa ? [] : caExtensions()),
      ...(o.extensionInIntermediate ? [extension("1.3.6.1.4.1.11129.2.1.17", kd)] : []),
    ],
  });
  const leaf = await certificate({
    subject: "Android Keystore Key",
    issuer: "Test StrongBox intermediate",
    subjectKeys: leafKeys,
    issuerKeys: midKeys,
    notBefore: 0,
    notAfter: Date.UTC(2106, 1, 7),
    extensions: [
      extension("1.3.6.1.4.1.11129.2.1.17", kd),
      ...(o.criticalInLeaf
        ? [seq(oid(o.criticalInLeaf), bool(true), octets(seq(bool(true))))]
        : []),
    ],
  });
  const sign = async (message: string) =>
    b64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          leafKeys.privateKey,
          new TextEncoder().encode(message),
        ),
      ),
    );
  return {
    chain: [leaf.der, mid.der, rootCert.der].map(b64),
    serials: { leaf: leaf.serial, intermediate: mid.serial, root: rootCert.serial },
    sign,
  };
}

/** The attestation challenge for a nonce: SHA-256 of its UTF-8 bytes (core's attestationChallenge). */
export async function challengeFor(nonce: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)));
}

export function pemToBase64(pem: string): string {
  return pem.replace(/-----[^-]+-----|\s/g, "");
}
