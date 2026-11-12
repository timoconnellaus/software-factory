// Claude accounts on a runner (ADR 0410, spec 32): the host reports names only, the owner picks
// one, and the pick rides on the heartbeat until the host reports it active.
import type { CapabilityManifest } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/index.ts";
import { call, first, ok, RUNNER_ACTOR, refusal, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};

type Accounts = {
  names: string[];
  active: string;
  limits: { name: string; at: string; message: string }[];
};
type Listed = {
  runners: { id: string; accounts: (Accounts & { requested: string | null }) | null }[];
};
type Beat = { commands: { kind: string; name?: string }[] };

const accounts = (active = "default", names = ["default", "work"]): Accounts => ({
  names,
  active,
  limits: [],
});

async function setup() {
  const w = await world();
  const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  return { w, runnerId: runner.runnerId, actor: RUNNER_ACTOR(runner.runnerId) };
}

const beat = (actor: Actor, report?: Accounts) =>
  ok<Beat>(
    "runner.heartbeat",
    {
      manifest,
      capacity: { max: 2, inUse: 0, accepting: true },
      activeJobs: [],
      ...(report ? { accounts: report } : {}),
    },
    actor,
  );

const listed = async (human: Actor, runnerId: string) =>
  (await ok<Listed>("runner.list", {}, human)).runners.find((r) => r.id === runnerId)?.accounts;

const use = (actor: Actor, runnerId: string, name: string) =>
  call("runner.account.use", { runnerId, name }, actor);

describe("Claude accounts on a runner (ADR 0410)", () => {
  it("records the names a runner reports and refuses a pick for a runner that reported none", async () => {
    const { w, runnerId, actor } = await setup();
    // An older runner: no accounts on its heartbeat.
    await beat(actor);
    expect(await listed(w.human, runnerId)).toBeNull();
    expect((await refusal(use(w.human, runnerId, "work"))).code).toBe("conflict");
    const at = new Date().toISOString();
    await beat(actor, {
      ...accounts(),
      limits: [{ name: "default", at, message: "You've hit your usage limit" }],
    });
    expect(await listed(w.human, runnerId)).toEqual({
      names: ["default", "work"],
      active: "default",
      requested: null,
      limits: [{ name: "default", at, message: "You've hit your usage limit" }],
    });
  });

  it("sends the owner's pick on every heartbeat until the runner reports it active, and journals it", async () => {
    const { w, runnerId, actor } = await setup();
    await beat(actor, accounts());
    const picked = await ok<{ requested: string; active: string }>(
      "runner.account.use",
      { runnerId, name: "work" },
      w.human,
    );
    expect(picked).toEqual({ runnerId, requested: "work", active: "default" });
    expect((await listed(w.human, runnerId))?.requested).toBe("work");
    // Not switched yet (a lost answer, a host between turns): asked again.
    expect((await beat(actor, accounts())).commands).toEqual([{ kind: "account.use", name: "work" }]);
    expect((await beat(actor)).commands).toEqual([{ kind: "account.use", name: "work" }]);
    // Switched: the pick is done.
    expect((await beat(actor, accounts("work"))).commands).toEqual([]);
    expect(await listed(w.human, runnerId)).toEqual(
      expect.objectContaining({ active: "work", requested: null }),
    );
    expect((await beat(actor, accounts("work"))).commands).toEqual([]);
    const audit = await first<{ input: string; diff: string | null }>(
      "SELECT input, diff FROM core_audit WHERE operation = 'runner.account.use' AND actor_id = ?",
      w.userId,
    );
    expect(JSON.parse(audit.input)).toEqual({ runnerId, name: "work" });
    expect(audit.diff ?? "").toContain("work");
  });

  it("picking the active account clears a pending pick", async () => {
    const { w, runnerId, actor } = await setup();
    await beat(actor, accounts());
    await ok("runner.account.use", { runnerId, name: "work" }, w.human);
    await ok("runner.account.use", { runnerId, name: "default" }, w.human);
    expect((await beat(actor, accounts())).commands).toEqual([]);
  });

  it("drops a pick the runner no longer has, and refuses an unknown or bad name, someone else's runner and a runner", async () => {
    const { w, runnerId, actor } = await setup();
    await beat(actor, accounts());
    expect((await refusal(use(w.human, runnerId, "nope"))).code).toBe("invalid_input");
    expect((await refusal(use(w.human, runnerId, "Bad Name"))).code).toBe("invalid_input");
    const other = await world();
    expect((await refusal(use(other.human, runnerId, "work"))).code).toBe("forbidden");
    expect((await refusal(use(actor, runnerId, "work"))).code).toBe("forbidden");
    await ok("runner.account.use", { runnerId, name: "work" }, w.human);
    // Removed on the host before it switched: the pick is dropped.
    expect((await beat(actor, accounts("default", ["default"]))).commands).toEqual([]);
    expect((await listed(w.human, runnerId))?.requested).toBeNull();
  });
});
