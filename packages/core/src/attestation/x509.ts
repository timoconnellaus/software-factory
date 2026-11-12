// X.509 for an attestation chain (ADR 0541): parse what the checks need and verify one certificate's
// signature with its issuer's key through WebCrypto. ECDSA (P-256, P-384) and RSA PKCS#1 v1.5 with
// SHA-256/384/512 — what Google's roots, the device intermediates and the Keystore leaf use.
import {
  bigInt,
  bits,
  bool,
  CONTEXT,
  children,
  content,
  type Der,
  DerError,
  expect,
  hex,
  oid,
  parseOne,
  raw,
  T,
  time,
} from "./der.ts";

export interface Certificate {
  der: Uint8Array;
  /** The signed part, header included. */
  tbs: Uint8Array<ArrayBuffer>;
  sigAlg: string;
  signature: Uint8Array<ArrayBuffer>;
  /** Lowercase hex, no leading zeros: how Google's revocation list names a certificate. */
  serial: string;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The DER SubjectPublicKeyInfo. */
  spki: Uint8Array<ArrayBuffer>;
  keyAlg: string;
  /** The named curve, for EC keys. */
  curve: string | null;
  /** Extensions by OID: the extnValue's content (the DER inside the OCTET STRING). */
  extensions: Map<string, Uint8Array>;
}

export const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  rsaSha256: "1.2.840.113549.1.1.11",
  rsaSha384: "1.2.840.113549.1.1.12",
  rsaSha512: "1.2.840.113549.1.1.13",
} as const;

const copy = (b: Uint8Array) => new Uint8Array(b);

const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";
/** The Android key attestation's key description. */
const KEY_DESCRIPTION = "1.3.6.1.4.1.11129.2.1.17"; // KEY_DESCRIPTION_OID (android.ts imports this file)
/** The extensions this checker reads, and so the only ones it accepts marked critical. */
const UNDERSTOOD_CRITICAL: ReadonlySet<string> = new Set([
  BASIC_CONSTRAINTS,
  KEY_USAGE,
  KEY_DESCRIPTION,
]);

/**
 * Whether a certificate may issue others: basicConstraints with cA TRUE, and keyUsage with
 * keyCertSign. Both extensions are required; a malformed one counts as no.
 */
export function canIssue(cert: Certificate): boolean {
  const bc = cert.extensions.get(BASIC_CONSTRAINTS);
  const ku = cert.extensions.get(KEY_USAGE);
  if (!bc || !ku) return false;
  try {
    // BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }
    const first = children(expect(parseOne(bc), T.SEQUENCE))[0];
    const ca = first?.tag === T.BOOLEAN && first.cls === 0 ? bool(first) : false;
    // KeyUsage ::= BIT STRING; keyCertSign is bit 5, 0x04 in the first byte.
    const usage = content(expect(parseOne(ku), T.BIT_STRING));
    const keyCertSign = usage.length >= 2 && ((usage[1] as number) & 0x04) !== 0;
    return ca && keyCertSign;
  } catch {
    return false;
  }
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = expect(parseOne(der), T.SEQUENCE);
  const [tbsNode, algNode, sigNode] = children(cert);
  const tbs = expect(tbsNode, T.SEQUENCE);
  const f = children(tbs);
  let i = 0;
  if (f[0]?.cls === CONTEXT && f[0].tag === 0) i++; // [0] version
  const serialNode = expect(f[i++], T.INTEGER);
  const sigAlgInner = f[i++];
  const issuer = expect(f[i++], T.SEQUENCE);
  const validity = children(expect(f[i++], T.SEQUENCE));
  const subject = expect(f[i++], T.SEQUENCE);
  const spkiNode = expect(f[i++], T.SEQUENCE);
  const extensions = new Map<string, Uint8Array>();
  for (; i < f.length; i++) {
    const node = f[i] as Der;
    if (node.cls !== CONTEXT || node.tag !== 3) continue;
    const list = expect(children(node)[0], T.SEQUENCE);
    for (const ext of children(list)) {
      const parts = children(expect(ext, T.SEQUENCE));
      const id = oid(parts[0] as Der);
      // Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }.
      // A critical extension this checker doesn't understand refuses the certificate (RFC 5280
      // 4.2): it might restrict the key in a way we would otherwise ignore.
      if (parts.length > 3) throw new DerError(`malformed extension ${id}`);
      const flag = parts.length === 3 ? expect(parts[1], T.BOOLEAN) : null;
      if (flag && bool(flag) && !UNDERSTOOD_CRITICAL.has(id)) {
        throw new DerError(`unknown critical extension ${id}`);
      }
      const value = expect(parts[parts.length - 1], T.OCTET_STRING);
      if (extensions.has(id)) throw new DerError(`duplicate extension ${id}`);
      extensions.set(id, content(value));
    }
  }
  const alg = algorithm(expect(algNode, T.SEQUENCE));
  if (alg !== algorithm(expect(sigAlgInner, T.SEQUENCE))) {
    throw new DerError("signature algorithm mismatch");
  }
  const keyAlgParts = children(expect(children(spkiNode)[0], T.SEQUENCE));
  const keyAlg = oid(keyAlgParts[0] as Der);
  const curve = keyAlg === OID.ecPublicKey && keyAlgParts[1] ? oid(keyAlgParts[1]) : null;
  const serialValue = bigInt(serialNode);
  return {
    der,
    tbs: copy(raw(tbs)),
    sigAlg: alg,
    signature: copy(bits(sigNode as Der)),
    serial: (serialValue < 0n ? -serialValue : serialValue).toString(16),
    issuer: raw(issuer),
    subject: raw(subject),
    notBefore: time(validity[0] as Der),
    notAfter: time(validity[1] as Der),
    spki: copy(raw(spkiNode)),
    keyAlg,
    curve,
    extensions,
  };
}

function algorithm(seq: Der): string {
  return oid(children(seq)[0] as Der);
}

const HASH: Record<string, "SHA-256" | "SHA-384" | "SHA-512"> = {
  [OID.ecdsaSha256]: "SHA-256",
  [OID.ecdsaSha384]: "SHA-384",
  [OID.ecdsaSha512]: "SHA-512",
  [OID.rsaSha256]: "SHA-256",
  [OID.rsaSha384]: "SHA-384",
  [OID.rsaSha512]: "SHA-512",
};

/** Whether `cert` is signed by the key in `issuerSpki`. Unknown algorithms are false. */
export async function signedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  const hash = HASH[cert.sigAlg];
  if (!hash) return false;
  try {
    if (issuer.keyAlg === OID.ecPublicKey) {
      if (!cert.sigAlg.startsWith("1.2.840.10045.4.3.")) return false;
      const namedCurve =
        issuer.curve === OID.p256 ? "P-256" : issuer.curve === OID.p384 ? "P-384" : null;
      if (!namedCurve) return false;
      const key = await crypto.subtle.importKey(
        "spki",
        issuer.spki,
        { name: "ECDSA", namedCurve },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash },
        key,
        derEcdsaToRaw(cert.signature, namedCurve === "P-256" ? 32 : 48),
        cert.tbs,
      );
    }
    if (issuer.keyAlg === OID.rsaEncryption) {
      if (!cert.sigAlg.startsWith("1.2.840.113549.1.1.")) return false;
      const key = await crypto.subtle.importKey(
        "spki",
        issuer.spki,
        { name: "RSASSA-PKCS1-v1_5", hash },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, cert.signature, cert.tbs);
    }
  } catch {
    return false;
  }
  return false;
}

/** An X9.62 DER ECDSA signature as WebCrypto wants it: r ‖ s, each `size` bytes. */
export function derEcdsaToRaw(sig: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const seq = expect(parseOne(sig), T.SEQUENCE);
  const out = new Uint8Array(size * 2);
  const parts = children(seq);
  if (parts.length !== 2) throw new DerError("bad ECDSA signature");
  parts.forEach((p, n) => {
    let bytes = content(expect(p, T.INTEGER));
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length > size) throw new DerError("ECDSA integer too long");
    out.set(bytes, n * size + size - bytes.length);
  });
  return out;
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
