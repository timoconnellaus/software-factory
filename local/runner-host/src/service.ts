// The runner's service, chosen by platform (ADR 0420): a launchd LaunchAgent on macOS, a systemd
// user service on Linux. Both run `bin/sf-runner-service` (ADR 0360) with the same environment, so
// the CLI's `install`, `uninstall`, `status`, `doctor` and the restart after pairing don't care which.
import type { Exec } from "@software-factory/runner-local";
import * as launchd from "./launchd.ts";
import * as systemd from "./systemd.ts";

/** What a service definition needs: the same for launchd and systemd. */
export interface ServiceInput {
  node: string;
  /** `local/runner-host/bin/sf-runner-service` in the runner's checkout. */
  wrapper: string;
  workingDirectory: string;
  path: string;
  home: string;
  logFile: string;
  stateDir: string;
  configFile?: string;
}

export interface ServiceManager {
  kind: "launchd" | "systemd";
  /** The launchd label or the systemd unit. */
  name: string;
  /** Where the definition is written. */
  file: string;
  definition(input: ServiceInput): string;
  install(exec: Exec, file: string, contents: string): Promise<void>;
  uninstall(exec: Exec, file: string): Promise<void>;
  /** Restarts the service if it is installed; false when it isn't. */
  kickstart(exec: Exec): Promise<boolean>;
  /** One line (`state = running…, pid = …, last exit = …`), or null when not installed. */
  status(exec: Exec): Promise<string | null>;
  /** How a person restarts it by hand (after editing `runner.json`). */
  restartCommand: string;
}

/** The service manager for `platform`, or null where the runner has none (it can still `run`). */
export function serviceFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ServiceManager | null {
  if (platform === "darwin") {
    return {
      kind: "launchd",
      name: launchd.LABEL,
      file: launchd.plistPath(env.HOME),
      definition: launchd.plist,
      install: (exec, file, contents) => launchd.install(exec, file, contents),
      uninstall: launchd.uninstall,
      kickstart: launchd.kickstart,
      status: launchd.status,
      restartCommand: `launchctl kickstart -k gui/$(id -u)/${launchd.LABEL}`,
    };
  }
  if (platform === "linux") {
    return {
      kind: "systemd",
      name: systemd.UNIT,
      file: systemd.unitPath(env),
      definition: systemd.unit,
      install: systemd.install,
      uninstall: systemd.uninstall,
      kickstart: systemd.kickstart,
      status: systemd.status,
      restartCommand: `systemctl --user restart ${systemd.UNIT}`,
    };
  }
  return null;
}

/** For `install` on a platform without a service manager here. */
export function unsupported(platform: NodeJS.Platform): Error {
  return new Error(
    `sf-runner has no service for ${platform} (launchd on macOS, systemd on Linux). Run it in the foreground instead: local/runner-host/bin/sf-runner run`,
  );
}
