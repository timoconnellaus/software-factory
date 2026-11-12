import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHostLock, HostLockedError } from "../src/host-lock.ts";

const dir = () => mkdtempSync(join(tmpdir(), "sf-host-lock-"));

describe("the runner host lock", () => {
  it("lets one host run and refuses a second while the first is alive", () => {
    const d = dir();
    const release = acquireHostLock(d);
    // The parent of this test process is alive and isn't us.
    expect(() => acquireHostLock(d, process.ppid)).toThrow(HostLockedError);
    release();
    const again = acquireHostLock(d, process.ppid);
    expect(readFileSync(join(d, "host.pid"), "utf8")).toBe(String(process.ppid));
    again();
  });

  it("takes over a lock left by a process that is gone", () => {
    const d = dir();
    writeFileSync(join(d, "host.pid"), "999999");
    const release = acquireHostLock(d);
    expect(readFileSync(join(d, "host.pid"), "utf8")).toBe(String(process.pid));
    release();
  });
});
