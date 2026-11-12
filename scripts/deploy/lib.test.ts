// node --test scripts/deploy/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deployArgs,
  deployOrder,
  findWorkers,
  migrationsOf,
  parseJsonc,
  resourcesOf,
  runnerPackageDirs,
  runnerSha,
  type Worker,
} from "./lib.ts";

const worker = (dir: string, config: Worker["config"]): Worker => ({ dir, config });

test("parseJsonc drops comments and trailing commas but keeps strings", () => {
  const text = `// top\n{ "a": "x // not a comment", /* b */ "b": [1, 2,], "c": "q\\"/*" ,}`;
  assert.deepEqual(parseJsonc(text), { a: "x // not a comment", b: [1, 2], c: 'q"/*' });
});

test("deployOrder puts service-binding targets first and ignores outside services", () => {
  const app = worker("apps/app", {
    name: "sf-app",
    services: [
      { binding: "ENGINE", service: "sf-engine" },
      { binding: "X", service: "elsewhere" },
    ],
  });
  const engine = worker("apps/engine", { name: "sf-engine" });
  assert.deepEqual(
    deployOrder([app, engine]).map((w) => w.config.name),
    ["sf-engine", "sf-app"],
  );
});

test("deployOrder rejects a cycle", () => {
  const a = worker("apps/a", { name: "a", services: [{ binding: "B", service: "b" }] });
  const b = worker("apps/b", { name: "b", services: [{ binding: "A", service: "a" }] });
  assert.throws(() => deployOrder([a, b]), /cycle/);
});

test("resourcesOf and migrationsOf deduplicate across Workers", () => {
  const db = { binding: "DB", database_name: "sf", migrations_dir: "../../packages/db/migrations" };
  const workers = [
    worker("apps/engine", {
      name: "sf-engine",
      d1_databases: [db],
      queues: { consumers: [{ queue: "sf-events", dead_letter_queue: "sf-events-dlq" }] },
    }),
    worker("apps/app", {
      name: "sf-app",
      d1_databases: [db],
      r2_buckets: [{ binding: "BLOBS", bucket_name: "sf-blobs" }],
      kv_namespaces: [{ binding: "CACHE" }, { binding: "PINNED", id: "abc" }],
      queues: { producers: [{ binding: "EVENTS", queue: "sf-events" }] },
    }),
  ];
  assert.deepEqual(resourcesOf(workers), {
    d1: ["sf"],
    r2: ["sf-blobs"],
    queues: ["sf-events", "sf-events-dlq"],
    kvAutoProvisioned: ["sf-app.CACHE"],
  });
  assert.deepEqual(migrationsOf(workers), [{ database: "sf", dir: "apps/engine" }]);
});

test("findWorkers finds every wrangler.jsonc under apps/, packages/ and local/", () => {
  const base = mkdtempSync(join(tmpdir(), "sf-deploy-"));
  for (const [dir, name] of [
    ["apps/app", "sf-app"],
    ["packages/connector-webhook", "sf-conn"],
    ["packages/core", null],
  ] as const) {
    mkdirSync(join(base, dir), { recursive: true });
    if (name) writeFileSync(join(base, dir, "wrangler.jsonc"), `// c\n{ "name": "${name}", }`);
  }
  assert.deepEqual(
    findWorkers(base).map((w) => w.dir),
    ["apps/app", "packages/connector-webhook"],
  );
});

test("the repo's own Workers include sf-app and sf-engine", () => {
  const names = findWorkers().map((w) => w.config.name);
  assert.ok(names.includes("sf-app"));
  assert.ok(names.includes("sf-engine"));
});

test("deployArgs passes the deployed commit only to a Worker that declares DEPLOYED_SHA", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(deployArgs({ name: "sf-engine", vars: { DEPLOYED_SHA: "" } }, sha), [
    "--var",
    `DEPLOYED_SHA:${sha}`,
  ]);
  assert.deepEqual(deployArgs({ name: "sf-app", vars: { X: "1" } }, sha), []);
  assert.deepEqual(deployArgs({ name: "sf-engine", vars: { DEPLOYED_SHA: "" } }, "not-a-sha"), []);
  assert.deepEqual(deployArgs({ name: "sf-engine", vars: { DEPLOYED_SHA: "" } }, null), []);
});

test("deployArgs passes the runner commit only to a Worker that declares RUNNER_SHA", () => {
  const sha = "a".repeat(40);
  const runner = "b".repeat(40);
  const engine = { name: "sf-engine", vars: { DEPLOYED_SHA: "", RUNNER_SHA: "" } };
  assert.deepEqual(deployArgs(engine, sha, runner), [
    "--var",
    `DEPLOYED_SHA:${sha}`,
    "--var",
    `RUNNER_SHA:${runner}`,
  ]);
  // Unknown runner commit: only DEPLOYED_SHA, so the engine hands out the deployed commit.
  assert.deepEqual(deployArgs(engine, sha, null), ["--var", `DEPLOYED_SHA:${sha}`]);
  assert.deepEqual(deployArgs(engine, sha, "nope"), ["--var", `DEPLOYED_SHA:${sha}`]);
  assert.deepEqual(deployArgs({ name: "sf-app", vars: { X: "1" } }, sha, runner), []);
});

/**
 * A scratch workspace shaped like this repo: the runner host and its packages, a package they
 * depend on, one only the engine uses, and one the host has as a devDependency.
 */
function scratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "sf-runner-sha-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const pkg = (folder: string, name: string, deps: Record<string, string> = {}, dev = {}) =>
    write(
      `${folder}/package.json`,
      JSON.stringify({ name, dependencies: deps, devDependencies: dev }, null, 2),
    );
  const commit = (message: string) => {
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
    return run("rev-parse", "HEAD");
  };
  run("init", "-q", "-b", "main");
  write(
    "pnpm-workspace.yaml",
    "packages:\n  - apps/*\n  - packages/*\n  - local/*\n  - presets\n\nonlyBuiltDependencies:\n  - esbuild\n",
  );
  write("package.json", "{}");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  pkg(
    "local/runner-host",
    "@x/runner-host",
    { "@x/runner-local": "workspace:*", zod: "4.0.0" },
    { "@x/config": "workspace:*" },
  );
  pkg("packages/runner-local", "@x/runner-local", { "@x/harness-claude": "workspace:*" });
  pkg("packages/harness-claude", "@x/harness-claude", { "@x/timeline": "workspace:^" });
  pkg("packages/timeline", "@x/timeline");
  pkg("packages/config", "@x/config");
  pkg("packages/core", "@x/core", { "@x/timeline": "workspace:*" });
  pkg("apps/engine", "@x/engine", { "@x/core": "workspace:*", "@x/runner-local": "workspace:*" });
  pkg("presets", "@x/presets");
  return { dir, run, write, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("runnerPackageDirs follows the runner's workspace dependencies, not devDependencies", (t) => {
  const w = scratchWorkspace();
  t.after(w.cleanup);
  assert.deepEqual(runnerPackageDirs(w.dir), [
    "local/runner-host",
    "packages/harness-claude",
    "packages/runner-local",
    "packages/timeline",
  ]);
});

test("the repo's own runner code includes the host, the contract and the harness", () => {
  const dirs = runnerPackageDirs();
  for (const d of ["local/runner-host", "packages/runner-contract", "packages/runner-local"]) {
    assert.ok(dirs.includes(d), d);
  }
  assert.ok(dirs.includes("packages/harness-claude"));
  for (const d of ["apps/engine", "apps/app", "packages/core"]) assert.ok(!dirs.includes(d), d);
});

test("runnerSha is the last first-parent commit on main that changed runner code", (t) => {
  const w = scratchWorkspace();
  t.after(w.cleanup);
  const first = w.commit("initial");
  assert.equal(runnerSha(first, w.dir), first);

  // Engine-only and devDependency-only changes don't move it.
  w.write("apps/engine/src.ts", "engine");
  const engine = w.commit("engine");
  assert.equal(runnerSha(engine, w.dir), first);
  w.write("packages/config/tsconfig.json", "{}");
  const tooling = w.commit("tooling");
  assert.equal(runnerSha(tooling, w.dir), first);
  // A lockfile change does: it can change what a runner installs.
  w.write("pnpm-lock.yaml", "lockfileVersion: 9\n# bumped\n");
  const lock = w.commit("lockfile");
  assert.equal(runnerSha(lock, w.dir), lock);

  // A package the runner depends on, two steps away, does.
  w.write("packages/timeline/index.ts", "v2");
  const timeline = w.commit("timeline");
  assert.equal(runnerSha(timeline, w.dir), timeline);
  // A revert of a runner change is a runner change: runners move forward onto it.
  w.run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "revert", "--no-edit", timeline);
  const reverted = w.run("rev-parse", "HEAD");
  assert.equal(runnerSha(reverted, w.dir), reverted);
  w.write("packages/core/index.ts", "core");
  const core = w.commit("core");
  assert.equal(runnerSha(core, w.dir), reverted);

  // A merged PR: the merge commit on main, never the branch's own commit.
  w.run("checkout", "-q", "-b", "feature");
  w.write("local/runner-host/src.ts", "host");
  const branchCommit = w.commit("host change");
  w.run("checkout", "-q", "main");
  w.write("apps/engine/src.ts", "engine 2");
  w.commit("engine 2");
  w.run(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "merge feature",
    "feature",
  );
  const merge = w.run("rev-parse", "HEAD");
  assert.equal(runnerSha(merge, w.dir), merge);
  assert.notEqual(runnerSha(merge, w.dir), branchCommit);
  w.write("apps/engine/src.ts", "engine 3");
  const after = w.commit("engine 3");
  assert.equal(runnerSha(after, w.dir), merge);

  // Root files that change what the runner installs count.
  w.write(".nvmrc", "24\n");
  const node = w.commit("node version");
  assert.equal(runnerSha(node, w.dir), node);
  // And it answers for the commit asked about, not HEAD.
  assert.equal(runnerSha(after, w.dir), merge);
});

test("runnerSha can't tell from a shallow clone, so the deploy falls back to the deployed commit", (t) => {
  const w = scratchWorkspace();
  t.after(w.cleanup);
  w.commit("initial");
  w.write("apps/engine/src.ts", "engine");
  const head = w.commit("engine");
  const shallow = mkdtempSync(join(tmpdir(), "sf-runner-shallow-"));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${w.dir}`, shallow]);
  assert.equal(runnerSha(head, shallow), null);
  assert.equal(runnerSha("f".repeat(40), w.dir), null);
});
