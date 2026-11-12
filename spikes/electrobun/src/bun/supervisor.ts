// Supervises the runner as a child process on the bundled Node 24 (not Bun): the runner host is
// tested on Node and keeps its own credential boundary. Restarts with backoff; a stop is clean
// (SIGTERM, then SIGKILL after a grace period).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerState } from "../shared/rpc.ts";

const RUNNER_DIR = resolve("../Resources/app/runner");
const NODE = join(RUNNER_DIR, "node");
const SCRIPTS = { fake: ["fake-runner.mjs"], "sf-runner": ["sf-runner.mjs", "status"] } as const;

export class Supervisor {
	state: RunnerState = { status: "stopped", pid: null, restarts: 0, lastLine: null, which: "fake" };
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private stopping = false;
	private startedAt = 0;
	constructor(private onChange: (s: RunnerState) => void) {}

	private set(patch: Partial<RunnerState>) {
		this.state = { ...this.state, ...patch };
		this.onChange(this.state);
	}

	start(which: RunnerState["which"] = this.state.which) {
		if (!existsSync(NODE)) {
			this.set({ status: "failed", lastLine: `no bundled node at ${NODE}` });
			return;
		}
		this.stopping = false;
		const [script, ...args] = SCRIPTS[which];
		this.set({ status: this.state.restarts ? "restarting" : "starting", which });
		this.startedAt = Date.now();
		const proc = Bun.spawn([NODE, join(RUNNER_DIR, script), ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// The runner's own env, not the app's: no inherited tokens. A real build passes only what
			// sf-runner needs (HOME, PATH for git/orca/claude).
			env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" },
			onExit: (_p, code, signal) => this.exited(code, signal),
		});
		this.proc = proc;
		this.set({ status: "running", pid: proc.pid });
		void this.pump(proc.stdout as ReadableStream<Uint8Array>);
		void this.pump(proc.stderr as ReadableStream<Uint8Array>);
	}

	private async pump(stream: ReadableStream<Uint8Array>) {
		const dec = new TextDecoder();
		for await (const chunk of stream) {
			const lines = dec.decode(chunk).trim().split("\n");
			const last = lines.at(-1);
			if (last) this.set({ lastLine: last.slice(0, 300) });
		}
	}

	private exited(code: number | null, signal: unknown) {
		this.proc = null;
		if (this.stopping) {
			this.set({ status: "stopped", pid: null });
			return;
		}
		// sf-runner `status` is one-shot: exiting 0 is the end, not a crash.
		if (this.state.which === "sf-runner" && code === 0) {
			this.set({ status: "stopped", pid: null });
			return;
		}
		const healthy = Date.now() - this.startedAt > 60_000;
		const restarts = healthy ? 1 : this.state.restarts + 1;
		const delay = Math.min(30_000, 1000 * 2 ** (restarts - 1));
		this.set({ status: "restarting", pid: null, restarts, lastLine: `exited code=${code} signal=${signal}; restart in ${delay} ms` });
		setTimeout(() => this.start(), delay);
	}

	crash() {
		const stdin = this.proc?.stdin;
		if (!stdin || typeof stdin === "number") return false;
		stdin.write("crash\n");
		stdin.flush();
		return true;
	}

	async stop(graceMs = 5000) {
		this.stopping = true;
		const p = this.proc;
		if (!p) return;
		p.kill("SIGTERM");
		const t = setTimeout(() => p.kill("SIGKILL"), graceMs);
		await p.exited;
		clearTimeout(t);
	}

	async use(which: RunnerState["which"]) {
		await this.stop();
		this.set({ restarts: 0 });
		this.start(which);
	}
}
