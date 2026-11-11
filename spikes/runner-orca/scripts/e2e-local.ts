// The same end-to-end job as e2e-orca.ts, through the same host and fake cloud, on runner-local
// (git worktree + headless `claude -p`). Shows the contract carries no Orca-specific parts.
//
//   pnpm e2e:local           (needs `claude` on PATH, logged in)

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerChannelKey } from "../src/contract/channel.ts";
import { httpControlPlane } from "../src/contract/protocol.ts";
import type { Job } from "../src/contract/types.ts";
import { hostTick } from "../src/host/driver.ts";
import { createFakeCloud } from "../src/host/fake-cloud.ts";
import { createLocalRunner } from "../src/runner-local/adapter.ts";

const RUNNER = "r_locale2e01";
const LINE = "hello from runner-local";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const root = await mkdtemp(join(tmpdir(), "sf-e2e-local-"));
const repo = join(root, "repo");
execFileSync("mkdir", ["-p", repo]);
git(repo, "init", "-q", "-b", "main");
await writeFile(join(repo, "README.md"), "# scratch\n");
git(repo, "add", ".");
git(repo, "-c", "user.name=sf", "-c", "user.email=sf@example.invalid", "commit", "-qm", "init");

const jobId = `job_${Date.now().toString(36)}`;
const job: Job = {
  jobId,
  workItemId: "wi_e2e",
  attempt: 1,
  stage: "implement",
  repo: { url: "file://scratch", baseRef: "main" },
  branch: `sf/${jobId}`,
  harness: {
    id: "claude-code",
    prompt: `Append the line '${LINE}' to README.md using the Edit tool. Do not commit and do not change anything else.`,
  },
  requires: ["headless"],
  output: "diff",
  limits: { sessionTimeoutMs: 5 * 60_000 },
  lease: { leaseId: "lease_e2e", expiresAt: new Date(Date.now() + 600_000).toISOString() },
};

const cloud = createFakeCloud();
cloud.queue.push(job);
const cp = httpControlPlane({
  baseUrl: "https://factory.invalid",
  runnerId: RUNNER,
  key: await runnerChannelKey(cloud.masterSecret, RUNNER),
  fetch: cloud.fetch,
});
const adapter = createLocalRunner({
  resolveRepoPath: () => repo,
  worktreeRoot: join(root, "worktrees"),
});

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const result = await hostTick(
    adapter,
    cp,
    { running: new Map() },
    {
      onEvent: (e) => {
        const { jobId: _j, at: _a, ...rest } = e;
        const text = JSON.stringify(rest);
        console.log(`  event ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
      },
    },
  );
  check(
    result?.outcome === "completed",
    `outcome completed (got ${result?.outcome}; ${result?.error ?? "no error"})`,
  );
  const diff = [...cloud.artifacts.values()].find((a) => a.kind === "diff");
  check(diff?.kind === "diff" && diff.patch.includes(`+${LINE}`), "diff artifact adds the line");
  check(cloud.handbacks.get(jobId)?.outcome === "completed", "handback recorded by the cloud");
  check(git(repo, "worktree", "list").split("\n").length === 1, "git has only the main worktree");
  check(!git(repo, "branch", "--list", job.branch), "job branch deleted");
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
