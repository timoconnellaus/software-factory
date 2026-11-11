// End to end: a throwaway git repo, the fake cloud serving the real signed channel, the generic
// host claiming a job, and runner-orca running Claude Code in an Orca worktree to add a line to
// README.md. Then it checks that the diff came back and that everything Orca made is gone.
//
//   pnpm e2e:orca            (needs Orca running and `orca` on PATH)

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runnerChannelKey } from "../src/contract/channel.ts";
import { httpControlPlane } from "../src/contract/protocol.ts";
import type { Job } from "../src/contract/types.ts";
import { createFakeCloud } from "../src/host/fake-cloud.ts";
import { hostTick } from "../src/host/runner-host.ts";
import { createOrcaRunner, JOB_COMMENT_PREFIX } from "../src/runner-orca/adapter.ts";
import { orcaCli } from "../src/runner-orca/orca-cli.ts";

const RUNNER = "r_orcae2e01";
// E2E_TIMEOUT_MS=4000 cuts the session off mid-run to check that a timed-out job still cleans up.
const cutOff = Number(process.env.E2E_TIMEOUT_MS) || 0;
const expected = cutOff ? "timed_out" : "completed";
const LINE = "hello from runner-orca";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repo = await mkdtemp(join(tmpdir(), "sf-e2e-orca-"));
git(repo, "init", "-q", "-b", "main");
await writeFile(join(repo, "README.md"), "# scratch\n");
await writeFile(join(repo, "index.html"), "<!doctype html><h1>runner-orca evidence</h1>\n");
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
    prompt: `Append the line '${LINE}' to README.md. Do not commit and do not change anything else. Then stop.`,
  },
  requires: ["ui-takeover", "browser"],
  evidence: { screenshotUrls: [`file://${repo}/index.html`] },
  output: "diff",
  limits: { sessionTimeoutMs: cutOff || 5 * 60_000 },
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
const adapter = createOrcaRunner({ resolveRepoPath: () => repo, pollMs: 1500 });
const orca = orcaCli();

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const started = Date.now();
  const result = await hostTick(
    adapter,
    cp,
    { running: new Map() },
    {
      onEvent: (e) => {
        const { jobId: _j, at: _a, ...rest } = e;
        const text = JSON.stringify(rest);
        if (e.type === "log") return;
        console.log(`  event ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
      },
    },
  );
  console.log(`\njob finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  check(
    result?.outcome === expected,
    `outcome ${expected} (got ${result?.outcome}; ${result?.error ?? "no error"})`,
  );

  const diff = [...cloud.artifacts.values()].find((a) => a.kind === "diff");
  check(
    !!diff && (cutOff > 0 || (diff.kind === "diff" && diff.patch.includes(`+${LINE}`))),
    cutOff ? "diff artifact collected after the cut-off" : "diff artifact adds the line",
  );
  if (diff?.kind === "diff") console.log(diff.patch);
  const shot = [...cloud.artifacts.values()].find((a) => a.kind === "screenshot");
  const shotError = [...cloud.artifacts.values()].find(
    (a) => a.kind === "log" && a.name.startsWith("screenshot-error"),
  );
  check(
    !!shot,
    `screenshot artifact (browser capability)${shotError?.kind === "log" ? `: ${shotError.text}` : ""}`,
  );
  if (shot?.kind === "screenshot") {
    await writeFile(
      join(import.meta.dirname, "../.e2e-screenshot.png"),
      Buffer.from(shot.base64, "base64"),
    );
  }
  check(cloud.handbacks.get(jobId)?.outcome === expected, "handback recorded by the cloud");
  check(cloud.released.has(jobId), "release recorded by the cloud");
  const events = cloud.events.get(jobId) ?? [];
  check(
    events.every((e, i) => e.seq === i + 1),
    `events arrived in seq order (${events.length})`,
  );
  check(cloud.handled > 0, `cloud handled ${cloud.handled} signed calls`);

  // Cleanup checks: nothing the job made is left in Orca or git.
  const rows = await orca.worktreePs();
  check(!rows.some((r) => r.comment === `${JOB_COMMENT_PREFIX}${jobId}`), "Orca worktree removed");
  check(
    !rows.some((r) => r.path.startsWith(repo)),
    "no Orca workspace left under the scratch repo",
  );
  const repos = await orca.repoList();
  check(!repos.some((r) => r.path.includes("sf-e2e-orca-")), "scratch repo unregistered from Orca");
  check(git(repo, "worktree", "list").split("\n").length === 1, "git has only the main worktree");
  check(!git(repo, "branch", "--list", job.branch), "job branch deleted");
  const prepared = events.find((e) => e.type === "job.state" && e.detail?.includes(" on "));
  const worktreePath =
    prepared?.type === "job.state" ? prepared.detail?.split(" on ")[0] : undefined;
  check(
    !!worktreePath && !existsSync(dirname(worktreePath)),
    `no folder left at ${worktreePath ? dirname(worktreePath) : "?"}`,
  );
  const logs = events.filter((e) => e.type === "log").length;
  check(logs > 0 || cutOff > 0, `terminal output streamed as ${logs} log event(s)`);
} finally {
  // Belt and braces: if anything above threw before release, clean up here too.
  const rows = await orca.worktreePs().catch(() => []);
  for (const row of rows.filter((r) => r.comment === `${JOB_COMMENT_PREFIX}${jobId}`)) {
    await orca.terminalCloseAll(row.worktreeId).catch(() => {});
    await orca.worktreeRemove(row.worktreeId).catch(() => {});
  }
  const repos = await orca.repoList().catch(() => []);
  for (const r of repos.filter((r) => r.path.includes("sf-e2e-orca-"))) {
    await orca.repoForget(r.id).catch(() => {});
  }
  await rm(repo, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
