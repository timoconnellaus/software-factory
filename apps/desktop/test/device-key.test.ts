// The app's side of the key helper (spec 40 M4b): one Touch ID prompt at a time, the helper killed
// when its challenge expires or the person cancels, each exit code its own message, and the
// fingerprint the website shows.
// keyFingerprint isn't in core's index; the source is the one the engine runs (after the index,
// which settles the registry's import cycle).
import "@software-factory/core";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRESENCE_TTL_MS as CORE_TTL,
  keyFingerprint as coreFingerprint,
} from "../../../packages/core/src/operations/desktop.ts";
import {
  HELPER_EXITS,
  Helper,
  HelperError,
  helperError,
  keyFingerprint,
  PRESENCE_TTL_MS,
  type Spawned,
} from "../src/bun/device-key.ts";

// The keychain is Security.framework over bun:ffi; nothing here reaches it.
vi.mock("../src/bun/keychain.ts", () => ({
  getSecret: () => null,
  setSecret: () => undefined,
  deleteSecret: () => undefined,
}));

const TAG = "com.software-factory.desktop.device-key";
const MESSAGE = 'n0nce\nreview.merge\nabc\nMerge 3f2a91c into main of acme/widgets: "Fix"';

/** A helper process the test finishes by hand. */
function fakeProcess() {
  let finish!: (exit: number | null, out?: string, err?: string) => void;
  const signals: string[] = [];
  const exited = new Promise<number | null>((resolve) => {
    finish = (exit, out = "", err = "") => {
      outResolve(out);
      errResolve(err);
      resolve(exit);
    };
  });
  let outResolve!: (s: string) => void;
  let errResolve!: (s: string) => void;
  const proc: Spawned = {
    exited,
    stdout: new Promise((r) => {
      outResolve = r;
    }),
    stderr: new Promise((r) => {
      errResolve = r;
    }),
    kill: (s) => {
      signals.push(s);
    },
  };
  return { proc, finish, signals };
}

describe("the key helper from the app", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("signs, saying what it waits for while it waits", async () => {
    const p = fakeProcess();
    const spawned: string[][] = [];
    const waiting: (string | null)[] = [];
    const helper = new Helper(
      (args) => {
        spawned.push(args);
        return p.proc;
      },
      { waiting: (s) => waiting.push(s) },
    );
    const sig = helper.sign(TAG, MESSAGE);
    expect(helper.waitingFor).toBe('Merge 3f2a91c into main of acme/widgets: "Fix"');
    p.finish(0, "c2ln\n");
    expect(await sig).toBe("c2ln");
    expect(spawned).toEqual([["sign", TAG, Buffer.from(MESSAGE).toString("base64")]]);
    expect(waiting).toEqual(['Merge 3f2a91c into main of acme/widgets: "Fix"', null]);
    expect(helper.waitingFor).toBeNull();
  });

  it("refuses a second decision while one waits for Touch ID", async () => {
    const p = fakeProcess();
    const helper = new Helper(() => p.proc);
    const first = helper.sign(TAG, MESSAGE);
    await expect(helper.sign(TAG, MESSAGE)).rejects.toMatchObject({
      code: "busy",
      message: "Another approval is waiting for Touch ID.",
    });
    p.finish(0, "x");
    await first;
  });

  it("kills the helper when the challenge expires: SIGTERM, then SIGKILL after 2 s", async () => {
    const p = fakeProcess();
    const helper = new Helper(() => p.proc);
    const sig = helper.sign(TAG, MESSAGE).catch((e) => e);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS);
    expect(p.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.signals).toEqual(["SIGTERM", "SIGKILL"]);
    p.finish(null);
    const error = await sig;
    expect(error).toBeInstanceOf(HelperError);
    expect(error.code).toBe("expired");
  });

  it("takes the sheet down when the person cancels in the app", async () => {
    const p = fakeProcess();
    const helper = new Helper(() => p.proc);
    const sig = helper.sign(TAG, MESSAGE).catch((e) => e);
    expect(helper.cancel()).toBe(true);
    expect(p.signals).toEqual(["SIGTERM"]);
    p.finish(4, "", "cancelled (SIGTERM)");
    expect((await sig).code).toBe("cancelled");
    expect(helper.cancel()).toBe(false);
  });

  it("maps every exit code to its own message", () => {
    const messages = new Set<string>();
    for (const exit of [2, 3, 4, 5, 6]) {
      const e = helperError(exit, "");
      expect(e.code).toBe(HELPER_EXITS[exit]?.code);
      messages.add(e.message);
    }
    messages.add(helperError(1, "OSStatus -34018").message);
    messages.add(helperError(null, "").message);
    messages.add(helperError(null, "", true).message);
    expect(messages.size).toBe(8);
    expect(helperError(1, "OSStatus -34018").message).toContain("-34018");
  });

  it("agrees with core on the challenge's life and the key fingerprint", async () => {
    expect(PRESENCE_TTL_MS).toBe(CORE_TTL);
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: "p6WEsU20lHy_OPoTyDkA",
      y: "fptoeFxulChfmDg8Sc30",
    } as const;
    expect(await keyFingerprint(jwk)).toBe(await coreFingerprint(jwk));
    expect(await keyFingerprint(jwk)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });
});
