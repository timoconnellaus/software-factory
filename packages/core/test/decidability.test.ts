// Which operations a person may decide from a device, and how (spec 60 "Keeping behaviour in step",
// item 5; ADR 0391, 0470, 0541). The engine decides this; the clients only show it. Changing either
// list fails this test, so the change shows in the PR.
//
// For every browser-only operation (for the input that makes it browser-only), on `desktop` and
// `mobile`: "one tap" (no proof), "proof" (Touch ID or a fingerprint for that exact call) or
// "refused" (the website only). `question.answer` and `planning.answer` are one tap on the phone
// except for security, privacy and irreversible questions, which the handler sends back for a proof
// (apps/engine/test/mobile.test.ts covers those).
import { describe, expect, it } from "vitest";
import {
  type DeviceSurface,
  deviceDecidable,
  OPERATIONS,
  PHONE_REFUSES_PENDING,
  phoneMayDecidePending,
  presenceSurfaceAllowed,
} from "../src/index.ts";

type How = "one tap" | "proof" | "refused";

/** Inputs for operations whose browser-only check or decidability depends on the input. */
const INPUTS: Record<string, Record<string, unknown>[]> = {
  "approval.decide": [{ decision: "approved" }, { decision: "rejected" }],
  "chat.send": [{ interrupt: true }],
  "killSwitch.set": [{ on: false }],
};

function how(name: string, surface: DeviceSurface, input: Record<string, unknown>): How {
  const op = OPERATIONS.find((o) => o.name === name);
  if (!op) throw new Error(name);
  if (deviceDecidable(op, surface, input)) return "one tap";
  if (presenceSurfaceAllowed(op, surface)) return "proof";
  return "refused";
}

function table() {
  const rows: Record<string, { desktop: How; mobile: How }> = {};
  for (const op of OPERATIONS) {
    const inputs = INPUTS[op.name] ?? [{}];
    for (const input of inputs) {
      const browserOnly =
        op.browserOnly === true ||
        (typeof op.browserOnly === "function" && op.browserOnly(input as never));
      // Operations that take a proof without being browser-only check it themselves.
      if (!browserOnly && !op.presenceDecidable && !op.presenceSurfaces) continue;
      const key =
        inputs.length > 1 || INPUTS[op.name] ? `${op.name} ${JSON.stringify(input)}` : op.name;
      rows[key] = {
        desktop: how(op.name, "desktop", input),
        mobile: how(op.name, "mobile", input),
      };
    }
  }
  return rows;
}

describe("device decidability (ADR 0541 decision 5)", () => {
  it("pins what needs a proof and what is one tap, on the desktop and the phone", () => {
    expect(table()).toMatchInlineSnapshot(`
      {
        "agent.save": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "approval.decide {"decision":"approved"}": {
          "desktop": "proof",
          "mobile": "proof",
        },
        "approval.decide {"decision":"rejected"}": {
          "desktop": "proof",
          "mobile": "one tap",
        },
        "chat.send {"interrupt":true}": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "cli.approveDevice": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "desktop.approveDevice": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "device.update": {
          "desktop": "proof",
          "mobile": "proof",
        },
        "killSwitch.set {"on":false}": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "mobile.approveDevice": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "mobile.denyDevice": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "mobile.pairOffer": {
          "desktop": "proof",
          "mobile": "refused",
        },
        "mobile.renew": {
          "desktop": "refused",
          "mobile": "proof",
        },
        "orgConfig.rollback": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "planning.acceptDefaults": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "planning.answer": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "planning.finishAlone": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "planning.pause": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "planning.resume": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "planning.stop": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "question.acceptDefaults": {
          "desktop": "proof",
          "mobile": "one tap",
        },
        "question.answer": {
          "desktop": "proof",
          "mobile": "one tap",
        },
        "review.merge": {
          "desktop": "proof",
          "mobile": "proof",
        },
        "review.sendBack": {
          "desktop": "proof",
          "mobile": "one tap",
        },
        "runner.approveDevice": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "runner.register": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "runner.rotateKey": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "spec.approve": {
          "desktop": "proof",
          "mobile": "proof",
        },
        "spec.edit": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "spec.releaseEdit": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "spec.requestChanges": {
          "desktop": "proof",
          "mobile": "one tap",
        },
        "workItem.markRepair": {
          "desktop": "proof",
          "mobile": "proof",
        },
        "workflow.archive": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "workflow.createFromTemplate": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "workflow.save": {
          "desktop": "refused",
          "mobile": "refused",
        },
      }
    `);
  });

  it("the phone refuses approval.decide for config changes and self-modify (until spec 60 PR 8)", () => {
    // The pending actions approval.decide can be about, and whether the phone may decide each. The
    // fingerprint prompt reads only "Approve config.save on #n" until it binds the version digest.
    const rows = [
      { operation: "config.save", risk: "self-modify" },
      { operation: "config.save", risk: "write" },
      { operation: "config.rollback", risk: "write" },
      { operation: "pr.merge", risk: "self-modify" },
      { operation: "pr.open", risk: "self-modify" },
      { operation: "pr.open", risk: "write" },
      { operation: "spec.accept", risk: "write" },
      { operation: "deploy.run", risk: "deploy" },
    ];
    expect(
      Object.fromEntries(
        rows.map((r) => [
          `${r.operation} (${r.risk})`,
          phoneMayDecidePending(r) ? "phone" : "refused",
        ]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "config.rollback (write)": "refused",
        "config.save (self-modify)": "refused",
        "config.save (write)": "refused",
        "deploy.run (deploy)": "phone",
        "pr.merge (self-modify)": "refused",
        "pr.open (self-modify)": "refused",
        "pr.open (write)": "phone",
        "spec.accept (write)": "phone",
      }
    `);
    expect(PHONE_REFUSES_PENDING).toMatch(/approve this on the desktop app or the website/);
  });
});
