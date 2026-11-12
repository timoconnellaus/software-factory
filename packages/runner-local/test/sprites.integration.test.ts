// A sprite job (ADR 0460) on the real tmux (skipped when tmux isn't installed), against the fake
// Sprites API: the job's pane runs the real bridge as its own Node process (`sprite.sh`), the
// stand-in Claude in the sprite answers over the TTY WebSocket, and the web terminal's tmux
// control-mode bridge (ADR 0440) sees and types into the same pane. The live run against Sprites
// itself is in the runner-host README ("Sprites sandboxes").
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Job } from "@software-factory/runner-contract";
import { afterAll, describe, expect, it } from "vitest";
import { createSpritesRunner } from "../src/index.ts";
import { type FakeAgent, fakeClaude, fakeSpritesApi } from "../src/testing.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const SOCKET = `sf-spr-test-${process.pid}`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

afterAll(() => {
  spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
});

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!hasTmux)("a sprite job on the real tmux", { timeout: 60_000 }, () => {
  it("bridges the pane to the sprite: prompt, steer, web terminal, exit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-spr-int-")));
    const seed = join(root, "seed");
    await mkdir(seed);
    git(seed, "init", "-q", "-b", "main");
    await writeFile(join(seed, "README.md"), "# scratch\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qm", "init");
    let agent: FakeAgent | null = null;
    const api = await fakeSpritesApi(join(root, "cloud"), {
      onTty: fakeClaude({
        onPrompt: (a) => {
          agent = a;
        },
      }),
    });
    const tokenFile = join(root, "sprites.token");
    await writeFile(tokenFile, api.token, { mode: 0o600 });
    const runner = createSpritesRunner({
      resolveRepoPath: () => seed,
      worktreesDir: join(root, "worktrees"),
      runsDir: join(root, "runs"),
      startPoint: () => "main",
      pollMs: 20,
      tmux: { socket: SOCKET },
      sprites: {
        apiUrl: api.url,
        tokenFile,
        spritesDir: join(root, "sprites"),
        namePrefix: "sf-int-",
        mirrorMs: 20,
        modelCredential: () => ({
          env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-integration-token" },
        }),
      },
    });
    const j: Job = {
      jobId: "job_int",
      runId: "run_1",
      runNo: 1,
      stage: "build",
      workItem: { id: "wi_1", number: 7, title: "x" },
      repo: { url: "https://github.com/acme/app.git", owner: "acme", name: "app", baseRef: "main" },
      branch: "factory/7-x-run-1",
      harness: { id: "claude-code", role: "implement", prompt: "do it" },
      context: {},
      requires: [],
      limits: { sessionTimeoutMs: 30_000 },
      lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    };
    try {
      const ws = await runner.prepareWorkspace(j, new AbortController().signal);
      const session = await runner.startSession(j, ws, new AbortController().signal);
      await until("the prompt", () => (agent as FakeAgent | null)?.submitted.length === 1);
      const a = agent as unknown as FakeAgent;

      // The web terminal's bridge on the same pane: it sees the sprite's output and types into it.
      let out = "";
      const terminal = await runner.openTerminal?.(session, {
        size: null,
        onOutput: (bytes) => {
          out += new TextDecoder().decode(bytes);
        },
        onSize: () => {},
        onExit: () => {},
      });
      expect(terminal).toBeTruthy();
      await until("the sprite's banner in the web terminal", () =>
        out.includes("Claude Code (fake, in a sprite)"),
      );
      await terminal?.write("typed in the browser\r");
      await until("the browser's line in the sprite", () =>
        a.submitted.includes("typed in the browser"),
      );
      await runner.steer?.(session, "a steer");
      await until("the steer in the sprite", () => a.submitted.includes("a steer"));
      await terminal?.close();

      // Claude exits in the sprite: the bridge exits and the pane with it.
      a.tty.exit(0);
      const events = [];
      for await (const e of runner.events(j, session, new AbortController().signal)) events.push(e);
      expect(events.at(-1)).toMatchObject({ type: "session.ended" });
      await runner.release(j, ws, session);
      expect(api.sprites.size).toBe(0);
    } finally {
      await api.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
