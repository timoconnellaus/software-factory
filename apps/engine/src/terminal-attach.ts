// Opening a run's web terminal for a person (spec 35, ADR 0440), shared by both ways in: sf-app's
// socket route (through EngineApi.terminalAttach) and the client door's `terminal` socket for the
// desktop app (spec 42, ADR 0500). `run.terminal.attach` as the person decides `type` or `watch` and
// records the attach; the job's relay then mints a one-use viewer ticket bound to it.
import {
  type Actor,
  invoke,
  isOperationError,
  type Origin,
  type Refusal,
  toRefusal,
} from "@software-factory/core";
import { TERMINAL_PATHS, type TerminalMode } from "@software-factory/runner-contract";
import { invokeDeps } from "./deps.ts";
import { terminalRelay } from "./terminal-relay.ts";

export type TerminalAttachResult =
  | { ok: true; jobId: string; mode: TerminalMode; attachId: string; path: string }
  | { ok: false; error: Refusal };

export async function attachTerminal(
  env: Env,
  workItemId: string,
  runId: string,
  options: { actor: Actor; origin: Origin },
): Promise<TerminalAttachResult> {
  const deps = invokeDeps(env);
  let attached: { attachId: string; jobId: string; mode: TerminalMode };
  try {
    const result = await invoke(deps, "run.terminal.attach", { workItemId, runId }, options);
    if (result.status !== "ok") {
      return {
        ok: false,
        error: { code: "unavailable", message: "the attach is held for review" },
      };
    }
    attached = result.output as typeof attached;
  } catch (error) {
    if (isOperationError(error)) return { ok: false, error: toRefusal(error) };
    throw error;
  }
  const relay = terminalRelay(env, attached.jobId);
  const admitted = await relay.admit({
    attachId: attached.attachId,
    userId: options.actor.id,
    workItemId,
    mode: attached.mode,
  });
  if (!admitted.ok) {
    // Refused for room: the attach closes at once.
    await invoke(
      deps,
      "run.terminal.detach",
      { workItemId, attachId: attached.attachId },
      options,
    ).catch(() => {});
    return { ok: false, error: { code: "conflict", message: admitted.reason } };
  }
  return {
    ok: true,
    jobId: attached.jobId,
    mode: attached.mode,
    attachId: attached.attachId,
    path: `${TERMINAL_PATHS.view(attached.jobId)}?ticket=${admitted.ticket}`,
  };
}

/** The relay's viewer socket for a ticket `attachTerminal` gave (the upgrade goes to the browser). */
export function openViewerSocket(env: Env, jobId: string, path: string): Promise<Response> {
  return terminalRelay(env, jobId).fetch(
    new Request(`https://sf-engine.internal${path}`, { headers: { upgrade: "websocket" } }),
  );
}
