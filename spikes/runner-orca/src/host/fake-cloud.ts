// A stand-in for the cloud end of the runner channel, for tests and the end-to-end scripts. It
// serves the real signed protocol (handleRunnerCall: verify, idempotency, then handle) from a
// `fetch` function, so httpControlPlane talks to it exactly as it would to the engine Worker.

import { handleRunnerCall, memoryIdempotencyStore, runnerChannelKey } from "../contract/channel.ts";
import type { ClaimRequest, HeartbeatRequest, RunnerCommand } from "../contract/protocol.ts";
import { PATHS } from "../contract/protocol.ts";
import type { Handback, Job, RunnerEvent, StoredArtifact } from "../contract/types.ts";

export interface FakeCloud {
  fetch: typeof fetch;
  masterSecret: string;
  queue: Job[];
  claims: Map<string, Job>;
  events: Map<string, RunnerEvent[]>;
  artifacts: Map<string, StoredArtifact>;
  handbacks: Map<string, Handback>;
  released: Set<string>;
  heartbeats: HeartbeatRequest[];
  commands: RunnerCommand[];
  /** How many handler runs happened (a replayed call doesn't count). */
  handled: number;
}

export function createFakeCloud(masterSecret = "test-master-secret"): FakeCloud {
  const store = memoryIdempotencyStore();
  const cloud: FakeCloud = {
    masterSecret,
    queue: [],
    claims: new Map(),
    events: new Map(),
    artifacts: new Map(),
    handbacks: new Map(),
    released: new Set(),
    heartbeats: [],
    commands: [],
    handled: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      return handleRunnerCall(
        request,
        { keyFor: (runner) => runnerChannelKey(masterSecret, runner), store },
        async ({ path, body }) => {
          cloud.handled++;
          if (path === PATHS.heartbeat) {
            cloud.heartbeats.push(body as HeartbeatRequest);
            return { commands: cloud.commands.splice(0) };
          }
          if (path === PATHS.claim) {
            const { claimId } = body as ClaimRequest;
            const job = cloud.claims.get(claimId) ?? cloud.queue.shift() ?? null;
            if (job) cloud.claims.set(claimId, job);
            return { job };
          }
          const match = path.match(/^\/runner\/v1\/jobs\/([^/]+)\/(\w+)$/);
          if (!match) return { error: "unknown path" };
          const jobId = decodeURIComponent(match[1] ?? "");
          switch (match[2]) {
            case "events": {
              const list = cloud.events.get(jobId) ?? [];
              const seen = new Set(list.map((e) => e.seq));
              for (const e of (body as { events: RunnerEvent[] }).events) {
                if (!seen.has(e.seq)) list.push(e);
              }
              cloud.events.set(jobId, list);
              return { ok: true };
            }
            case "artifacts": {
              const { artifact } = body as { artifact: StoredArtifact };
              cloud.artifacts.set(artifact.id, artifact);
              return { ok: true };
            }
            case "handback":
              cloud.handbacks.set(jobId, body as Handback);
              return { ok: true };
            case "release":
              cloud.released.add(jobId);
              return { ok: true };
            default:
              return { error: "unknown path" };
          }
        },
      );
    },
  };
  return cloud;
}
