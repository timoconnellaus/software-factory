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
  type HandlerContext,
  MERGE_NEEDS_COMMIT,
  OPERATIONS,
  OperationError,
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
  "orgConfig.adoptProjectWorkflows": [{ dryRun: false }, { dryRun: true }],
  "review.merge": [{}, { mergeWithoutChecks: true }],
};

function how(name: string, surface: DeviceSurface, input: Record<string, unknown>): How {
  const op = OPERATIONS.find((o) => o.name === name);
  if (!op) throw new Error(name);
  if (deviceDecidable(op, surface, input)) return "one tap";
  if (presenceSurfaceAllowed(op, surface, input)) return "proof";
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
          "desktop": "proof",
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
        "autopilot.disable": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "autopilot.enable": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "autopilot.save": {
          "desktop": "refused",
          "mobile": "refused",
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
          "desktop": "proof",
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
        "orgConfig.adoptProjectWorkflows {"dryRun":false}": {
          "desktop": "proof",
          "mobile": "refused",
        },
        "orgConfig.adoptProjectWorkflows {"dryRun":true}": {
          "desktop": "one tap",
          "mobile": "refused",
        },
        "orgConfig.rollback": {
          "desktop": "proof",
          "mobile": "refused",
        },
        "override.approve": {
          "desktop": "proof",
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
        "review.merge {"mergeWithoutChecks":true}": {
          "desktop": "proof",
          "mobile": "refused",
        },
        "review.merge {}": {
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
        "skill.accept": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "skill.archive": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "skill.attach": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "skill.detach": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "skill.reject": {
          "desktop": "refused",
          "mobile": "refused",
        },
        "skill.save": {
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
        "workItem.releaseChoice": {
          "desktop": "one tap",
          "mobile": "one tap",
        },
        "workflow.archive": {
          "desktop": "proof",
          "mobile": "refused",
        },
        "workflow.createFromTemplate": {
          "desktop": "proof",
          "mobile": "refused",
        },
        "workflow.save": {
          "desktop": "proof",
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

describe("a merge approval names its commit, on every surface (spec 60)", () => {
  // Without `headSha` an approval would be for whichever commit the gate is open for now, possibly
  // one the person never saw. Refused before anything is read, in plain words for the surface: an
  // old desktop build is told to update (door protocol 2, ADR 0393).
  const merge = OPERATIONS.find((o) => o.name === "review.merge");
  const refusal = async (surface: string) => {
    const ctx = { origin: { surface }, actor: { type: "human", id: "usr_1" } };
    try {
      // A bare context: the refusal comes before the handler touches anything.
      await merge?.handler(
        { workItemId: "wi_1", openedFullDiff: true, mergeWithoutChecks: false } as never,
        ctx as unknown as HandlerContext,
      );
    } catch (error) {
      if (error instanceof OperationError) return `${error.code}: ${error.message}`;
      throw error;
    }
    return "accepted";
  };

  it("refuses review.merge without headSha on the website, the desktop app and the phone", async () => {
    expect(await refusal("app")).toBe(`invalid_input: ${MERGE_NEEDS_COMMIT.app}`);
    expect(await refusal("desktop")).toBe(`invalid_input: ${MERGE_NEEDS_COMMIT.desktop}`);
    expect(await refusal("mobile")).toBe(`invalid_input: ${MERGE_NEEDS_COMMIT.mobile}`);
    expect(MERGE_NEEDS_COMMIT.desktop).toMatch(/Update the app/);
    expect(MERGE_NEEDS_COMMIT.app).toMatch(/Reload the page/);
  });
});
