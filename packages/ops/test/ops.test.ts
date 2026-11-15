import { env } from "cloudflare:workers";
import { expect, describe as group, it } from "vitest";
import { type CallResult, call, describe } from "../src/index.ts";

const d1 = env.DB;

/** An org with one member, as core_member has it (the old core's identity tables). */
async function org() {
  const orgId = `org_${crypto.randomUUID()}`;
  const userId = `usr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
      )
      .bind(userId, `${userId}@example.com`, now, now),
    d1
      .prepare(
        "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'Acme', ?, 'team', ?)",
      )
      .bind(orgId, orgId, now),
    d1
      .prepare(
        "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      )
      .bind(`mem_${crypto.randomUUID()}`, orgId, userId, now),
  ]);
  const as = (op: string, input: Record<string, unknown>) =>
    call(op, { orgId, ...input }, { d1, actor: { kind: "person", id: userId } });
  return { orgId, userId, as };
}

function ok<T = Record<string, unknown>>(r: CallResult): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

/** Writer (agent) → Review (the member) → Done, a project on it, and an item in Writer's status. */
async function world() {
  const o = await org();
  const agent = ok<{ id: string }>(
    await o.as("flow.agent.create", { name: "Writer", instructions: "Write well." }),
  );
  const workflow = ok<{ id: string }>(
    await o.as("flow.workflow.create", {
      name: "Draft, review, done",
      statuses: [
        {
          id: "draft",
          name: "Draft",
          owner: { kind: "agent", agentId: agent.id },
          brief: "Draft it.",
        },
        { id: "review", name: "Review", owner: { kind: "person", userId: o.userId } },
        { id: "done", name: "Done", owner: { kind: "none" } },
      ],
    }),
  );
  const project = ok<{ id: string }>(
    await o.as("flow.project.create", { name: "Acme", key: "ACM", workflowId: workflow.id }),
  );
  const item = ok<{ id: string; statusId: string }>(
    await o.as("flow.item.create", {
      projectId: project.id,
      title: "Launch post",
      body: "Say it.",
    }),
  );
  return { ...o, agent, workflow, project, item };
}

group("flow operations", () => {
  it("are all named flow.*, with descriptions", () => {
    const ops = describe();
    // 40 with Chat's, Auto's four flow.schedule.* operations, flow.project.setRepository and
    // flow.github.repos.
    expect(ops.length).toBe(46);
    for (const op of ops) {
      expect(op.name).toMatch(/^flow\./);
      expect(op.description.length).toBeGreaterThan(10);
    }
  });

  it("refuses a caller who isn't a member of the org", async () => {
    const w = await world();
    const stranger = await org();
    const r = await call(
      "flow.workflow.list",
      { orgId: w.orgId },
      { d1, actor: { kind: "person", id: stranger.userId } },
    );
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("won't read or move an item in another org, even for a member of both", async () => {
    const w = await world();
    const other = await org();
    // A member of `other`, naming w's item under other's org id.
    const read = await other.as("flow.item.get", { itemId: w.item.id });
    expect(read).toMatchObject({ ok: false, error: { code: "not_found" } });
    const move = await other.as("flow.item.move", { itemId: w.item.id, to: "done" });
    expect(move).toMatchObject({ ok: false, error: { code: "not_found" } });
    // Nor name another org's agent as a status's owner.
    const wf = await other.as("flow.workflow.create", {
      name: "Borrowed",
      statuses: [{ id: "a", name: "A", owner: { kind: "agent", agentId: w.agent.id } }],
    });
    expect(wf).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      ok<{ statusId: string }>(await w.as("flow.item.get", { itemId: w.item.id })).statusId,
    ).toBe("draft");
  });

  it("answers bad input, an unknown operation and a kernel refusal with their codes", async () => {
    const w = await world();
    expect(await w.as("flow.item.create", { projectId: w.project.id })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await w.as("flow.nope", {})).toMatchObject({
      ok: false,
      error: { code: "unknown_operation" },
    });
    const broken = await w.as("flow.workflow.create", {
      name: "Broken",
      statuses: [{ id: "a", name: "A", owner: { kind: "none" }, onDone: "nowhere" }],
    });
    expect(broken).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // The item waits on a run, not a person: finishing it doesn't fit.
    expect(await w.as("flow.item.finish", { itemId: w.item.id, outcome: "done" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("creates a workflow, project, agent and item, and the owner finishes it", async () => {
    const w = await world();
    expect(w.item.statusId).toBe("draft");
    const runs = ok<{ runs: { status: string; brief: string }[] }>(
      await w.as("flow.run.list", { itemId: w.item.id }),
    );
    expect(runs.runs).toEqual([expect.objectContaining({ status: "queued", brief: "Draft it." })]);

    // A person moves it on to Review by hand: it's now in their inbox.
    ok(await w.as("flow.item.move", { itemId: w.item.id, to: "review" }));
    const inbox = ok<{ work: { id: string }[] }>(await w.as("flow.inbox.get", {}));
    expect(inbox.work.map((i) => i.id)).toEqual([w.item.id]);

    ok(await w.as("flow.item.comment", { itemId: w.item.id, text: "Looks good." }));
    const done = ok<{ statusId: string }>(
      await w.as("flow.item.finish", { itemId: w.item.id, outcome: "done" }),
    );
    expect(done.statusId).toBe("done");
    const view = ok<{ columns: { status: { id: string }; items: { id: string }[] }[] }>(
      await w.as("flow.board.get", { projectId: w.project.id }),
    );
    expect(view.columns.map((c) => [c.status.id, c.items.length])).toEqual([
      ["draft", 0],
      ["review", 0],
      ["done", 1],
    ]);
    const tl = ok<{ entries: { kind: string; data: { type?: string; text?: string } }[] }>(
      await w.as("flow.timeline.get", { itemId: w.item.id }),
    );
    expect(tl.entries.filter((e) => e.kind === "event").map((e) => e.data.type)).toEqual([
      "created",
      "moved",
      "person.finished",
    ]);
    expect(tl.entries.some((e) => e.data.text === "Looks good.")).toBe(true);
    expect(
      ok<{ workflows: unknown[] }>(await w.as("flow.workflow.list", {})).workflows,
    ).toHaveLength(1);
  });
});
