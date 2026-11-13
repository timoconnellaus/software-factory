// ADR 0610: the policy decisions made decidable on the desktop (with a presence proof for exactly
// that call) stay refused everywhere else: an agent, a runner, the CLI, MCP and the phone, and the
// desktop without a proof. Whatever the input, nothing is decided and nothing is written.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Actor, invoke } from "../src/index.ts";
import { deps, FOREMAN, RUNNER_ACTOR, refusal, rows, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

/** A registered Mac (Secure Enclave) of this person's: a refusal is the proof's, not the device's. */
async function device(userId: string) {
  const id = `dsk_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at, revoked_at) VALUES (?, ?, 'M5', 'key', 'secure-enclave', ?, NULL, NULL)",
  )
    .bind(id, userId, new Date().toISOString())
    .run();
  return id;
}

const CALLS: [string, (w: W) => Record<string, unknown>][] = [
  ["workflow.save", (w) => ({ orgId: w.orgId, baseVersion: 0, workflow: {} })],
  [
    "workflow.createFromTemplate",
    (w) => ({ orgId: w.orgId, baseVersion: 0, templateId: "wf_software", name: "Mine" }),
  ],
  ["workflow.archive", (w) => ({ orgId: w.orgId, baseVersion: 0, workflowId: "wf_mine" })],
  [
    "agent.save",
    (w) => ({
      orgId: w.orgId,
      baseVersion: 0,
      agent: { name: "Reviewer", role: "review", tier: "standard", instructions: "" },
    }),
  ],
  ["orgConfig.rollback", (w) => ({ orgId: w.orgId, baseVersion: 0, toVersion: 1 })],
  ["orgConfig.adoptProjectWorkflows", (w) => ({ orgId: w.orgId, baseVersion: 0, dryRun: false })],
  [
    "override.approve",
    (w) => ({ projectId: w.projectId, stageId: "build", setting: "retryLimit", orgVersion: 1 }),
  ],
  ["killSwitch.set", (w) => ({ scope: "project", id: w.projectId, on: false })],
];

describe("policy decisions off the website and the desktop's proof (ADR 0610)", () => {
  it.each(CALLS)(
    "%s is refused to agents, runners, the CLI, MCP, the phone and a bare desktop",
    async (op, input) => {
      const w = await world();
      const before = await rows("SELECT id FROM core_audit WHERE outcome = 'ok'");
      const as = (actor: Actor, surface: string) =>
        invoke(deps, op, input(w), {
          actor,
          origin: {
            surface: surface as "cli",
            ...(surface === "desktop" ? { deviceId: "dsk_x" } : {}),
          },
        });
      for (const [actor, surface] of [
        [FOREMAN, "test"],
        [RUNNER_ACTOR("run_1"), "runner-channel"],
        [w.human, "cli"],
        [w.human, "mcp"],
        [w.human, "mobile"],
        [w.human, "desktop"],
      ] as const) {
        const e = await refusal(as(actor, surface));
        expect(e.code, `${op}: ${actor.type} on ${surface}`).toBe("forbidden");
      }
      const after = await rows("SELECT id FROM core_audit WHERE outcome = 'ok'");
      expect(after.length).toBe(before.length);
    },
  );

  it("a dry run of adopting projects' workflows decides nothing, so it needs no proof", async () => {
    const w = await world();
    const deviceId = await device(w.userId);
    const r = await invoke(
      deps,
      "orgConfig.adoptProjectWorkflows",
      { orgId: w.orgId, baseVersion: 0, dryRun: true },
      { actor: w.human, origin: { surface: "desktop", deviceId } },
    );
    expect(r.status).toBe("ok");
  });
});

describe("names in a proof's summary", () => {
  it("lose quotes and invisible characters, and are cut short", async () => {
    const { quotedName } = await import("../src/operations/policy-summary.ts");
    expect(quotedName('Acme"‮: approve all')).toBe('"Acme: approve all"');
    expect(quotedName("a​b\nc")).toBe('"ab c"');
    expect(quotedName("x".repeat(80))).toBe(`"${"x".repeat(59)}…"`);
  });
});
