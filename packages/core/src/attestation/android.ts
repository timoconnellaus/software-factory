// Android key attestation, checked on the engine (ADR 0541 decision 3, spec 60 PR 1a).
//
// The phone generates its signing key in Android Keystore with an attestation challenge, and sends
// the key's certificate chain (leaf first) with mobile.authStart. This module decides whether that
// key may register, and with what `key_storage`:
// - the chain: every certificate signed by the next, names chained, intermediates in date, and the
//   last key one of Google's pinned roots (roots.ts); no certificate on the revocation list;
// - the key description (OID 1.3.6.1.4.1.11129.2.1.17) only in the leaf, as Google says: a later
//   one would be an attacker extending the chain;
// - the challenge equals the one this sign-in derives;
// - the security level (attestation and KeyMint) is TrustedEnvironment or StrongBox: a software
//   level is refused;
// - the key: EC P-256, SIGN, generated in the hardware, user authentication by fingerprint only
//   (no PIN), per use (no timeout), and not `noAuthRequired`;
// - the app: exactly our package, signed only by certificates in `MOBILE_SIGNING_CERTS`;
// - the boot state: `Verified` and the bootloader locked. Otherwise the phone still registers,
//   with key_storage `software`, so it can't decide (the owner's choice, spec 60 open question 4).
//
// Any other failure throws an AttestationError, and the sign-in is refused before anything is
// stored.
import {
  bool,
  bytesEqual,
  CONTEXT,
  children,
  content,
  type Der,
  DerError,
  expect,
  hex,
  int,
  parseOne,
  T,
} from "./der.ts";
import { GOOGLE_ATTESTATION_ROOTS, type PinnedRoot } from "./roots.ts";
import { type Certificate, OID, parseCertificate, sha256, signedBy } from "./x509.ts";

export const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
/** The phone app's package (spec 60 open question 1, accepted by the owner). Permanent. */
export const MOBILE_PACKAGE = "com.zerobsai.factory";

export type AttestationFailure =
  | "malformed"
  | "chain"
  | "untrusted-root"
  | "expired"
  | "revoked"
  | "extension"
  | "challenge"
  | "security-level"
  | "key"
  | "auth"
  | "app";

export class AttestationError extends Error {
  readonly reason: AttestationFailure;
  constructor(reason: AttestationFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type SecurityLevel = "software" | "tee" | "strongbox";
export type BootState = "verified" | "self-signed" | "unverified" | "failed";

export interface AuthorizationList {
  purpose: number[];
  algorithm: number | null;
  keySize: number | null;
  ecCurve: number | null;
  noAuthRequired: boolean;
  userAuthType: number | null;
  authTimeout: number | null;
  origin: number | null;
  rootOfTrust: { deviceLocked: boolean; verifiedBootState: BootState } | null;
  osVersion: number | null;
  osPatchLevel: number | null;
  vendorPatchLevel: number | null;
  bootPatchLevel: number | null;
  application: { packages: { name: string; version: number }[]; signatureDigests: string[] } | null;
}

export interface KeyDescription {
  attestationVersion: number;
  attestationSecurityLevel: SecurityLevel;
  keyMintVersion: number;
  keyMintSecurityLevel: SecurityLevel;
  challenge: Uint8Array;
  softwareEnforced: AuthorizationList;
  hardwareEnforced: AuthorizationList;
}

/** What is stored as the device's `attestation` and shown on the approval page. */
export interface AttestationRecord {
  securityLevel: SecurityLevel;
  keyMintSecurityLevel: SecurityLevel;
  attestationVersion: number;
  keyMintVersion: number;
  verifiedBootState: BootState | null;
  deviceLocked: boolean | null;
  osVersion: number | null;
  osPatchLevel: number | null;
  vendorPatchLevel: number | null;
  bootPatchLevel: number | null;
  root: string;
  chainLength: number;
  /** Why the phone can't decide, when it registers as `software`. */
  downgraded: string | null;
}

export interface VerifiedAttestation {
  keyStorage: "strongbox" | "tee" | "software";
  /** The attested key, as the JWK the device's proofs are checked with. */
  publicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
  record: AttestationRecord;
}

export interface AttestationExpectations {
  /** The challenge this sign-in derives (see `attestationChallenge`). */
  challenge: Uint8Array;
  /** The package (MOBILE_PACKAGE outside tests). */
  packageName: string;
  /** SHA-256 of the allowed signing certificates (MOBILE_SIGNING_CERTS), any case, colons allowed. */
  signingCerts: readonly string[];
  /** Serial numbers (lowercase hex) on Google's revocation list. */
  revoked: ReadonlySet<string>;
  now: number;
  /** Google's roots unless a test passes its own. */
  roots?: readonly PinnedRoot[];
}

/** The attestation challenge for a nonce from mobile/nonce: SHA-256 of its UTF-8 bytes. */
export async function attestationChallenge(nonce: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)));
}

/** `AB:CD:…` (keytool) or `abcd…` → `abcd…`. */
export const normalizeCertDigest = (text: string) =>
  text.replace(/[^0-9a-fA-F]/g, "").toLowerCase();

const LEVELS: Record<number, SecurityLevel> = { 0: "software", 1: "tee", 2: "strongbox" };
const BOOT: Record<number, BootState> = {
  0: "verified",
  1: "self-signed",
  2: "unverified",
  3: "failed",
};
// Keymaster/KeyMint values.
const ALGORITHM_EC = 3;
const CURVE_P256 = 1;
const PURPOSE_SIGN = 2;
const AUTH_PASSWORD = 1;
const AUTH_FINGERPRINT = 2;
const ORIGIN_GENERATED = 0;
const MAX_CHAIN = 10;

export async function verifyAndroidAttestation(
  chain: readonly string[] | readonly Uint8Array[],
  expected: AttestationExpectations,
): Promise<VerifiedAttestation> {
  if (chain.length < 2 || chain.length > MAX_CHAIN) {
    throw new AttestationError("malformed", `a chain of 2 to ${MAX_CHAIN} certificates is needed`);
  }
  let certs: Certificate[];
  try {
    certs = chain.map((c) => parseCertificate(typeof c === "string" ? fromBase64(c) : c));
  } catch (error) {
    throw new AttestationError("malformed", `a certificate doesn't parse: ${message(error)}`);
  }
  const leaf = certs[0] as Certificate;
  const last = certs[certs.length - 1] as Certificate;

  // The chain: each certificate signed by the next, and the last key pinned.
  const roots = expected.roots ?? GOOGLE_ATTESTATION_ROOTS;
  const rootHash = await sha256(last.spki);
  const root = roots.find((r) => r.spkiSha256 === rootHash);
  if (!root) {
    throw new AttestationError("untrusted-root", "the chain doesn't end at a pinned Google root");
  }
  for (let i = 0; i < certs.length - 1; i++) {
    const cert = certs[i] as Certificate;
    const issuer = certs[i + 1] as Certificate;
    if (!bytesEqual(cert.issuer, issuer.subject) || !(await signedBy(cert, issuer))) {
      throw new AttestationError("chain", `certificate ${i} isn't signed by the next one`);
    }
  }
  // Intermediates must be in date. The leaf's dates are the key's (Android often writes 1970 to
  // 2106), and the root is a pinned key, not a certificate, so neither is judged by its dates.
  for (const cert of certs.slice(1, -1)) {
    if (expected.now < cert.notBefore || expected.now > cert.notAfter) {
      throw new AttestationError("expired", "an intermediate certificate is out of date");
    }
  }
  for (const cert of certs) {
    if (expected.revoked.has(cert.serial)) {
      throw new AttestationError("revoked", `certificate ${cert.serial} is revoked by Google`);
    }
  }

  // The key description: in the leaf, and only there.
  if (certs.slice(1).some((c) => c.extensions.has(KEY_DESCRIPTION_OID))) {
    throw new AttestationError("extension", "a key description outside the leaf certificate");
  }
  const ext = leaf.extensions.get(KEY_DESCRIPTION_OID);
  if (!ext) throw new AttestationError("extension", "the leaf has no key description");
  let kd: KeyDescription;
  try {
    kd = parseKeyDescription(ext);
  } catch (error) {
    throw new AttestationError("malformed", `the key description doesn't parse: ${message(error)}`);
  }

  if (!bytesEqual(kd.challenge, expected.challenge)) {
    throw new AttestationError("challenge", "the attestation challenge isn't this sign-in's");
  }
  if (kd.attestationSecurityLevel === "software" || kd.keyMintSecurityLevel === "software") {
    throw new AttestationError("security-level", "the key isn't in secure hardware");
  }

  // The key, from what the hardware enforces.
  const hw = kd.hardwareEnforced;
  const sw = kd.softwareEnforced;
  if (
    leaf.keyAlg !== OID.ecPublicKey ||
    leaf.curve !== OID.p256 ||
    hw.algorithm !== ALGORITHM_EC ||
    (hw.ecCurve !== null && hw.ecCurve !== CURVE_P256) ||
    (hw.keySize !== null && hw.keySize !== 256) ||
    !hw.purpose.includes(PURPOSE_SIGN) ||
    (hw.origin !== null && hw.origin !== ORIGIN_GENERATED)
  ) {
    throw new AttestationError("key", "not a P-256 signing key generated in the hardware");
  }
  if (
    hw.noAuthRequired ||
    sw.noAuthRequired ||
    hw.userAuthType === null ||
    (hw.userAuthType & AUTH_FINGERPRINT) === 0 ||
    (hw.userAuthType & AUTH_PASSWORD) !== 0 ||
    (hw.authTimeout !== null && hw.authTimeout !== 0) ||
    (sw.authTimeout !== null && sw.authTimeout !== 0)
  ) {
    throw new AttestationError(
      "auth",
      "the key must need a fingerprint for every use, with no PIN and no time window",
    );
  }

  // The app.
  const app = hw.application ?? sw.application;
  const allowed = new Set(expected.signingCerts.map(normalizeCertDigest).filter(Boolean));
  if (
    app?.packages.length !== 1 ||
    app.packages[0]?.name !== expected.packageName ||
    app.signatureDigests.length === 0 ||
    !app.signatureDigests.every((d) => allowed.has(d))
  ) {
    throw new AttestationError("app", "the key isn't our app's, signed with our release key");
  }

  // The boot state decides whether this phone may decide.
  const rot = hw.rootOfTrust;
  const downgraded = !rot
    ? "no root of trust in the attestation"
    : rot.verifiedBootState !== "verified"
      ? `verified boot is ${rot.verifiedBootState}`
      : !rot.deviceLocked
        ? "the bootloader is unlocked"
        : null;

  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    await crypto.subtle.importKey("spki", leaf.spki, { name: "ECDSA", namedCurve: "P-256" }, true, [
      "verify",
    ]),
  )) as JsonWebKey;
  return {
    keyStorage: downgraded
      ? "software"
      : kd.keyMintSecurityLevel === "strongbox"
        ? "strongbox"
        : "tee",
    publicKey: { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) },
    record: {
      securityLevel: kd.attestationSecurityLevel,
      keyMintSecurityLevel: kd.keyMintSecurityLevel,
      attestationVersion: kd.attestationVersion,
      keyMintVersion: kd.keyMintVersion,
      verifiedBootState: rot?.verifiedBootState ?? null,
      deviceLocked: rot?.deviceLocked ?? null,
      osVersion: hw.osVersion ?? sw.osVersion,
      osPatchLevel: hw.osPatchLevel ?? sw.osPatchLevel,
      vendorPatchLevel: hw.vendorPatchLevel ?? sw.vendorPatchLevel,
      bootPatchLevel: hw.bootPatchLevel ?? sw.bootPatchLevel,
      root: root.name,
      chainLength: certs.length,
      downgraded,
    },
  };
}

/** KeyDescription ::= SEQUENCE { version, securityLevel, keyMintVersion, keyMintSecurityLevel, challenge, uniqueId, softwareEnforced, hardwareEnforced } */
export function parseKeyDescription(bytes: Uint8Array): KeyDescription {
  const f = children(expect(parseOne(bytes), T.SEQUENCE));
  if (f.length < 8) throw new DerError("short key description");
  const level = (d: Der | undefined) => {
    const v = LEVELS[int(expect(d, T.ENUMERATED))];
    if (!v) throw new DerError("unknown security level");
    return v;
  };
  return {
    attestationVersion: int(expect(f[0], T.INTEGER)),
    attestationSecurityLevel: level(f[1]),
    keyMintVersion: int(expect(f[2], T.INTEGER)),
    keyMintSecurityLevel: level(f[3]),
    challenge: content(expect(f[4], T.OCTET_STRING)),
    softwareEnforced: authorizationList(f[6]),
    hardwareEnforced: authorizationList(f[7]),
  };
}

function authorizationList(node: Der | undefined): AuthorizationList {
  const list: AuthorizationList = {
    purpose: [],
    algorithm: null,
    keySize: null,
    ecCurve: null,
    noAuthRequired: false,
    userAuthType: null,
    authTimeout: null,
    origin: null,
    rootOfTrust: null,
    osVersion: null,
    osPatchLevel: null,
    vendorPatchLevel: null,
    bootPatchLevel: null,
    application: null,
  };
  const seen = new Set<number>();
  for (const field of children(expect(node, T.SEQUENCE))) {
    if (field.cls !== CONTEXT || !field.constructed) throw new DerError("not a tagged field");
    if (seen.has(field.tag)) throw new DerError(`tag ${field.tag} twice`);
    seen.add(field.tag);
    const inner = children(field);
    if (inner.length !== 1) throw new DerError(`tag ${field.tag}: one value expected`);
    const v = inner[0] as Der;
    switch (field.tag) {
      case 1:
        list.purpose = children(expect(v, T.SET)).map((p) => int(expect(p, T.INTEGER)));
        break;
      case 2:
        list.algorithm = int(expect(v, T.INTEGER));
        break;
      case 3:
        list.keySize = int(expect(v, T.INTEGER));
        break;
      case 10:
        list.ecCurve = int(expect(v, T.INTEGER));
        break;
      case 503:
        expect(v, T.NULL);
        list.noAuthRequired = true;
        break;
      case 504:
        list.userAuthType = int(expect(v, T.INTEGER));
        break;
      case 505:
        list.authTimeout = int(expect(v, T.INTEGER));
        break;
      case 702:
        list.origin = int(expect(v, T.INTEGER));
        break;
      case 704: {
        const r = children(expect(v, T.SEQUENCE));
        const state = BOOT[int(expect(r[2], T.ENUMERATED))];
        if (!state) throw new DerError("unknown boot state");
        list.rootOfTrust = { deviceLocked: bool(r[1] as Der), verifiedBootState: state };
        break;
      }
      case 705:
        list.osVersion = int(expect(v, T.INTEGER));
        break;
      case 706:
        list.osPatchLevel = int(expect(v, T.INTEGER));
        break;
      case 709:
        list.application = applicationId(content(expect(v, T.OCTET_STRING)));
        break;
      case 718:
        list.vendorPatchLevel = int(expect(v, T.INTEGER));
        break;
      case 719:
        list.bootPatchLevel = int(expect(v, T.INTEGER));
        break;
      default:
        break;
    }
  }
  return list;
}

/** AttestationApplicationId ::= SEQUENCE { SET OF { packageName OCTET STRING, version INTEGER }, SET OF OCTET STRING } */
function applicationId(bytes: Uint8Array): NonNullable<AuthorizationList["application"]> {
  const [infos, digests] = children(expect(parseOne(bytes), T.SEQUENCE));
  return {
    packages: children(expect(infos, T.SET)).map((p) => {
      const [name, version] = children(expect(p, T.SEQUENCE));
      return {
        name: new TextDecoder().decode(content(expect(name, T.OCTET_STRING))),
        version: int(expect(version, T.INTEGER)),
      };
    }),
    signatureDigests: children(expect(digests, T.SET)).map((d) =>
      hex(content(expect(d, T.OCTET_STRING))),
    ),
  };
}

function fromBase64(text: string): Uint8Array {
  if (text.length > 20_000) throw new DerError("certificate too large");
  const std = text.replaceAll("-", "+").replaceAll("_", "/").replace(/\s+/g, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
