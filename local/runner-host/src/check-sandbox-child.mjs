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

async function main() {
  const { settings, command } = await readStdin();
  if (typeof command !== "string" || !settings) throw new Error("no settings or command on stdin");
  await SandboxManager.initialize(settings);
  const wrapped = await SandboxManager.wrapWithSandbox(command);
  const child = spawn(wrapped, { shell: true, stdio: ["ignore", "inherit", "inherit"] });
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
