// The engine's MCP server's bearer tokens (spec 70 milestone 2). A token is issued when a flow run
// whose agent has the "factory" server is claimed, and names that run: `<runId>.<secret>`. Only its
// SHA-256 is stored, on the run's row; it is good while the run is claimed and for nothing else.
import type { AgentCaller } from "@software-factory/ops";
import { type Run, runForToken, setMcpTokenHash } from "@software-factory/store";

/** The name an agent's `mcp` uses for the engine's own MCP server. */
export const FACTORY_MCP = "factory";
/** Where the engine serves it. */
export const MCP_PATH = "/flow/mcp";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Makes the run's token and stores its hash. */
export async function issueMcpToken(d1: D1Database, runId: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const token = `${runId}.${secret}`;
  await setMcpTokenHash(d1, runId, await sha256(token));
  return token;
}

/**
 * The run and the agent a request's bearer token stands for, or null: no token, an unknown run, a
 * wrong token, or a run that isn't claimed (finished, failed, cancelled, or not yet claimed). One
 * read by primary key.
 */
export async function authenticateMcp(
  d1: D1Database,
  authorization: string | null,
): Promise<{ run: Run; caller: AgentCaller } | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  const runId = token?.split(".")[0];
  if (!token || !runId) return null;
  const found = await runForToken(d1, runId);
  if (!found?.tokenHash || found.run.status !== "claimed") return null;
  if ((await sha256(token)) !== found.tokenHash) return null;
  return {
    run: found.run,
    caller: {
      kind: "agent",
      id: found.run.agentId,
      orgId: found.run.orgId,
      onBehalfOf: found.itemCreatedBy,
    },
  };
}
