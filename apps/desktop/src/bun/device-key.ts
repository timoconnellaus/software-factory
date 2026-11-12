// The device key a presence proof is signed with (ADR 0381). On a signed build it lives in the
// Secure Enclave, made and used by the bundled `sf-keys` helper, and every signature asks for
// Touch ID. Where that isn't possible (an unsigned dev build) the app makes a software P-256 key,
// keeps it in the keychain and says so (`keyStorage: "software"`), so the website shows it.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { deleteSecret, getSecret, setSecret } from "./keychain.ts";

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface DeviceKey {
  storage: "secure-enclave" | "software";
  publicKey: PublicJwk;
  /**
   * Signs a presence message. For the Secure Enclave key the helper asks for Touch ID and the
   * prompt shows the message's summary line; it takes no prompt text from here (ADR 0381).
   */
  sign(message: string): Promise<string>;
}

const HELPER = resolve("../Resources/app/native/sf-keys");
const TAG = "com.software-factory.desktop.device-key";
const SOFTWARE_SERVICE = "com.software-factory.desktop.software-key";
const STORAGE_SERVICE = "com.software-factory.desktop.key-storage";

async function helper(args: string[]): Promise<string> {
  const proc = Bun.spawn([HELPER, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `sf-keys ${args[0]} failed`);
  return out.trim();
}

function enclaveKey(publicKey: PublicJwk): DeviceKey {
  return {
    storage: "secure-enclave",
    publicKey,
    // No prompt text: the helper shows the message's own summary line (ADR 0381).
    sign: (message) => helper(["sign", TAG, Buffer.from(message).toString("base64")]),
  };
}

async function softwareKey(privateJwk: JsonWebKey): Promise<DeviceKey> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return {
    storage: "software",
    publicKey: { kty: "EC", crv: "P-256", x: String(privateJwk.x), y: String(privateJwk.y) },
    async sign(message) {
      const sig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new TextEncoder().encode(message),
      );
      return Buffer.from(sig).toString("base64");
    },
  };
}

/** The existing device key, or null before the first sign-in. */
export async function loadDeviceKey(): Promise<DeviceKey | null> {
  const storage = getSecret(STORAGE_SERVICE);
  if (storage === "secure-enclave" && existsSync(HELPER)) {
    try {
      return enclaveKey(JSON.parse(await helper(["public", TAG])) as PublicJwk);
    } catch {
      return null;
    }
  }
  if (storage === "software") {
    const jwk = getSecret(SOFTWARE_SERVICE);
    return jwk ? softwareKey(JSON.parse(jwk) as JsonWebKey) : null;
  }
  return null;
}

/** A new device key: the Secure Enclave when the build allows it, else a declared software key. */
export async function createDeviceKey(): Promise<DeviceKey> {
  if (existsSync(HELPER)) {
    try {
      const publicKey = JSON.parse(await helper(["create", TAG])) as PublicJwk;
      setSecret(STORAGE_SERVICE, "secure-enclave");
      deleteSecret(SOFTWARE_SERVICE);
      return enclaveKey(publicKey);
    } catch (error) {
      console.warn(`Secure Enclave key unavailable, using a software key: ${String(error)}`);
    }
  }
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  setSecret(SOFTWARE_SERVICE, JSON.stringify(jwk));
  setSecret(STORAGE_SERVICE, "software");
  return softwareKey(jwk);
}

export async function forgetDeviceKey(): Promise<void> {
  if (existsSync(HELPER)) await helper(["delete", TAG]).catch(() => undefined);
  deleteSecret(SOFTWARE_SERVICE);
  deleteSecret(STORAGE_SERVICE);
}

export const helperPath = () => join(HELPER);
