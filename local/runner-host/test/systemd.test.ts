// Spec 34 (Linux hosts, ADR 0420): the systemd user unit, the service chosen by platform, the
// Linux paths and the Linux doctor checks. systemctl and loginctl are scripted; a live check on a
// real systemd is in the runner-host README ("Running on Linux").
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyHome } from "@software-factory/harness-claude";
import type { Exec, ExecResult } from "@software-factory/runner-local";
import { afterEach, describe, expect, it } from "vitest";
import { paths } from "../src/config.ts";
import { installHint, linuxChecks } from "../src/linux.ts";
import { serviceFor } from "../src/service.ts";
import * as systemd from "../src/systemd.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const input = {
  node: "/home/t/.nvm/versions/node/v24.11.0/bin/node",
  wrapper: "/home/t/software-factory/local/runner-host/bin/sf-runner-service",
  workingDirectory: "/home/t/software-factory/local/runner-host",
  path: "/home/t/.nvm/versions/node/v24.11.0/bin:/usr/bin:/bin:/home/t/.local/bin",
  home: "/home/t",
  logFile: "/home/t/.local/state/software-factory/logs/runner.log",
  stateDir: "/home/t/.local/state/software-factory/runner",
};

/** The unit's `Key=value` lines for one key. */
const values = (text: string, key: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1));

describe("the systemd unit", () => {
  const text = systemd.unit(input);

  it("runs the self-update wrapper with sh, from the runner's checkout", () => {
    expect(values(text, "ExecStart")).toEqual([`/bin/sh "${input.wrapper}"`]);
    expect(values(text, "WorkingDirectory")).toEqual([input.workingDirectory]);
    expect(values(text, "Type")).toEqual(["simple"]);
  });

  it("passes the pinned Node, the state dir, PATH and HOME, and nothing else", () => {
    expect(values(text, "Environment")).toEqual([
      `"PATH=${input.path}"`,
      `"HOME=/home/t"`,
      `"SF_RUNNER_NODE=${input.node}"`,
      `"SF_RUNNER_STATE_DIR=${input.stateDir}"`,
    ]);
    expect(
      values(systemd.unit({ ...input, configFile: "/c/runner.json" }), "Environment"),
    ).toContain(`"SF_RUNNER_CONFIG=/c/runner.json"`);
  });

  it("restarts after a non-zero exit only, never gives up, and spares the tmux server", () => {
    expect(values(text, "Restart")).toEqual(["on-failure"]);
    expect(values(text, "RestartSec")).toEqual(["30"]);
    expect(values(text, "StartLimitIntervalSec")).toEqual(["0"]);
    expect(values(text, "KillMode")).toEqual(["process"]);
    expect(values(text, "TimeoutStopSec")).toEqual(["120"]);
    // StartLimitIntervalSec belongs to [Unit], or systemd ignores it.
    expect(text.indexOf("StartLimitIntervalSec")).toBeLessThan(text.indexOf("[Service]"));
  });

  it("appends stdout and stderr to the log file and starts with the user's manager", () => {
    expect(values(text, "StandardOutput")).toEqual([`append:${input.logFile}`]);
    expect(values(text, "StandardError")).toEqual([`append:${input.logFile}`]);
    expect(values(text, "WantedBy")).toEqual(["default.target"]);
  });

  it("escapes specifiers, quotes, backslashes and $ (a checkout path is the owner's)", () => {
    const odd = systemd.unit({
      ...input,
      wrapper: '/home/t/my "sf" 100%/$HOME\\bin/sf-runner-service',
      workingDirectory: "/home/t/100%",
      path: "/a%b:/usr/bin",
    });
    expect(values(odd, "ExecStart")).toEqual([
      '/bin/sh "/home/t/my \\"sf\\" 100%%/$$HOME\\\\bin/sf-runner-service"',
    ]);
    expect(values(odd, "WorkingDirectory")).toEqual(["/home/t/100%%"]);
    expect(values(odd, "Environment")[0]).toBe('"PATH=/a%%b:/usr/bin"');
    expect(() => systemd.unit({ ...input, home: "/home/t\nExecStartPre=/bin/evil" })).toThrow(
      /newline/,
    );
  });

  it("lives in the owner's systemd user dir, honouring XDG_CONFIG_HOME", () => {
    expect(systemd.unitPath({ HOME: "/home/t" })).toBe(
      "/home/t/.config/systemd/user/software-factory-runner.service",
    );
    expect(systemd.unitPath({ HOME: "/home/t", XDG_CONFIG_HOME: "/x" })).toBe(
      "/x/systemd/user/software-factory-runner.service",
    );
  });
});

/** A scripted exec: answers by `command args…` prefix, records every call. */
function scripted(answers: Record<string, Partial<ExecResult>> = {}) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return { code: 0, stdout: "", stderr: "", ...(key ? answers[key] : {}) };
  };
  return { exec, calls };
}

describe("systemctl --user", () => {
  async function unitFile() {
    const dir = await mkdtemp(join(tmpdir(), "sf-systemd-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return join(dir, "systemd", "user", systemd.UNIT);
  }

  it("install writes the unit, then reloads, enables and restarts it", async () => {
    const file = await unitFile();
    const { exec, calls } = scripted();
    await systemd.install(exec, file, "[Unit]\n");
    expect(await readFile(file, "utf8")).toBe("[Unit]\n");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable ${systemd.UNIT}`,
      `systemctl --user restart ${systemd.UNIT}`,
    ]);
  });

  it("install says why when there's no user systemd for the shell (su, sudo)", async () => {
    const { exec } = scripted({
      "systemctl --user daemon-reload": {
        code: 1,
        stderr: "Failed to connect to bus: No medium found",
      },
    });
    await expect(systemd.install(exec, await unitFile(), "x")).rejects.toThrow(
      /Failed to connect to bus.*not with su\/sudo/,
    );
  });

  it("uninstall disables and stops it, removes the file and reloads", async () => {
    const file = await unitFile();
    const { exec, calls } = scripted();
    await systemd.install(exec, file, "x");
    calls.length = 0;
    await systemd.uninstall(exec, file);
    expect(calls).toEqual([
      `systemctl --user disable --now ${systemd.UNIT}`,
      "systemctl --user daemon-reload",
    ]);
    await expect(stat(file)).rejects.toThrow();
  });

  it("kickstart restarts an enabled unit only", async () => {
    const off = scripted({ "systemctl --user is-enabled": { code: 1, stdout: "disabled" } });
    expect(await systemd.kickstart(off.exec)).toBe(false);
    expect(off.calls).toEqual([`systemctl --user is-enabled ${systemd.UNIT}`]);
    const on = scripted();
    expect(await systemd.kickstart(on.exec)).toBe(true);
    expect(on.calls.at(-1)).toBe(`systemctl --user restart ${systemd.UNIT}`);
  });

  it("status reads systemctl show as `state = running`, the form the CLI looks for", async () => {
    const running = scripted({
      "systemctl --user show": {
        stdout:
          "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\n",
      },
    });
    expect(await systemd.status(running.exec)).toBe(
      "state = running (active), pid = 4242, last exit = 0",
    );
    const restarting = scripted({
      "systemctl --user show": {
        stdout:
          "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainStatus=75\n",
      },
    });
    expect(await systemd.status(restarting.exec)).toBe(
      "state = auto-restart (activating), pid = -, last exit = 75",
    );
    const missing = scripted({
      "systemctl --user show": { stdout: "LoadState=not-found\nActiveState=inactive\n" },
    });
    expect(await systemd.status(missing.exec)).toBeNull();
  });

  it("reads linger from loginctl", async () => {
    expect(await systemd.linger(scripted({ loginctl: { stdout: "Linger=yes\n" } }).exec, "t")).toBe(
      true,
    );
    expect(await systemd.linger(scripted({ loginctl: { stdout: "Linger=no\n" } }).exec, "t")).toBe(
      false,
    );
    expect(await systemd.linger(scripted({ loginctl: { code: 1 } }).exec, "t")).toBeNull();
    expect(systemd.lingerHint("t")).toContain("sudo loginctl enable-linger t");
  });
});

describe("the service is chosen by platform", () => {
  it("launchd on macOS, systemd on Linux, none elsewhere", () => {
    const mac = serviceFor("darwin", { HOME: "/Users/t" });
    expect(mac?.kind).toBe("launchd");
    expect(mac?.file).toBe("/Users/t/Library/LaunchAgents/com.software-factory.runner.plist");
    expect(mac?.definition(input)).toContain("<key>KeepAlive</key>");
    const linux = serviceFor("linux", { HOME: "/home/t" });
    expect(linux?.kind).toBe("systemd");
    expect(linux?.file).toBe("/home/t/.config/systemd/user/software-factory-runner.service");
    expect(linux?.definition(input)).toContain("Restart=on-failure");
    expect(linux?.restartCommand).toBe("systemctl --user restart software-factory-runner.service");
    expect(serviceFor("win32", {})).toBeNull();
    expect(serviceFor("freebsd", {})).toBeNull();
  });

  it("the tmux hint names the platform's package manager", () => {
    expect(installHint("tmux", "darwin")).toBe("brew install tmux");
    expect(installHint("tmux", "linux")).toBe("sudo apt-get install tmux");
  });
});

describe("paths on Linux", () => {
  it("logs under XDG state, never ~/Library, and the harness can't read them", () => {
    const linux = paths({ HOME: "/home/t" }, "linux");
    expect(linux.logDir).toBe("/home/t/.local/state/software-factory/logs");
    expect(JSON.stringify(linux)).not.toContain("Library");
    expect(paths({ HOME: "/home/t", XDG_STATE_HOME: "/s" }, "linux").logDir).toBe(
      "/s/software-factory/logs",
    );
    expect(denyHome("linux").some((d) => linux.logDir.startsWith(join("/home/t", d)))).toBe(true);
    expect(paths({ HOME: "/Users/t" }, "darwin").logDir).toBe(
      "/Users/t/Library/Logs/software-factory",
    );
  });
});

describe("doctor on Linux", () => {
  const ok = {
    "/usr/bin/bwrap": { code: 0 },
    "systemctl --user is-system-running": { stdout: "running\n" },
    "loginctl show-user": { stdout: "Linger=yes\n" },
  };
  const which =
    (...present: string[]) =>
    (name: string) =>
      present.includes(name) ? `/usr/bin/${name}` : null;

  it("passes with bubblewrap, socat, a working sandbox, user systemd and linger", async () => {
    const { exec, calls } = scripted(ok);
    const lines = await linuxChecks({ exec, user: "t", which: which("bwrap", "socat") });
    expect(lines.map((l) => l.level)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(calls[0]).toBe("/usr/bin/bwrap --ro-bind / / --dev /dev --unshare-net true");
  });

  it("fails without bubblewrap or socat, naming the package", async () => {
    const { exec } = scripted(ok);
    const lines = await linuxChecks({ exec, user: "t", which: which() });
    const fails = lines.filter((l) => l.level === "fail");
    expect(fails.map((l) => l.what)).toEqual([
      "bubblewrap (Claude Code's sandbox)",
      "socat (the sandbox's network relay)",
    ]);
    for (const f of fails) expect(f.detail).toContain("apt-get install bubblewrap socat");
  });

  it("warns, with AppArmor's fix, when bubblewrap can't run; warns on no linger or user systemd", async () => {
    const { exec } = scripted({
      "/usr/bin/bwrap": { code: 1, stderr: "bwrap: setting up uid map: Permission denied" },
      "systemctl --user is-system-running": { code: 1, stderr: "Failed to connect to bus" },
      "loginctl show-user": { stdout: "Linger=no\n" },
    });
    const lines = await linuxChecks({
      exec,
      user: "t",
      which: which("bwrap", "socat"),
      readText: async () => "1\n",
    });
    expect(lines.filter((l) => l.level === "fail")).toEqual([]);
    const warns = lines.filter((l) => l.level === "warn");
    expect(warns.map((l) => l.what)).toEqual(["bubblewrap runs", "systemd user manager", "linger"]);
    expect(warns[0]?.detail).toMatch(/uid map.*apparmor_restrict_unprivileged_userns = 1/);
    expect(warns[2]?.detail).toContain("sudo loginctl enable-linger t");
  });
});
