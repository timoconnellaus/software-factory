// What `sf-runner doctor` checks on a Linux host (ADR 0420), apart from what every host checks.
// Claude Code's sandbox on Linux is bubblewrap with socat relaying network traffic to its proxy; the
// factory sets `failIfUnavailable`, so without them every job fails at launch. The rest can't be
// known for sure from outside Claude Code (its exact bwrap flags, AppArmor), so those are warnings.
import { readFile } from "node:fs/promises";
import type { Exec } from "@software-factory/runner-local";
import { linger, lingerHint } from "./systemd.ts";

export interface DoctorLine {
  /** `fail` fails doctor; `warn` is printed with `!` and doesn't. */
  level: "ok" | "warn" | "fail";
  what: string;
  detail: string;
}

/** The AppArmor switch that stops unprivileged bubblewrap on Ubuntu ≥ 23.10. */
export const APPARMOR_USERNS = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

const APT = "sudo apt-get install bubblewrap socat (Fedora: sudo dnf install bubblewrap socat)";

export async function linuxChecks(input: {
  exec: Exec;
  user: string;
  /** The absolute path of a command on the service's PATH, or null. */
  which: (name: string) => string | null;
  readText?: (file: string) => Promise<string | null>;
}): Promise<DoctorLine[]> {
  const { exec, user, which } = input;
  const readText = input.readText ?? ((file: string) => readFile(file, "utf8").catch(() => null));
  const lines: DoctorLine[] = [];
  const bwrap = which("bwrap");
  const socat = which("socat");
  lines.push(
    bwrap
      ? { level: "ok", what: "bubblewrap (Claude Code's sandbox)", detail: bwrap }
      : {
          level: "fail",
          what: "bubblewrap (Claude Code's sandbox)",
          detail: `bwrap not found; jobs fail at launch without it: ${APT}`,
        },
    socat
      ? { level: "ok", what: "socat (the sandbox's network relay)", detail: socat }
      : {
          level: "fail",
          what: "socat (the sandbox's network relay)",
          detail: `socat not found; jobs fail at launch without it: ${APT}`,
        },
  );
  if (bwrap) {
    const smoke = await exec(
      bwrap,
      ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "true"],
      { timeoutMs: 20_000 },
    );
    if (smoke.code === 0) {
      lines.push({ level: "ok", what: "bubblewrap runs", detail: "a sandboxed `true` ran" });
    } else {
      const restricted = (await readText(APPARMOR_USERNS))?.trim() === "1";
      lines.push({
        level: "warn",
        what: "bubblewrap runs",
        detail: `a sandboxed \`true\` failed: ${(smoke.stderr || smoke.stdout).trim() || `exit ${smoke.code}`}${
          restricted
            ? `. AppArmor restricts unprivileged user namespaces here (${APPARMOR_USERNS} = 1): add an AppArmor profile for ${bwrap} or set the sysctl to 0, as Claude Code's sandboxing docs describe`
            : ""
        }`,
      });
    }
  }
  const manager = await exec("systemctl", ["--user", "is-system-running"], { timeoutMs: 20_000 });
  const state = manager.stdout.trim();
  lines.push(
    state === "running"
      ? { level: "ok", what: "systemd user manager", detail: "running" }
      : {
          level: "warn",
          what: "systemd user manager",
          detail:
            state === "degraded"
              ? "degraded: some of your user units failed (systemctl --user --failed)"
              : `not reachable (${(manager.stderr || state).trim() || `exit ${manager.code}`}); install needs a login session as ${user} (SSH or a console, not su/sudo)`,
        },
  );
  const lingers = await linger(exec, user);
  lines.push(
    lingers
      ? { level: "ok", what: "linger", detail: `on for ${user}` }
      : {
          level: "warn",
          what: "linger",
          detail: lingers === false ? lingerHint(user) : `unknown for ${user} (loginctl failed)`,
        },
  );
  return lines;
}

/** The package manager hint for a missing tool. */
export function installHint(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? `brew install ${name}` : `sudo apt-get install ${name}`;
}
