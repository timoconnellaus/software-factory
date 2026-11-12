import { env } from "cloudflare:workers";
import { type Actor, type InvokeResult, invoke } from "@software-factory/core";
import { fakeGitHub, fakeUserToken } from "@software-factory/core/testing";
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
} from "@software-factory/runner-contract";
import { invokeDeps } from "../src/deps.ts";

export const github = fakeGitHub(env.DB);

let n = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function call<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
): Promise<InvokeResult<O>> {
  return invoke<O>(invokeDeps(env), op, input, { actor, origin: { surface: "test" } });
}

export async function ok<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
): Promise<O> {
  const result = await call<O>(op, input, actor);
  if (result.status !== "ok") throw new Error(`${op} is pending`);
  return result.output;
}

export const MANIFEST: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "test",
  harnesses: ["claude-code"],
  // `checks`: the test runner plays a host that runs the project's checks (ADR 0501).
  capabilities: ["hooks", "headless", "checks"],
};

export const sha40 = (seed: string) =>
  seed
    .replace(/[^0-9a-f]/g, "a")
    .padEnd(40, "0")
    .slice(0, 40);

export const BALANCED = {
  version: 1,
  autonomyPolicy: "balanced",
  overrides: { agent: { outbound: "allow" } },
  retryLimit: 1,
};

export async function world(policy: unknown = BALANCED) {
  const userId = uid("usr_");
  const orgId = uid("org_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'Tim', ?, ?, ?, ?)",
    ).bind(userId, `${userId}@example.com`, `gh-${userId}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_organization (id, name, slug, kind, github_installation_id, created_at) VALUES (?, 'Personal', ?, 'personal', '42', ?)",
    ).bind(orgId, orgId, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(uid("mem_"), orgId, userId, now),
  ]);
  const human: Actor = { type: "human", id: userId };
  const repoName = uid("repo-");
  // Onboarded as Setup does it (ADR 0055): the App's installation, connected with a state, then
  // the repo picked by id.
  const installationId = `${Date.now() % 1_000_000_000}${n++}`;
  const repoId = Number(`${Date.now() % 1_000_000}${n++}`);
  await github.putInstallation({
    installationId,
    account: { login: "timoconnellaus", type: "Organization" },
    repos: [
      {
        id: repoId,
        owner: "timoconnellaus",
        name: repoName,
        private: false,
        defaultBranch: "main",
      },
    ],
    members: [`gh-${userId}`],
  });
  const started = await ok<{ state: string }>("github.connectStart", { orgId }, human);
  const connected = await ok<{ installation: { id: string } }>(
    "github.connectInstallation",
    { installationId, state: started.state, userAccessToken: fakeUserToken(`gh-${userId}`) },
    human,
  );
  const project = await ok<{ id: string }>(
    "project.create",
    { orgId, name: "Software factory", installationRecordId: connected.installation.id, repoId },
    human,
  );
  await ok(
    "policy.sync",
    {
      projectId: project.id,
      ref: "refs/heads/main",
      sha: sha40(uid("")),
      content: JSON.stringify(policy),
    },
    human,
  );
  const runner = await ok<{ runnerId: string; key: string }>(
    "runner.register",
    { name: "M5" },
    human,
  );
  const runnerActor: Actor = { type: "runner", id: runner.runnerId };
  const repo = { installationId, owner: "timoconnellaus", repo: repoName };
  return { userId, orgId, human, projectId: project.id, runner, runnerActor, repo };
}
export type World = Awaited<ReturnType<typeof world>>;

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
}

type Push = Parameters<typeof github.push>[3];

/** Plays the runner host for one job: claim the next job of `stage`, then hand back. */
/** What a test's runner does for a stage. `checks`: the host's check results, on the pushed head. */
interface StageOut {
  result?: unknown;
  outcome?: "completed" | "failed";
  push?: Push;
  checks?: {
    name: string;
    exitCode: number | null;
    command?: string;
    headSha?: string;
    round?: number;
    notRun?: string;
  }[];
}

export async function runStage(
  w: World,
  workItemId: string,
  stage: Job["stage"],
  result: (job: Job) => Promise<StageOut> | StageOut,
  options: { summary?: string } = {},
): Promise<Job> {
  await waitFor(`a queued ${stage} job`, () =>
    first(
      "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = ? AND status = 'queued'",
      workItemId,
      stage,
    ),
  );
  const claimed = await ok<{ job: Job | null }>(
    "job.claim",
    { claimId: uid("claim-"), manifest: MANIFEST, capacity: { max: 4, inUse: 0, accepting: true } },
    w.runnerActor,
  );
  const job = claimed.job;
  if (!job || job.stage !== stage)
    throw new Error(`expected a ${stage} job, got ${job?.stage ?? "none"}`);
  const out = await result(job);
  let headSha: string | undefined;
  if (out.push) {
    const base = (await github.getBranchSha(w.repo, job.repo.baseRef)) ?? undefined;
    headSha = await github.push(w.repo, job.branch, base, out.push);
  }
  await ok(
    "run.handBack",
    {
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: out.outcome ?? "completed",
      ...(options.summary ? { summary: options.summary } : {}),
      artifactIds: [],
      branch: job.branch,
      ...(headSha ? { headSha } : {}),
      ...(out.result !== undefined ? { result: out.result } : {}),
      ...(out.checks
        ? {
            checks: out.checks.map((c) => ({
              name: c.name,
              // The command the job carries for it (what the host runs), unless the test says.
              command:
                c.command ??
                job.checks?.commands.find((x) => x.name === c.name)?.run ??
                `pnpm ${c.name}`,
              exitCode: c.exitCode,
              ...(c.notRun ? { notRun: c.notRun } : {}),
              timedOut: false,
              durationMs: 1200,
              logTail: c.notRun
                ? `not run: ${c.notRun}`
                : c.exitCode === 0
                  ? "ok"
                  : `${c.name}: 1 failing`,
              headSha: c.headSha ?? headSha ?? String(job.context.headSha ?? ""),
              round: c.round ?? 0,
            })),
          }
        : {}),
    },
    w.runnerActor,
  );
  await ok(
    "run.release",
    { jobId: job.jobId, fencingToken: job.lease.fencingToken, finalState: "handed_back" },
    w.runnerActor,
  );
  return job;
}

export const triage = (
  size: "small" | "medium" | "large",
  extra: Record<string, unknown> = {},
) => ({
  result: {
    size,
    reason: `looks ${size}`,
    acceptanceCriteria: ["The page has a dark mode toggle"],
    ...extra,
  },
});
export const build = (files: Push = ["src/theme.ts"]) => ({
  result: { notes: "done" },
  push: files,
});
export const verifyPass = {
  result: {
    summary: "All good",
    checks: [
      { name: "tests", status: "pass" },
      { name: "lint", status: "pass" },
    ],
    criteria: [
      { criterion: "The page has a dark mode toggle", met: true, evidence: "test/theme.test.ts" },
    ],
    reviewer: { role: "review", verdict: "approve", notes: "Looks right" },
    riskFlags: [],
  },
};
/**
 * The reviewer finds a criterion unmet and reports a failing test. Where the project declares
 * checks the factory's own results replace the report (ADR 0501); the unmet criterion fails it
 * either way.
 */
export const verifyFail = {
  result: {
    ...verifyPass.result,
    checks: [{ name: "tests", status: "fail", detail: "1 failing" }],
    criteria: [
      {
        criterion: "The page has a dark mode toggle",
        met: false,
        evidence: "the toggle doesn't switch the theme",
      },
    ],
  },
};

export async function gateOpen(workItemId: string, kind: "spec" | "merge" | "approval") {
  return waitFor(`an open ${kind} gate`, () =>
    first<{ id: string }>(
      "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = ? AND status = 'pending'",
      workItemId,
      kind,
    ),
  );
}

export async function itemStatus(workItemId: string, status: string) {
  return waitFor(`work item ${status}`, () =>
    first<{ status: string }>(
      "SELECT status FROM core_work_items WHERE id = ? AND status = ?",
      workItemId,
      status,
    ),
  );
}
