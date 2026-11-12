// Spec 52, build plan PR (b): org workflows as versioned config. Org admins edit them and approve
// a loosening (Q6); built-in workflows are visible and tighten-only (Q10).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InvokeResult } from "../src/index.ts";
import { SOFTWARE, type WorkflowDefinition, workflowImpact } from "../src/stages/index.ts";
import { call, first, ok, refusal, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;
type Listed = {
  version: number;
  workflows: { id: string; builtIn: string | null; stages: { id: string }[] }[];
  templates: { id: string }[];
};

const list = (w: W) => ok<Listed>("workflow.list", { orgId: w.orgId }, w.human);
const version = async (w: W) => (await list(w)).version;

async function fromTemplate(w: W, name = "Ship it") {
  return ok<{ version: number; workflowId: string }>(
    "workflow.createFromTemplate",
    { orgId: w.orgId, baseVersion: await version(w), templateId: SOFTWARE.id, name },
    w.human,
  );
}

async function getWorkflow(w: W, workflowId: string) {
  return ok<{ workflow: WorkflowDefinition; shipped: WorkflowDefinition | null }>(
    "workflow.get",
    { orgId: w.orgId, workflowId },
    w.human,
  );
}

async function save(w: W, workflow: WorkflowDefinition) {
  return call<{ version: number; impact: { class: string } }>(
    "workflow.save",
    { orgId: w.orgId, baseVersion: await version(w), workflow },
    w.human,
  );
}

const pid = (r: InvokeResult<unknown>) => {
  if (r.status !== "pending") throw new Error(`expected pending, got ${r.status}`);
  return r.pendingActionId;
};

/** A member who isn't an admin. */
async function member(w: W) {
  const userId = `usr_m${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(userId, "Member", `${userId}@example.com`, `gh-${userId}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
    ).bind(`mem_${userId}`, w.orgId, userId, now),
  ]);
  return { type: "human" as const, id: userId };
}

describe("org workflows (spec 52 PR (b))", () => {
  it("an org starts with no workflows of its own, the built-ins and the Software template", async () => {
    const w = await world();
    const got = await list(w);
    expect(got.version).toBe(0);
    expect(got.workflows.map((x) => `${x.id}:${x.builtIn}`)).toEqual([
      "wf_incident:incident",
      "wf_attached_pr:attached",
    ]);
    expect(got.templates.map((t) => t.id)).toEqual([SOFTWARE.id]);
  });

  it("copies a template into the org, and a tightening save applies at once", async () => {
    const w = await world();
    const made = await fromTemplate(w);
    expect(made).toMatchObject({ version: 1, workflowId: "wf_ship_it" });
    const { workflow } = await getWorkflow(w, made.workflowId);
    expect(workflow.stages.find((s) => s.id === "spec")?.settings).toMatchObject({
      requiredFrom: "medium",
    });
    const tighter = {
      ...workflow,
      stages: workflow.stages.map((s) =>
        s.id === "spec"
          ? { ...s, settings: { ...(s.settings as object), requiredFrom: "small" } }
          : s,
      ),
    };
    const r = await save(w, tighter);
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.output).toMatchObject({
      version: 2,
      impact: { class: "tightens" },
    });
  });

  it("holds a loosening save for an org admin, and applies it once approved", async () => {
    const w = await world();
    const made = await fromTemplate(w);
    const { workflow } = await getWorkflow(w, made.workflowId);
    const looser = { ...workflow, stages: workflow.stages.filter((s) => s.id !== "verify") };
    // Removing Checks before a merge breaks the floors (the merge has no PR to act on): refused,
    // never held for approval.
    const invalid = await refusal(save(w, looser));
    expect(invalid.code).toBe("invalid_input");
    expect(invalid.message).toContain("F5");

    const noSpecGate = {
      ...workflow,
      stages: workflow.stages.map((s) =>
        s.id === "spec"
          ? { ...s, settings: { ...(s.settings as object), requiredFrom: "large" } }
          : s,
      ),
    };
    const r = await save(w, noSpecGate);
    expect(r.status).toBe("pending");
    const pa = await first<{ risk: string; org_id: string; project_id: string | null }>(
      "SELECT risk, org_id, project_id FROM core_pending_actions WHERE id = ?",
      pid(r),
    );
    expect(pa).toEqual({ risk: "self-modify", org_id: w.orgId, project_id: null });
    const waiting = await ok<{ pending: { operation: string }[]; version: number }>(
      "orgConfig.get",
      { orgId: w.orgId },
      w.human,
    );
    expect(waiting.version).toBe(1);
    expect(waiting.pending.map((p) => p.operation)).toEqual(["workflow.save"]);

    await ok("approval.decide", { pendingActionId: pid(r), decision: "approved" }, w.human);
    const after = await ok<{ version: number; history: { impact: string | null }[] }>(
      "orgConfig.get",
      { orgId: w.orgId },
      w.human,
    );
    expect(after.version).toBe(2);
    expect(after.history[0]?.impact).toBe("loosens");
    expect((await getWorkflow(w, made.workflowId)).workflow.stages[1]?.settings).toMatchObject({
      requiredFrom: "large",
    });
  });

  it("only org admins edit; members read", async () => {
    const w = await world();
    const m = await member(w);
    expect((await ok<Listed>("workflow.list", { orgId: w.orgId }, m)).version).toBe(0);
    const refused = await refusal(
      call(
        "workflow.createFromTemplate",
        { orgId: w.orgId, baseVersion: 0, templateId: SOFTWARE.id, name: "Mine" },
        m,
      ),
    );
    expect(refused.code).toBe("forbidden");
  });

  it("refuses a stale base", async () => {
    const w = await world();
    await fromTemplate(w, "One");
    const stale = await refusal(
      call(
        "workflow.createFromTemplate",
        { orgId: w.orgId, baseVersion: 0, templateId: SOFTWARE.id, name: "Two" },
        w.human,
      ),
    );
    expect(stale.code).toBe("conflict");
  });

  it("previews a draft with every broken rule and its impact", async () => {
    const w = await world();
    const made = await fromTemplate(w);
    const { workflow } = await getWorkflow(w, made.workflowId);
    const broken = {
      ...workflow,
      stages: workflow.stages.map((s) => (s.id === "build" ? { ...s, agent: "Ghost" } : s)),
    };
    const p = await ok<{ valid: boolean; errors: { rule: string; stageId: string }[] }>(
      "workflow.preview",
      { orgId: w.orgId, workflow: broken },
      w.human,
    );
    expect(p.valid).toBe(false);
    expect(p.errors).toContainEqual(expect.objectContaining({ rule: "S3", stageId: "build" }));
    const fine = await ok<{ valid: boolean; impact: { class: string } }>(
      "workflow.preview",
      { orgId: w.orgId, workflow: { ...workflow, name: "Renamed" } },
      w.human,
    );
    expect(fine).toMatchObject({ valid: true, impact: { class: "neutral" } });
  });

  it("built-in workflows can be tightened, never loosened (Q10)", async () => {
    const w = await world();
    const { workflow, shipped } = await getWorkflow(w, "wf_attached_pr");
    expect(shipped?.id).toBe("wf_attached_pr");
    const tighter: WorkflowDefinition = {
      ...workflow,
      stages: [
        ...workflow.stages.slice(0, 2),
        {
          id: "sign-off",
          type: "decision",
          typeVersion: 1,
          name: "Sign-off",
          phase: "delivery",
          settings: {},
        },
        ...workflow.stages.slice(2),
      ],
    };
    const r = await save(w, tighter);
    expect(r.status).toBe("ok");
    expect(
      (await list(w)).workflows.find((x) => x.id === "wf_attached_pr")?.stages.map((s) => s.id),
    ).toEqual(["triage", "verify", "sign-off", "merge"]);
    // Taking the added gate out again is a loosening of the org's copy: refused, not held.
    const looser = await refusal(save(w, workflow));
    expect(looser.code).toBe("invalid_input");
    expect(looser.message).toContain("only be tightened");
    const archive = await refusal(
      call(
        "workflow.archive",
        { orgId: w.orgId, baseVersion: await version(w), workflowId: "wf_attached_pr" },
        w.human,
      ),
    );
    expect(archive.code).toBe("invalid_input");
  });

  it("rolls back to an earlier version; a loosening rollback waits for an admin", async () => {
    const w = await world();
    const made = await fromTemplate(w);
    const { workflow } = await getWorkflow(w, made.workflowId);
    const withGate: WorkflowDefinition = {
      ...workflow,
      stages: [
        ...workflow.stages.slice(0, 4),
        {
          id: "sign-off",
          type: "decision",
          typeVersion: 1,
          name: "Sign-off",
          phase: "delivery",
          settings: {},
        },
        ...workflow.stages.slice(4),
      ],
    };
    expect((await save(w, withGate)).status).toBe("ok");
    const r = await call(
      "orgConfig.rollback",
      { orgId: w.orgId, baseVersion: 2, toVersion: 1 },
      w.human,
    );
    expect(r.status).toBe("pending");
    await ok("approval.decide", { pendingActionId: pid(r), decision: "approved" }, w.human);
    expect(await version(w)).toBe(3);
    expect((await getWorkflow(w, made.workflowId)).workflow.stages.map((s) => s.id)).not.toContain(
      "sign-off",
    );
  });

  it("an org agent can be named by a stage, and one that breaks a workflow is refused", async () => {
    const w = await world();
    await ok(
      "agent.save",
      {
        orgId: w.orgId,
        baseVersion: 0,
        agent: {
          name: "Builder",
          role: "implement",
          tier: "light",
          instructions: "pnpm test first",
        },
      },
      w.human,
    );
    const made = await fromTemplate(w);
    const { workflow } = await getWorkflow(w, made.workflowId);
    const named = {
      ...workflow,
      stages: workflow.stages.map((s) => (s.id === "build" ? { ...s, agent: "Builder" } : s)),
    };
    const r = await save(w, named);
    expect(r.status === "ok" && r.output.impact.class).toBe("neutral");
    const broke = await refusal(
      call(
        "agent.save",
        {
          orgId: w.orgId,
          baseVersion: await version(w),
          agent: { name: "Builder", role: "review", tier: "light" },
        },
        w.human,
      ),
    );
    expect(broke.code).toBe("invalid_input");
    expect(broke.message).toContain("S3");
  });

  it("lists the stage types with their settings as JSON Schema", async () => {
    const w = await world();
    const got = await ok<{
      types: { id: string; settingsSchema: { type?: string }; defaults: object }[];
    }>("stageType.list", {}, w.human);
    expect(got.types.map((t) => t.id)).toContain("interview-planning");
    const planning = got.types.find((t) => t.id === "interview-planning");
    expect(planning?.settingsSchema.type).toBe("object");
    expect(planning?.defaults).toMatchObject({ requiredFrom: "medium" });
  });
});

describe("workflowImpact", () => {
  const stages = SOFTWARE.stages;
  const def = (s: WorkflowDefinition["stages"]): WorkflowDefinition => ({ ...SOFTWARE, stages: s });
  const gate = {
    id: "sign-off",
    type: "decision",
    typeVersion: 1,
    name: "Sign-off",
    phase: "delivery" as const,
    settings: {},
  };
  it("adding a gate tightens; removing it loosens", () => {
    const withGate = def([...stages.slice(0, 4), gate, ...stages.slice(4)]);
    expect(workflowImpact(SOFTWARE, withGate).class).toBe("tightens");
    expect(workflowImpact(withGate, SOFTWARE).class).toBe("loosens");
  });
  it("moving a gate later loosens; renaming is neutral", () => {
    const early = def([...stages.slice(0, 3), gate, ...stages.slice(3)]);
    const late = def([...stages.slice(0, 4), gate, ...stages.slice(4)]);
    expect(workflowImpact(early, late).class).toBe("loosens");
    expect(workflowImpact(SOFTWARE, { ...SOFTWARE, name: "Other" }).class).toBe("neutral");
  });
  it("skipping a check for some items loosens; a type change loosens", () => {
    const check = { ...gate, id: "look", type: "agent-check", agent: "Security" };
    const always = def([...stages.slice(0, 3), check, ...stages.slice(3)]);
    const sometimes = def([
      ...stages.slice(0, 3),
      { ...check, when: { domain: "auth" } },
      ...stages.slice(3),
    ]);
    expect(workflowImpact(always, sometimes).class).toBe("loosens");
    const swapped = def(stages.map((s) => (s.id === "verify" ? { ...s, type: "build" } : s)));
    expect(workflowImpact(SOFTWARE, swapped).class).toBe("loosens");
  });
});
