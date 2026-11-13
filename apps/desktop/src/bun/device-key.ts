// The device key a presence proof is signed with (ADR 0391, 0394). On a release build with the key
// helper it lives in the Secure Enclave, made and used by `SF Keys.app` (Contents/Helpers), the only
// process whose signed entitlements reach its keychain access group, and every signature asks for
// Touch ID. Where that isn't possible (an unsigned dev build, or a release without the helper) the
// app makes a software P-256 key, keeps it in the keychain and says so (`keyStorage: "software"`),
// so the website shows it and the engine refuses it for gate decisions.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
   * prompt shows the message's summary line; it takes no prompt text from here (ADR 0391).
   */
  sign(message: string): Promise<string>;
}

/** The helper's executable, from the app's Contents/MacOS (Electrobun's working directory). */
export const HELPER = resolve("../Helpers/SF Keys.app/Contents/MacOS/sf-keys");
const TAG = "com.software-factory.desktop.device-key";
const SOFTWARE_SERVICE = "com.software-factory.desktop.software-key";
const STORAGE_SERVICE = "com.software-factory.desktop.key-storage";
/** A presence challenge's life (core's PRESENCE_TTL_MS; test/device-key.test.ts checks they agree). */
export const PRESENCE_TTL_MS = 60_000;
/** After SIGTERM, the helper has this long to take the sheet down before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** The helper's exit codes (spec 40 M4b) and what the app says for each. */
export const HELPER_EXITS: Record<number, { code: string; message: string }> = {
  2: { code: "usage", message: "The key helper refused the request (a tag it doesn't know)." },
  3: { code: "no_key", message: "This Mac's key is gone. Sign out and sign in again." },
  4: { code: "cancelled", message: "Touch ID was cancelled. Nothing was decided." },
  5: { code: "refused", message: "The key helper refused to sign: not a presence message." },
  6: {
    code: "auth_failed",
    message: "Touch ID failed or is locked out. Unlock with your password, then try again.",
  },
};

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number | null,
  ) {
    super(message);
  }
}

/** The error for a helper that exited with `exit` (or was killed), in the app's words. */
export function helperError(exit: number | null, stderr: string, expired = false): HelperError {
  if (expired)
    return new HelperError(
      "expired",
      "Touch ID wasn't answered in time. Nothing was decided.",
      exit,
    );
  const known = exit === null ? undefined : HELPER_EXITS[exit];
  if (known) return new HelperError(known.code, known.message, exit);
  const detail = stderr.trim() || (exit === null ? "it was killed" : `exit ${exit}`);
  return new HelperError("failed", `The key helper failed: ${detail}`, exit);
}

export interface Spawned {
  exited: Promise<number | null>;
  stdout: Promise<string>;
  stderr: Promise<string>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}
export type Spawn = (args: string[]) => Spawned;

const bunSpawn: Spawn = (args) => {
  const proc = Bun.spawn([HELPER, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exited: proc.exited.then(() => (proc.signalCode ? null : proc.exitCode)),
    stdout: new Response(proc.stdout).text(),
    stderr: new Response(proc.stderr).text(),
    kill: (signal) => proc.kill(signal),
  };
};

/** What the person sees while the helper waits for Touch ID, and how the app stops it. */
export interface TouchIdWatcher {
  waiting(summary: string | null): void;
}

/**
 * Runs the helper's commands. At most one `sign` at a time (a second decision while one waits is
 * refused), each killed when its challenge expires or the person cancels in the app: SIGTERM, which
 * the helper turns into `LAContext.invalidate()` (the sheet goes away), then SIGKILL after 2 s.
 */
export class Helper {
  private current: { summary: string; stop: () => void } | null = null;

  constructor(
    private readonly spawn: Spawn = bunSpawn,
    private watcher: TouchIdWatcher = { waiting: () => undefined },
    private readonly ttlMs: number = PRESENCE_TTL_MS,
  ) {}

  /** Who hears "waiting for Touch ID" (the view, the menu). */
  watch(watcher: TouchIdWatcher): void {
    this.watcher = watcher;
  }

  /** The summary of the decision waiting for Touch ID, or null. */
  get waitingFor(): string | null {
    return this.current?.summary ?? null;
  }

  async run(args: string[]): Promise<string> {
    const p = this.spawn(args);
    const [exit, out, err] = await Promise.all([p.exited, p.stdout, p.stderr]);
    if (exit !== 0) throw helperError(exit, err);
    return out.trim();
  }

  async sign(tag: string, message: string): Promise<string> {
    if (this.current)
      throw new HelperError("busy", "Another approval is waiting for Touch ID.", null);
    // The prompt's words, as the helper builds them: the message's own last line.
    const summary = message.slice(message.lastIndexOf("\n") + 1);
    const p = this.spawn(["sign", tag, Buffer.from(message).toString("base64")]);
    let expired = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      p.kill("SIGTERM");
      killer ??= setTimeout(() => p.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, this.ttlMs);
    this.current = { summary, stop };
    this.watcher.waiting(summary);
    try {
      const [exit, out, err] = await Promise.all([p.exited, p.stdout, p.stderr]);
      if (exit !== 0) throw helperError(exit, err, expired);
      return out.trim();
    } finally {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      this.current = null;
      this.watcher.waiting(null);
    }
  }

  /** The person cancelled in the app: take the Touch ID sheet down. */
  cancel(): boolean {
    if (!this.current) return false;
    this.current.stop();
    return true;
  }

  /**
   * Whether this build's helper works: present, launched (not killed by macOS), and able to ask in
   * its keychain group (`public` finds a key, 0, or none, 3).
   */
  async works(): Promise<boolean> {
    if (!existsSync(HELPER)) return false;
    try {
      await this.run(["public", TAG]);
      return true;
    } catch (error) {
      return error instanceof HelperError && error.exit === 3;
    }
  }
}

export const helper = new Helper();

function enclaveKey(publicKey: PublicJwk): DeviceKey {
  return {
    storage: "secure-enclave",
    publicKey,
    // No prompt text: the helper shows the message's own summary line (ADR 0391).
    sign: (message) => helper.sign(TAG, message),
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
      return enclaveKey(JSON.parse(await helper.run(["public", TAG])) as PublicJwk);
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

/**
 * A new device key: the Secure Enclave when the build has a working helper, else a declared
 * software key. `create` replaces any key under the tag (an orphan from a downgrade included), and
 * never prompts.
 */
export async function createDeviceKey(): Promise<DeviceKey> {
  if (existsSync(HELPER)) {
    try {
      const publicKey = JSON.parse(await helper.run(["create", TAG])) as PublicJwk;
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
  if (existsSync(HELPER)) await helper.run(["delete", TAG]).catch(() => undefined);
  deleteSecret(SOFTWARE_SERVICE);
  deleteSecret(STORAGE_SERVICE);
}

/**
 * The key's fingerprint, as the website's approval page shows it (`keyFingerprint` in
 * packages/core): the first 16 hex of SHA-256 over `x.y`, in groups of four.
 */
export async function keyFingerprint(jwk: PublicJwk): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${jwk.x}.${jwk.y}`));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16).replace(/(.{4})(?!$)/g, "$1-");
}
