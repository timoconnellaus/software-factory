// One check under Anthropic's sandbox runtime, run by the host as its own child (ADR 0501, amended
// 2026-11-12 twice). Plain JavaScript so it runs on the host's Node with no flags.
//
// Why not the `srt` CLI:
//   - its exit code is not the command's: it exits 0 when the command dies of SIGTERM or SIGINT, so
//     a check that prints a failure and signals itself (or its shell) "passes";
//   - it reads its settings from a file, and a file the check (or something it left running) can
//     reach is a sandbox the check can switch off for the next one.
//
// So: the settings and the command come in on stdin (nothing on disk), the command runs through the
// library's own `wrapWithSandbox`, and what this process reports on fd 3 (a pipe only the host holds)
// is the command's own exit: its code, or the signal it died of. The sandbox lets a sandboxed
// process signal only processes in the same sandbox (macOS `signal (target same-sandbox)`, a pid
// namespace on Linux), so nothing the check runs can stop this process from reporting. The host
// treats a missing or unreadable report as a failure.
//
// This process's own TMPDIR is a short private dir (the sandbox runtime puts its proxy sockets
// there, and a unix socket's path is short); the command gets the check's own (`tmpdir` on stdin).
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const REPORT_FD = 3;

/** One line on fd 3, once. */
let reported = false;
function report(result) {
  if (reported) return;
  reported = true;
  try {
    writeSync(REPORT_FD, `${JSON.stringify(result)}\n`);
  } catch {
    // The host has gone: nothing to tell.
  }
}

// The check can't signal this process, but a stray signal must never end it before it reports.
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * macOS: programs the check may not run (`launchctl`), as `(deny process-exec …)` rules appended to
 * the sandbox profile srt wrote. Seatbelt applies the last rule that matches, so they win over its
 * `(allow process-exec)`. The profile is single-quoted after `sandbox-exec -p` and ends with srt's
 * own deny-write rule `(with message "…_SBX"))`: where that end isn't found, nothing runs.
 */
function denyExecRules(wrapped, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return wrapped;
  // The first such end after the profile starts: a `'` inside the profile is escaped (`'\\''`), so
  // the command (after the profile) can't place one before it.
  const start = wrapped.indexOf("sandbox-exec -p '");
  const end = start < 0 ? -1 : wrapped.indexOf(`_SBX"))'`, start);
  if (!wrapped.startsWith("env ") || end < 0) {
    throw new Error("the sandbox profile could not take the runner's own rules");
  }
  const at = end + `_SBX"))`.length;
  const rules = paths
    .filter((p) => typeof p === "string" && /^\/[\w./-]+$/.test(p))
    .map((p) => `(deny process-exec (literal "${p}"))`)
    .join("\n");
  return `${wrapped.slice(0, at)}\n${rules}${wrapped.slice(at)}`;
}

async function main() {
  const { settings, command, tmpdir, denyExec } = await readStdin();
  if (typeof command !== "string" || !settings) throw new Error("no settings or command on stdin");
  // srt hands the command TMPDIR=$CLAUDE_CODE_TMPDIR, else the shared /tmp/claude: the check's own.
  if (typeof tmpdir === "string") process.env.CLAUDE_CODE_TMPDIR = tmpdir;
  await SandboxManager.initialize(settings);
  const wrapped = denyExecRules(await SandboxManager.wrapWithSandbox(command), denyExec);
  const env = typeof tmpdir === "string" ? { ...process.env, TMPDIR: tmpdir } : process.env;
  const child = spawn(wrapped, { shell: true, env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (err) => {
    report({ error: `could not start: ${err.message}` });
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    try {
      SandboxManager.cleanupAfterCommand();
    } catch {
      // Best effort: bwrap's mount-point leftovers.
    }
    report(signal ? { signal } : { code });
    void SandboxManager.reset()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

main().catch((err) => {
  report({ error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
