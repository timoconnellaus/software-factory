// The runner as a launchd service (a per-user LaunchAgent, not a system daemon: Orca and Claude Code
// run in the owner's GUI session, and the runner drives them there).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@software-factory/runner-orca";

export const LABEL = "com.software-factory.runner";

export function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The service definition. `PATH` is captured at install time so the service finds the same
 * `node`, `orca`, `claude` and `git` as the shell that installed it; nothing else from that shell's
 * environment is carried over (no tokens, no SSH agent).
 */
export function plist(input: {
  node: string;
  cli: string;
  workingDirectory: string;
  path: string;
  home: string;
  logFile: string;
  configFile?: string;
}): string {
  const env: Record<string, string> = { PATH: input.path, HOME: input.home };
  if (input.configFile) env.SF_RUNNER_CONFIG = input.configFile;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.node)}</string>
    <string>--experimental-transform-types</string>
    <string>--no-warnings</string>
    <string>${xml(input.cli)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart after a crash, but not after a clean exit (e.g. not paired yet). -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(input.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logFile)}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export async function install(exec: Exec, file: string, contents: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await exec("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  await writeFile(file, contents);
  const result = await exec("launchctl", ["bootstrap", domain(), file]);
  if (result.code !== 0) throw new Error(`launchctl bootstrap: ${result.stderr.trim()}`);
}

export async function uninstall(exec: Exec, file: string): Promise<void> {
  await exec("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  await rm(file, { force: true });
}

/** Restarts the service if it is installed (after pairing). */
export async function kickstart(exec: Exec): Promise<boolean> {
  const result = await exec("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`]);
  return result.code === 0;
}

export async function status(exec: Exec): Promise<string | null> {
  const result = await exec("launchctl", ["print", `${domain()}/${LABEL}`]);
  if (result.code !== 0) return null;
  const pick = (key: string) => result.stdout.match(new RegExp(`\\n\\s*${key} = ([^\\n]+)`))?.[1];
  return [
    `state = ${pick("state") ?? "?"}`,
    `pid = ${pick("pid") ?? "-"}`,
    `last exit = ${pick("last exit code") ?? "-"}`,
  ].join(", ");
}
