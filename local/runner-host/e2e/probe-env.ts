// Spec 03 criterion 8, on the real thing: run a job through runner-orca (real Orca, real Claude Code)
// against the in-memory signed cloud and ask the harness to report what it sees. Checks that the
// projected settings reached the session: no GitHub token, no SSH agent, git on the run's own config.
//
//   node --experimental-transform-types --no-warnings e2e/probe-env.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { createOrcaRunner, JOB_COMMENT_PREFIX, orcaCli } from "@software-factory/runner-orca";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeCloud, job, scratchRepo } from "../test/helpers.ts";

const repo = await scratchRepo();
const runs = await mkdtemp(join(tmpdir(), "sf-probe-runs-"));
const cloud = fakeCloud();
const cp = await controlPlane(cloud);
const j = job({
  stage: "verify",
  harness: {
    id: "claude-code",
    role: "review",
    prompt: [
      "This is an environment probe. Run exactly this one command with the Bash tool:",
      'echo "gh=[$GH_TOKEN] github=[$GITHUB_TOKEN] ssh=[$SSH_AUTH_SOCK] gcg=[$GIT_CONFIG_GLOBAL] nosys=[$GIT_CONFIG_NOSYSTEM] ghcfg=[$GH_CONFIG_DIR]"',
      `Then write its output, verbatim, as JSON { "summary": "<the output>", "checks": [], "criteria": [] } to ${RESULT_FILE} at the repository root. Do nothing else.`,
    ].join("\n"),
  },
  limits: { sessionTimeoutMs: 5 * 60_000 },
});
cloud.claims.set("probe", j);
const adapter = createOrcaRunner({
  resolveRepoPath: (x) => repo.host.clonePath(x),
  startPoint: (x) => repo.host.startPoint(x, repo.host.clonePath(x)),
  runsDir: runs,
  pollMs: 1500,
});
let failed = 0;
try {
  const report = await runJob({ adapter, cp, git: repo.host, job: j });
  const result = cloud.handbacks.get(j.jobId)?.result as { summary?: string } | undefined;
  const seen = result?.summary ?? "";
  console.log(`outcome ${report.outcome}; the harness saw: ${seen}`);
  const expect = (ok: boolean, what: string) => {
    console.log(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) failed++;
  };
  expect(report.outcome === "completed", "the probe completed");
  expect(seen.includes("gh=[]") && seen.includes("github=[]"), "no GitHub token in the harness");
  expect(seen.includes("ssh=[]"), "no SSH agent in the harness");
  expect(
    seen.includes(`gcg=[${join(runs, j.jobId, "gitconfig")}]`),
    "git uses the run's own global config",
  );
  expect(seen.includes("nosys=[1]"), "git ignores the system config (keychain helper)");
  expect(
    seen.includes(`ghcfg=[${join(runs, j.jobId, "empty", "gh")}]`),
    "gh points at an empty config dir",
  );
  const left = (await orcaCli().worktreePs()).filter(
    (r) => r.comment === `${JOB_COMMENT_PREFIX}${j.jobId}`,
  );
  expect(left.length === 0, "the Orca worktree is gone");
} finally {
  await repo.cleanup();
  await rm(runs, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
