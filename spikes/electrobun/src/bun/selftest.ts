// SF_SPIKE_SELFTEST=1: the app exercises each spike question itself and writes the evidence to
// $SF_SPIKE_SELFTEST (a JSON file), since this session can't click the window.
import { appendFileSync } from "node:fs";
import { Utils } from "electrobun/main";
import { setDockBadge } from "./dock.ts";
import { deleteToken, readToken, saveToken } from "./keychain.ts";
import type { Supervisor } from "./supervisor.ts";

const out = process.env.SF_SPIKE_SELFTEST ?? "";
export function report(check: string, data: unknown) {
	const line = JSON.stringify({ at: new Date().toISOString(), check, data });
	console.log(`[selftest] ${line}`);
	if (out && out !== "1") appendFileSync(out, `${line}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => {
	const end = Date.now() + ms;
	while (Date.now() < end && !f()) await sleep(100);
	return f();
};

export async function selftest(sup: Supervisor, lastDeepLink: () => string | null, closeWindow: () => void) {
	report("process", { pid: process.pid, execPath: process.execPath, bun: Bun.version });

	// Keychain, login keychain ("file"): written by this process, read back by it.
	const token = `sfd_selftest_${crypto.randomUUID()}`;
	const saved = saveToken(token, "file");
	const read = readToken("file");
	report("keychain.file", { saveStatus: saved, readStatus: read.status, roundTrip: read.token === token });
	// Data-protection keychain: needs a keychain-access-groups entitlement (a Team ID signature).
	const dp = saveToken(token, "dataProtection");
	report("keychain.dataProtection", { saveStatus: dp, note: dp === -34018 ? "errSecMissingEntitlement" : undefined });
	if (dp === 0) deleteToken("dataProtection");

	try {
		setDockBadge(3);
		report("dock.badge", { ok: true });
	} catch (e) {
		report("dock.badge", { ok: false, error: String(e) });
	}
	try {
		Utils.showNotification({ title: "Spec waiting", body: "Work item 1 needs your approval (spike self-test)" });
		report("notification", { ok: true, note: "fire-and-forget; no click callback in 2.0.6" });
	} catch (e) {
		report("notification", { ok: false, error: String(e) });
	}

	// Supervision: crash the child, see it come back with a new pid.
	await until(() => sup.state.status === "running" && !!sup.state.lastLine, 5000);
	const pid1 = sup.state.pid;
	sup.crash();
	await until(() => sup.state.status === "running" && sup.state.pid !== pid1, 8000);
	report("runner.restart", { pidBefore: pid1, pidAfter: sup.state.pid, restarts: sup.state.restarts, status: sup.state.status, lastLine: sup.state.lastLine });

	// The real sf-runner on the bundled Node: `status` (one-shot, no pairing needed).
	await sup.use("sf-runner");
	await until(() => sup.state.status === "stopped", 10_000);
	report("runner.sfRunnerStatus", { status: sup.state.status, lastLine: sup.state.lastLine });
	await sup.use("fake");

	await sleep(1500);
	report("deepLink", { last: lastDeepLink() });
	// Close the window: the app (menu bar) and the runner must carry on.
	closeWindow();
	await sleep(3000);
	report("window.closed", { runnerStatus: sup.state.status, runnerPid: sup.state.pid });
	if (process.env.SF_SPIKE_SELFTEST_QUIT) {
		const pid = sup.state.pid;
		report("quit", { runnerPid: pid });
		Utils.quit();
		return;
	}
	report("done", { keepRunning: true });
}
