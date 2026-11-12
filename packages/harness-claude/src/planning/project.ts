// What a planning session adds to a run's harness projection (spec 20, ADR 0350): the relay file,
// the planning MCP server's config, the three hooks, and the conversation to start or resume.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job, PlanningRelay } from "@software-factory/runner-contract";
import { shellQuote } from "../launch.ts";
import type { ClaudeHooks } from "../settings.ts";
import { PLANNING_MCP_SERVER } from "../settings.ts";
import { HOOK_BUDGET_MS, PLANNING_HOOK_EVENTS, STOP_WAIT_TIMEOUT_S } from "./hooks.ts";
import { RELAY_FILE, type RelayInfo } from "./relay.ts";

export const MCP_CONFIG_FILE = "mcp.json";
/** The planning CLI (MCP server and hooks), run from source as `sf-runner` runs. */
export const PLANNING_CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** How a planning session's harness is started. */
export interface PlanningLaunch {
  mcpConfigPath: string;
  sessionRef: string;
  resume: boolean;
}

/** The node invocation for the planning CLI. */
export function planningCommand(nodeBin: string, args: string[]): string[] {
  return [nodeBin, "--experimental-transform-types", "--no-warnings", PLANNING_CLI, ...args];
}

/** The planning hooks for a session whose relay file is `relayFile`. */
export function planningHooks(relayFile: string, nodeBin: string): ClaudeHooks {
  const command = (event: string) =>
    planningCommand(nodeBin, ["hook", event, relayFile]).map(shellQuote).join(" ");
  return {
    PostToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: command(PLANNING_HOOK_EVENTS.PostToolUse),
            timeout: Math.ceil(HOOK_BUDGET_MS / 1000) + 2,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: command(PLANNING_HOOK_EVENTS.UserPromptSubmit),
            timeout: Math.ceil(HOOK_BUDGET_MS / 1000) + 2,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: command(PLANNING_HOOK_EVENTS.Stop),
            // Waits in the background and wakes the model when news is due (kim's Stop hook).
            asyncRewake: true,
            timeout: STOP_WAIT_TIMEOUT_S,
            rewakeMessage: "From the work item's planning:",
            rewakeSummary: "Software factory: planning news",
          },
        ],
      },
    ],
  };
}

/** Merges hook sets: every handler of each event runs. */
export function mergeHooks(...sets: (ClaudeHooks | undefined)[]): ClaudeHooks {
  const out: ClaudeHooks = {};
  for (const set of sets) {
    for (const [event, groups] of Object.entries(set ?? {})) {
      out[event] = [...(out[event] ?? []), ...groups];
    }
  }
  return out;
}

/** Writes the relay file and the MCP config into the run dir (both 0600). */
export async function writePlanningFiles(
  job: Pick<Job, "jobId" | "workItem" | "planning">,
  runDir: string,
  relay: PlanningRelay,
  nodeBin: string,
): Promise<{ relayFile: string; launch: PlanningLaunch }> {
  if (!job.planning) throw new Error(`job ${job.jobId} is not a planning job`);
  const relayFile = join(runDir, RELAY_FILE);
  const info: RelayInfo = {
    url: relay.url,
    token: relay.token,
    jobId: job.jobId,
    workItemNumber: job.workItem.number,
  };
  await writeFile(relayFile, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  await chmod(relayFile, 0o600);
  const [command, ...args] = planningCommand(nodeBin, ["mcp", relayFile]);
  const mcpConfigPath = join(runDir, MCP_CONFIG_FILE);
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers: { [PLANNING_MCP_SERVER]: { type: "stdio", command, args } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    relayFile,
    launch: {
      mcpConfigPath,
      sessionRef: job.planning.sessionRef,
      resume: job.planning.resume,
    },
  };
}
