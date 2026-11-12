// The runner as a systemd user service on Linux (ADR 0420), the counterpart of launchd.ts: a unit in
// the owner's user manager, not a system service, because Claude Code runs as the owner, with their
// Claude login, in tmux sessions the owner can attach to. Lingering (`loginctl enable-linger`) keeps
// it running without a login session and starts it at boot.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@software-factory/runner-local";
import type { ServiceInput } from "./service.ts";

export const UNIT = "software-factory-runner.service";

/** `$XDG_CONFIG_HOME/systemd/user/<unit>`, where `systemctl --user` looks for the owner's units. */
export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
  return join(config, "systemd", "user", UNIT);
}

const noNewline = (value: string) => {
  if (/[\r\n]/.test(value)) throw new Error(`a systemd unit value can't hold a newline: ${value}`);
  return value;
};
/** `%` starts a specifier in every unit value. */
const specifiers = (value: string) => noNewline(value).replace(/%/g, "%%");
/** A double-quoted word, for `ExecStart=` and `Environment=` (C-style escapes inside quotes). */
const quoted = (value: string) =>
  `"${specifiers(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** `ExecStart=` also expands `$VAR`: a literal `$` is `$$`. */
const execWord = (value: string) => quoted(value).replace(/\$/g, "$$$$");

/**
 * The unit. systemd runs the same `sh` wrapper as launchd, `bin/sf-runner-service` (ADR 0360), so
 * self-update and its rollback are shared. The semantics are launchd's:
 * - `Restart=on-failure`: after a crash or a self-update (exit 75), never after the clean exit of an
 *   unpaired runner; `StartLimitIntervalSec=0` so it never gives up (the rollback counts starts).
 * - `KillMode=process`: a restart stops the runner only, not the factory's tmux server, which the
 *   runner started inside this unit's cgroup. On stop the runner cancels and releases its own jobs.
 * - stdout and stderr appended to the log file, the same file `status` names.
 * `PATH` is the installing shell's plus tmux's and claude's directories; nothing else of that
 * shell's environment is carried over (no tokens, no SSH agent).
 */
export function unit(input: ServiceInput): string {
  const env: Record<string, string> = {
    PATH: input.path,
    HOME: input.home,
    SF_RUNNER_NODE: input.node,
    SF_RUNNER_STATE_DIR: input.stateDir,
  };
  if (input.configFile) env.SF_RUNNER_CONFIG = input.configFile;
  return `# Written by \`sf-runner install\` (local/runner-host, ADR 0420). Reinstall rather than edit.
[Unit]
Description=Software Factory runner (sf-runner)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/bin/sh ${execWord(input.wrapper)}
WorkingDirectory=${specifiers(input.workingDirectory)}
${Object.entries(env)
  .map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}`)
  .join("\n")}
Restart=on-failure
RestartSec=30
KillMode=process
TimeoutStopSec=120
StandardOutput=append:${specifiers(input.logFile)}
StandardError=append:${specifiers(input.logFile)}

[Install]
WantedBy=default.target
`;
}

async function systemctl(exec: Exec, ...args: string[]): Promise<void> {
  const result = await exec("systemctl", ["--user", ...args]);
  if (result.code === 0) return;
  const message = (result.stderr || result.stdout).trim();
  const hint = /bus|XDG_RUNTIME_DIR/i.test(message)
    ? " (no user systemd for this shell: log in over SSH or a console as this user, not with su/sudo)"
    : "";
  throw new Error(`systemctl --user ${args.join(" ")} failed: ${message}${hint}`);
}

/** Writes the unit, then reloads, enables and (re)starts it. A restart cancels running jobs. */
export async function install(exec: Exec, file: string, contents: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
  await systemctl(exec, "daemon-reload");
  await systemctl(exec, "enable", UNIT);
  await systemctl(exec, "restart", UNIT);
}

export async function uninstall(exec: Exec, file: string): Promise<void> {
  await exec("systemctl", ["--user", "disable", "--now", UNIT]);
  await rm(file, { force: true });
  await exec("systemctl", ["--user", "daemon-reload"]);
}

/** Restarts the service if it is installed (after pairing). */
export async function kickstart(exec: Exec): Promise<boolean> {
  const enabled = await exec("systemctl", ["--user", "is-enabled", UNIT]);
  if (enabled.code !== 0) return false;
  const result = await exec("systemctl", ["--user", "restart", UNIT]);
  return result.code === 0;
}

/** `state = running (active), pid = …, last exit = …`, or null when the unit isn't installed. */
export async function status(exec: Exec): Promise<string | null> {
  const result = await exec("systemctl", [
    "--user",
    "show",
    UNIT,
    "-p",
    "LoadState",
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "MainPID",
    "-p",
    "ExecMainStatus",
  ]);
  if (result.code !== 0) return null;
  const props = parseShow(result.stdout);
  if (!props.LoadState || props.LoadState === "not-found") return null;
  const pid = props.MainPID && props.MainPID !== "0" ? props.MainPID : "-";
  return [
    `state = ${props.SubState ?? "?"} (${props.ActiveState ?? "?"})`,
    `pid = ${pid}`,
    `last exit = ${props.ExecMainStatus ?? "-"}`,
  ].join(", ");
}

/** `systemctl show` / `loginctl show-user` output: one `Key=value` per line. */
export function parseShow(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return props;
}

/** Whether `user` lingers (their services run without a login session): null when unknown. */
export async function linger(exec: Exec, user: string): Promise<boolean | null> {
  const result = await exec("loginctl", ["show-user", user, "-p", "Linger"]);
  if (result.code !== 0) return null;
  const value = parseShow(result.stdout).Linger;
  return value === "yes" ? true : value === "no" ? false : null;
}

export const lingerHint = (user: string) =>
  `linger is off for ${user}: the service stops at logout and won't start at boot. Run once: sudo loginctl enable-linger ${user}`;
