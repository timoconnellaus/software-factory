// Every policy decision's summary would be signed by the key helper (review of #156, item 4): at
// most 300 characters, no control or format characters, the facts first and names last, cleaned,
// whatever a person or agent named things. And a software key never gets a challenge for one.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { invoke } from "../src/index.ts";
import { describeConfigDecision } from "../src/operations/config.ts";
import {
  describeKillSwitchOff,
  describeOrgConfigDecision,
  describeOverrideApprove,
} from "../src/operations/policy-summary.ts";
import { keyHelperRefusal } from "../src/testing/key-helper.ts";
import { deps, newItem, POLICY, world } from "./helpers.ts";

/** A name built to break a prompt: quotes, a soft hyphen, bidi and zero-width marks, a newline. */
const HOSTILE = `Acme "approved" \u00ad\u202eevil\u202c\u200b\nline ${"x".repeat(200)}`;

async function rename(w: Awaited<ReturnType<typeof world>>) {
  await env.DB.prepare("UPDATE core_organization SET name = ? WHERE id = ?")
    .bind(HOSTILE, w.orgId)
    .run();
  await env.DB.prepare("UPDATE core_projects SET name = ? WHERE id = ?")
    .bind(HOSTILE, w.projectId)
    .run();
}

const LONG_STAGE = `Stage ${"\u00ad".repeat(3)}"quoted" ${"y".repeat(150)}`;

describe("policy summaries the key helper signs (ADR 0610)", () => {
  it("are within its rules for every policy decision, with hostile names", async () => {
    const w = await world();
    await rename(w);
    const db = createDb(env.DB);
    const workflow = {
      schema: 1,
      id: "wf_hostile",
      name: HOSTILE,
      description: "",
      stages: [{ id: "build", type: "build", typeVersion: 1, name: LONG_STAGE, phase: "delivery" }],
    };
    const summaries = [
      await describeOrgConfigDecision(db, "workflow.save", {
        orgId: w.orgId,
        baseVersion: 0,
        workflow,
      }),
      await describeOrgConfigDecision(
        db,
        "agent.save",
        { orgId: w.orgId, baseVersion: 0, agent: { name: HOSTILE, role: "review" } },
        "Approve",
      ),
      await describeOrgConfigDecision(db, "workflow.archive", {
        orgId: w.orgId,
        baseVersion: 0,
        workflowId: "wf_hostile",
      }),
      await describeOrgConfigDecision(db, "workflow.createFromTemplate", {
        orgId: w.orgId,
        baseVersion: 0,
        templateId: 'wf_software"\u202e',
        name: HOSTILE,
      }),
      await describeOrgConfigDecision(db, "orgConfig.rollback", {
        orgId: w.orgId,
        baseVersion: 3,
        toVersion: 1,
      }),
      await describeOrgConfigDecision(db, "orgConfig.adoptProjectWorkflows", {
        orgId: w.orgId,
        baseVersion: 0,
        dryRun: false,
      }),
      await describeKillSwitchOff(db, { scope: "project", id: w.projectId, on: false }),
      await describeKillSwitchOff(db, { scope: "org", id: w.orgId, on: false }),
      await describeOverrideApprove(
        db,
        { ok: true, floor: {} } as const,
        {
          projectId: w.projectId,
          stageId: "spec\u202e",
          setting: "requiredFrom",
          value: HOSTILE,
          configVersion: 2,
          orgVersion: 3,
        },
        "medium",
      ),
      await describeConfigDecision(
        { db, floor: { ok: true, floor: {} } as const },
        {
          operation: "config.save",
          input: JSON.stringify({
            baseVersion: 1,
            policy: { ...POLICY, autonomyPolicy: "autonomous", approvers: [HOSTILE] },
          }),
          project_id: w.projectId,
        },
        "Approve",
      ),
    ];
    summaries.forEach((s, i) => {
      expect(s).toBeTruthy();
      expect(keyHelperRefusal(s as string), s as string).toBeNull();
      // The facts come first: no name (the hostile text) before the first quote. The override's
      // value is itself a fact (bound in the input), shown cleaned.
      if (i === 8) return;
      const quote = (s as string).indexOf('"');
      expect((s as string).slice(0, quote < 0 ? undefined : quote)).not.toContain("Acme");
    });
    // Long lists say how many, with the first.
    expect(summaries.at(-1)).toMatch(
      /^Approve a change to the policy \(drafted on v1, now v2\): loosens 5 things: Autonomy policy Balanced → Autonomous…/,
    );
    expect(summaries[8]).toMatch(
      /^Approve a looser override \(config v2, org v3\): loosens: an unnamed one requiredFrom from the org's medium to Acme approved evil line x+…/,
    );
  });

  it("an override of a long list says what it drops and adds (review of #185)", async () => {
    const w = await world();
    const db = createDb(env.DB);
    const long = Array.from({ length: 8 }, (_, i) => `integration-suite-${i}`);
    const summary = await describeOverrideApprove(
      db,
      { ok: true, floor: {} } as const,
      {
        projectId: w.projectId,
        stageId: "verify",
        setting: "requiredChecks",
        value: long.slice(0, 7),
        configVersion: 2,
        orgVersion: 3,
      },
      long,
    );
    expect(summary).toMatch(/requiredChecks: drops integration-suite-7 against the org's value/);
  });

  it("names the item and the red main for marking a repair, within the helper's rules", async () => {
    const w = await world();
    await rename(w);
    const item = await newItem(w, `Fix "the" \u202eflaky \u00adbuild ${"z".repeat(90)}`);
    const id = `dsk_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at, revoked_at) VALUES (?, ?, 'M5', 'key', 'secure-enclave', ?, NULL, NULL)",
    )
      .bind(id, w.userId, new Date().toISOString())
      .run();
    for (const repair of [true, false]) {
      const r = await invoke(
        deps,
        "presence.challenge",
        { op: "workItem.markRepair", input: { workItemId: item.workItemId, repair } },
        { actor: w.human, origin: { surface: "desktop", deviceId: id } },
      );
      if (r.status !== "ok") throw new Error(r.status);
      const summary = (r.output as { summary: string }).summary;
      expect(keyHelperRefusal(summary), summary).toBeNull();
      expect(summary).toMatch(
        repair
          ? /^Mark as a repair of red main .*: #\d+/
          : /^No longer a repair of red main .*: #\d+/,
      );
    }
  });

  it("a software key gets no challenge for a policy decision, whatever DESKTOP_ALLOW_SOFTWARE_KEYS says", async () => {
    const w = await world();
    const id = `dsk_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at, revoked_at) VALUES (?, ?, 'Dev Mac', 'key', 'software', ?, NULL, NULL)",
    )
      .bind(id, w.userId, new Date().toISOString())
      .run();
    // The dev allowance is on, as on an unsigned build.
    const devDeps = { ...deps, services: { ...deps.services, allowSoftwareDeviceKeys: true } };
    const challenge = (op: string, input: Record<string, unknown>) =>
      invoke(
        devDeps,
        "presence.challenge",
        { op, input },
        {
          actor: w.human,
          origin: { surface: "desktop", deviceId: id },
        },
      );
    const policy = await challenge("killSwitch.set", {
      scope: "project",
      id: w.projectId,
      on: false,
    }).catch((e: { code: string; message: string }) => e);
    expect(policy).toMatchObject({ code: "forbidden" });
    expect((policy as { message: string }).message).toMatch(
      /a policy decision never takes a software key/,
    );
    // A gate decision still gets one (the allowance is for those, on a dev build).
    const gate = await challenge("spec.approve", { workItemId: "wi_x" });
    expect(gate.status).toBe("ok");
  });
});
