// The planning relay (spec 20, ADR 0350): for each planning job the host serves a tiny HTTP endpoint
// on 127.0.0.1 that the harness's planning MCP server and hooks call with a per-job bearer secret.
// The host adds the job's id and fencing token and signs the call onto the channel, so the runner
// key never reaches the harness. Whoever reads the secret can make that job's planning calls and
// nothing else, which the agent can already do through its MCP server.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ChannelCallError,
  type ControlPlaneClient,
  type Job,
  PLANNING_OPS,
  type PlanningOp,
  type PlanningRelay,
} from "@software-factory/runner-contract";

const MAX_BODY = 512 * 1024;

export interface RunningRelay extends PlanningRelay {
  close(): Promise<void>;
}

export interface RelayHooks {
  /** The session agreed to yield (`planning.yield` succeeded): the host ends the harness. */
  onYield(): void;
  /** The cloud refused with 409 (`fenced`, `killed`): the job must stop. */
  onStop(error: ChannelCallError): void;
  log?: (message: string) => void;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Starts the relay for one planning job. `close()` it when the job ends. */
export async function startPlanningRelay(
  job: Job,
  cp: ControlPlaneClient,
  hooks: RelayHooks,
): Promise<RunningRelay> {
  const relayCall = cp.planning?.bind(cp);
  if (!relayCall) throw new Error("this control plane client can't relay planning calls");
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization ?? "");
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        return send(response, 401, { ok: false, error: "unauthorized" });
      }
      if (request.method !== "POST" || request.url !== "/planning") {
        return send(response, 404, { ok: false, error: "not found" });
      }
      const body = JSON.parse(await readBody(request)) as { op?: string; input?: unknown };
      const op = body.op as PlanningOp;
      if (!PLANNING_OPS.includes(op)) {
        return send(response, 400, { ok: false, code: "invalid_input", error: `unknown op ${op}` });
      }
      const input =
        body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
      try {
        const result = await relayCall(job.jobId, {
          fencingToken: job.lease.fencingToken,
          op,
          input,
        });
        if (op === "planning.yield") hooks.onYield();
        return send(response, 200, { ok: true, result });
      } catch (error) {
        if (error instanceof ChannelCallError) {
          if (error.status === 409 && (error.code === "fenced" || error.code === "killed")) {
            hooks.onStop(error);
          }
          let message = error.message;
          try {
            message =
              (JSON.parse(error.message.replace(/^[^{]*/, "")) as { error?: string }).error ??
              message;
          } catch {
            // Keep the raw message.
          }
          return send(response, error.status, { ok: false, code: error.code, error: message });
        }
        throw error;
      }
    } catch (error) {
      hooks.log?.(`planning relay: ${error instanceof Error ? error.message : error}`);
      return send(response, 502, {
        ok: false,
        code: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
