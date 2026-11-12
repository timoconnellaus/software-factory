// Where a `sandbox` runner runs a job's checks (ADR 0501, amended 2026-11-12, fourth review):
//   - Linux: the OS sandbox (srt over bubblewrap, ./check-sandbox.ts): a private network namespace
//     (a loopback of the check's own) and pid namespace, so nothing a check starts outlives it;
//   - macOS with a container runtime that answers: a fresh check container per check
//     (runner-local's `localCheckContainer`), with its own loopback, its own egress proxy, and every
//     process gone with it;
//   - macOS without one: nothing runs (`NO_MAC_CONTAINER_LINE`, "not run: this Mac runner has no
//     container runtime (OrbStack is not answering): …"), unless
//     the runner's owner set `checks.weakerMacSandbox` in runner.json: then the macOS OS sandbox,
//     and the merge gate says the checks ran in the weaker sandbox.
// `sf-runner doctor` reports the same mode (`checkModeReport`).
import type { Job } from "@software-factory/runner-contract";
import type { ContainerRuntime } from "@software-factory/runner-local";
import { containerRuntimeProblem, localCheckContainer } from "@software-factory/runner-local";
import type { CheckDirs } from "./check-sandbox.ts";
import type { Exec } from "./checks.ts";

/** The reason every check of a Mac runner with no container runtime (and no opt-in) reports. */
export const NO_MAC_CONTAINER = "this Mac runner has no container runtime";

/**
 * What a Mac `sandbox` runner with no container runtime says, in one line (fifth review): every
 * declared check comes back not run with it, and doctor and Factory > Runners say the same. The
 * runner still declares `checks`, so the item builds and reaches the gate, where a person decides.
 */
export const NO_MAC_CONTAINER_LINE = `${NO_MAC_CONTAINER} (OrbStack is not answering): start it, or set checks.weakerMacSandbox`;

export type CheckModeName = "container" | "sandbox" | "weaker-sandbox" | "none";

export interface CheckModeOptions {
  platform?: NodeJS.Platform;
  /** runner.json `checks.weakerMacSandbox`: the owner's opt-in to the macOS OS sandbox. */
  weakerMacSandbox?: boolean;
  /** The container runtime (macOS); null: none configured. */
  runtime?: ContainerRuntime | null;
  /** The OS sandbox's check exec (./check-sandbox.ts `checkSandbox`), null where it can't run. */
  sandbox: ((job: Job, dirs: CheckDirs) => Exec) | null;
  /** The container check exec (default: runner-local's, over `runtime`). */
  container?: ((job: Job, dirs: { root: string; dir: string }) => Exec) | null;
  /** The check container's limits (runner.json `checks`; default runner-local's `CHECK_LIMITS`). */
  limits?: { cpus: number; memory: string; tmpSize: string };
}

/** How long a container runtime that answered is trusted before it is asked again. */
const RUNTIME_FRESH_MS = 60_000;

/** Which mode checks run in here, and why: what `sf-runner doctor` says. */
export async function checkModeReport(
  options: Omit<CheckModeOptions, "sandbox" | "container"> & { sandboxAvailable: boolean },
): Promise<{ mode: CheckModeName; why: string }> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const problem = options.runtime
      ? await containerRuntimeProblem(options.runtime)
      : "no container runtime is configured";
    if (!problem)
      return {
        mode: "container",
        why: "a container runtime answers: a fresh check container per check",
      };
    if (options.weakerMacSandbox) {
      return options.sandboxAvailable
        ? {
            mode: "weaker-sandbox",
            why: `no container runtime (${problem}); runner.json checks.weakerMacSandbox is on: the macOS OS sandbox, which can't stop a process a check leaves from outliving it, and the merge gate says so`,
          }
        : { mode: "none", why: `no container runtime (${problem}), and sandbox-exec is missing` };
    }
    return { mode: "none", why: NO_MAC_CONTAINER_LINE };
  }
  if (platform === "linux") {
    return options.sandboxAvailable
      ? { mode: "sandbox", why: "the OS sandbox (bubblewrap): private network and pid namespaces" }
      : {
          mode: "none",
          why: "bubblewrap and socat are not both on PATH: declared checks are reported not run",
        };
  }
  return { mode: "none", why: `no check isolation on ${platform}` };
}

/**
 * The check exec a `sandbox` runner's jobs use (see the top of this file). The mode is decided per
 * check on macOS (the runtime may be started or stopped between jobs), cached while the runtime
 * answers.
 */
export function localChecks(
  options: CheckModeOptions,
): ((job: Job, dirs: CheckDirs) => Exec) | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return options.sandbox;
  const runtime = options.runtime ?? null;
  const container =
    options.container ??
    (runtime
      ? (localCheckContainer({ runtime, ...(options.limits ?? {}) }) as (
          job: Job,
          dirs: { root: string; dir: string },
        ) => Exec)
      : null);
  let answered = 0;
  const problem = async (): Promise<string | null> => {
    if (!runtime || !container) return "no container runtime is configured";
    if (Date.now() - answered < RUNTIME_FRESH_MS) return null;
    const p = await containerRuntimeProblem(runtime);
    if (!p) answered = Date.now();
    return p;
  };
  return (job, dirs) => async (command, signal) => {
    const p = await problem();
    if (!p && container) return container(job, dirs)(command, signal);
    if (options.weakerMacSandbox && options.sandbox)
      return options.sandbox(job, dirs)(command, signal);
    return {
      exitCode: null,
      timedOut: false,
      output: `no container runtime: ${p}`,
      notRun: NO_MAC_CONTAINER_LINE,
    };
  };
}
