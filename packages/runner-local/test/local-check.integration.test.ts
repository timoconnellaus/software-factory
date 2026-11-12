// A local job's checks in a check container on the real Docker (ADR 0501, fourth review): what the
// macOS OS sandbox couldn't give. A server the check starts is reachable on its own loopback; a
// process that leaves with setsid and an exiting middle shell dies with the container; install
// reaches the registry through the check's own egress proxy and nothing else; nothing of the host's
// filesystem is visible but the check's tree and store. Needs Docker and the agent image (built by
// `sf-runner doctor --fix`, or here with SF_BUILD_AGENT_IMAGE=1).
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentImage,
  dockerRuntime,
  ensureImage,
  JOB_LABEL,
  localCheckContainer,
} from "../src/container/index.ts";

const hasDocker =
  spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  }).stdout?.trim().length > 0;
const runtime = dockerRuntime();
const image = hasDocker
  ? process.env.SF_BUILD_AGENT_IMAGE === "1"
    ? (await ensureImage(runtime)).id
    : (await currentImage(runtime)).id
  : null;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const never = new AbortController().signal;

/** A check's own dir under the home (a Mac's runtime shares /Users; the temp dir is per-user). */
async function checkDir() {
  const base = await mkdtemp(join(homedir(), ".sf-local-check-test-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(await realpath(base), "r0-0");
  const dir = join(root, "tree");
  await mkdir(dir, { recursive: true });
  return { root, dir };
}

const job = (jobId: string) => ({
  jobId,
  harness: { id: "claude-code" as const, role: "implement" as const, prompt: "" },
});

describe.skipIf(!hasDocker || !image)(
  "a local job's checks in a check container (real Docker)",
  { timeout: 180_000 },
  () => {
    it("reaches a server the check itself starts, on the container's own loopback", async () => {
      const { root, dir } = await checkDir();
      await writeFile(
        join(dir, "server.test.mjs"),
        [
          "import http from 'node:http';",
          "const s = http.createServer((q, r) => r.end('pong')).listen(0, '127.0.0.1', async () => {",
          "  const body = await (await fetch('http://127.0.0.1:' + s.address().port + '/')).text();",
          "  console.log('server said ' + body); s.close(); process.exit(body === 'pong' ? 0 : 1);",
          "});",
        ].join("\n"),
      );
      const exec = localCheckContainer({ runtime, image: image as string })(job("job_lc_1"), {
        root,
        dir,
      });
      const r = await exec({ run: "node server.test.mjs", timeoutMs: 60_000 }, never);
      expect(r).toMatchObject({ exitCode: 0, isolation: "container" });
      expect(r.output).toContain("server said pong");
    });

    it("kills what a check leaves, a setsid daemon behind an exiting middle shell included", async () => {
      const { root, dir } = await checkDir();
      const jobId = `job_lc_2_${process.pid}`;
      const exec = localCheckContainer({ runtime, image: image as string })(job(jobId), {
        root,
        dir,
      });
      // The fourth review's escape: the middle shell exits at once, and the grandchild is in a
      // session of its own, writing a file in the tree for as long as it lives.
      const r = await exec(
        {
          run: `( ( cd / && exec perl -MPOSIX -e 'POSIX::setsid(); while (1) { open(F, ">", $ARGV[0]); print F time; close F; sleep 1 }' "$PWD/alive" & ) & ); sleep 1; echo left-it`,
          timeoutMs: 60_000,
        },
        never,
      );
      expect(r).toMatchObject({ exitCode: 0, output: expect.stringContaining("left-it") });
      // No container, proxy or network of the job is left, and the file stops changing.
      expect(await runtime.containers(`${JOB_LABEL}=${jobId}`)).toEqual([]);
      expect(await runtime.networks(`${JOB_LABEL}=${jobId}`)).toEqual([]);
      const before = await readFile(join(dir, "alive"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(await readFile(join(dir, "alive"), "utf8")).toBe(before);
    });

    it("reaches the registry through its own proxy, nothing else, and sees none of the host", async () => {
      const { root, dir } = await checkDir();
      const secret = await mkdtemp(join(homedir(), ".sf-local-check-secret-"));
      cleanups.push(() => rm(secret, { recursive: true, force: true }));
      await writeFile(join(secret, "key"), "the owner's");
      const exec = localCheckContainer({ runtime, image: image as string })(job("job_lc_3"), {
        root,
        dir,
      });
      const r = await exec(
        {
          run: [
            `node -e "fetch('https://registry.npmjs.org/is-number').then((r) => console.log('registry', r.status), (e) => console.log('registry failed', e.cause?.code ?? e.message))"`,
            `node -e "fetch('https://example.com/').then((r) => console.log('REACHED example', r.status), (e) => console.log('example refused'))"`,
            `cat ${secret}/key 2>/dev/null && echo SAW-HOME || echo no-home`,
            "ls /Users /home 2>/dev/null",
            'echo "store=$npm_config_store_dir"',
          ].join("\n"),
          timeoutMs: 60_000,
        },
        never,
      );
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("registry 200");
      expect(r.output).toContain("example refused");
      expect(r.output).not.toMatch(/REACHED example|SAW-HOME|the owner's/);
      expect(r.output).toContain(`store=${join(root, "store")}`);
    });
  },
);
