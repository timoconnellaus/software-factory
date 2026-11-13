// The policy editor's rules (review of #145): a draft belongs to one project and one version, and a
// waiting change can be approved only once its classification and difference are on screen.
import { describe, expect, it, vi } from "vitest";
import { draftView } from "../src/mainview/components/config-editor.tsx";
import { cannotApprove } from "../src/mainview/components/config-parts.tsx";
import { isSoftwareKeyRefusal, SOFTWARE_KEY_TEXT } from "../src/mainview/lib/decisions.tsx";
import { OpError } from "../src/mainview/lib/op.ts";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const A = { version: 3, policy: { wipLimit: 3 } };

describe("draftView", () => {
  it("never shows one project's draft on another project at the same version", () => {
    const draft = { projectId: "prj_a", baseVersion: 3, doc: { wipLimit: 9 } };
    const onB = draftView(draft, "prj_b", { version: 3, policy: { wipLimit: 4 } });
    expect(onB).toMatchObject({ draft: null, dirty: false, doc: { wipLimit: 4 } });
    expect(draftView(draft, "prj_a", A)).toMatchObject({ dirty: true, moved: false });
  });

  it("keeps a draft whose version moved, and marks it to be reviewed", () => {
    const draft = { projectId: "prj_a", baseVersion: 3, doc: { wipLimit: 9 } };
    const moved = draftView(draft, "prj_a", { version: 4, policy: { wipLimit: 2 } });
    expect(moved).toMatchObject({ dirty: true, moved: true, doc: { wipLimit: 9 } });
  });
});

describe("cannotApprove", () => {
  const change = { baseVersion: 3, policy: { wipLimit: 9 } };
  it("allows Approve only once the change is classified and shown", () => {
    expect(cannotApprove(change, 3, "ready")).toBeNull();
    expect(cannotApprove(change, 3, "loading")).toMatch(/Classifying/);
    expect(cannotApprove(change, 3, "failed")).toMatch(/couldn't classify/);
  });
  it("refuses a change it can't show, or one drafted on another version", () => {
    expect(cannotApprove({ baseVersion: 3, policy: null }, 3, "ready")).toMatch(/can't be shown/);
    expect(cannotApprove(change, 4, "ready")).toMatch(/drafted against v3/);
  });
});

describe("a software key's refusal", () => {
  it("is recognised and told plainly", () => {
    const e = new OpError(
      "forbidden",
      "presence proof refused: this device's key isn't in the Secure Enclave (an unsigned build): decide on the website",
    );
    expect(isSoftwareKeyRefusal(e)).toBe(true);
    expect(isSoftwareKeyRefusal(new OpError("forbidden", "approvers only"))).toBe(false);
    expect(SOFTWARE_KEY_TEXT).toBe(
      "This Mac can't approve yet: its key isn't in the Secure Enclave. Update the app, then sign in again.",
    );
  });
});
