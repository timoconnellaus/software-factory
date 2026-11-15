// A flow job's MCP servers (spec 70 milestone 2): the job may name streamable-HTTP MCP servers (the
// engine's own `factory` server, with a bearer token valid while the run is claimed). They go into
// the run's MCP config, `<runDir>/mcp.json` (0600, denied to the Read tool), passed with
// `--mcp-config` as a planning session's own server is. The run dir is removed on release, so the
// token never outlives the job; it is never in the settings, the launch record, the argv or a log.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "@software-factory/runner-contract";
import { MCP_CONFIG_FILE } from "./planning/project.ts";

/** A server name that is safe in a permission rule (`mcp__<name>__*`): no wildcards, no spaces. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** The MCP servers a job's session gets: a flow job's own, none for any other stage. */
export function flowMcpServers(job: Partial<Pick<Job, "stage" | "mcpServers">>) {
  if (job.stage !== "flow" || !job.mcpServers?.length) return [];
  for (const server of job.mcpServers) {
    if (!SERVER_NAME.test(server.name)) {
      throw new Error(`MCP server name ${JSON.stringify(server.name)} is not [A-Za-z0-9_-]+`);
    }
  }
  return job.mcpServers;
}

/** Writes the servers into `<runDir>/mcp.json` as HTTP servers with their headers (0600). */
export async function writeFlowMcpConfig(
  runDir: string,
  servers: NonNullable<Job["mcpServers"]>,
): Promise<string> {
  const mcpServers = Object.fromEntries(
    servers.map((s) => [
      s.name,
      { type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
    ]),
  );
  const path = join(runDir, MCP_CONFIG_FILE);
  await writeFile(path, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
