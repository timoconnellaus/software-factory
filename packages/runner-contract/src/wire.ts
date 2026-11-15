// Wire shapes of the runner channel, as zod schemas: the engine validates every call with them and
// the runner host builds its requests from the inferred types. Runners keep claiming on older code
// while an update is pending (ADR 0520), so a change here follows the compatibility rule on
// RUNNER_COMPAT in ./types.ts: optional, additive fields and growing enums only, new kinds of job
// gated on a capability, and anything else bumps RUNNER_COMPAT in the same PR.
import { z } from "zod";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  HARNESSES,
  JOB_STAGES,
  MODEL_ROLES,
  SESSION_MODES,
} from "./types.ts";

const iso = z.iso.datetime({ offset: true });

/** Most characters of one `message` event's text; the runner clips longer ones. */
export const MESSAGE_MAX = 8_000;
/** Most characters of one `tool.result` event's output (ADR 0450). */
export const TOOL_OUTPUT_MAX = 4_000;
/** Most characters of a `turn` event's error (ADR 0450). */
export const TURN_ERROR_MAX = 2_000;
/** Most characters of a `takeover` event's hint (ADR 0450; only older runners sent one). */
const TAKEOVER_HINT_MAX = 4_000;
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const fencingToken = z.number().int().nonnegative();
const id = z.string().min(1).max(100);

export const capabilitySchema = z.enum(CAPABILITIES);

export const capabilityManifestSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  /** The adapter kind, e.g. "local". Informational: the core never branches on it. */
  runnerKind: z.string().min(1).max(40),
  harnesses: z.array(z.enum(HARNESSES)).min(1),
  capabilities: z.array(capabilitySchema),
});

export const capacityPausedSchema = z.object({
  reason: z.enum(["load", "tmux", "draining"]),
  pools: z
    .array(z.enum(["heavy", "light"]))
    .min(1)
    .max(2),
  /** The 1-minute load average and the CPU count it was judged against (`load`). */
  load1: z.number().min(0).max(100_000).optional(),
  cores: z.number().int().min(1).max(4_096).optional(),
  detail: z.string().max(300).optional(),
});

export const capacitySchema = z.object({
  /**
   * Concurrent jobs this runner will take. With `light` reported, this is the heavy pool only
   * (ADR 0301), which no job uses now; without it, one pool for every job.
   */
  max: z.number().int().min(0).max(64),
  /** Jobs currently holding a workspace on this runner (in the heavy pool when `light` is set). */
  inUse: z.number().int().min(0),
  /** False while draining (the owner paused it); the scheduler sends nothing new. */
  accepting: z.boolean(),
  /** The light pool (ADR 0301), where flow jobs run. Optional: without it, one pool. */
  light: z
    .object({ max: z.number().int().min(0).max(64), inUse: z.number().int().min(0) })
    .optional(),
  /**
   * Why the runner takes nothing new in some pools for now (ADR 0552), when it doesn't: `load`, the
   * host's 1-minute load average is past its threshold for those pools (heavy stops first, then
   * light), with the numbers; `tmux`, the factory's tmux server isn't answering (ADR 0550);
   * `draining`, the owner drained it (a drain command, or `RunnerHost.drain()`). The
   * scheduler gives a paused pool nothing; with both pools paused `accepting` is false too.
   */
  paused: capacityPausedSchema.optional(),
});

/** One job the scheduler assigned to a runner. Everything a runner needs, nothing more. */
export const jobSchema = z.object({
  jobId: id,
  runId: id,
  /** Run number within the item (or the chat). */
  runNo: z.number().int().positive(),
  stage: z.enum(JOB_STAGES),
  workItem: z.object({ id, number: z.number().int().positive(), title: z.string() }),
  /** The repository, when the item's project has one. Without it: a plain directory, no token or push. */
  repo: z
    .object({
      /** Canonical clone URL; the runner maps it to a local checkout or clones it. */
      url: z.string().url(),
      owner: z.string(),
      name: z.string(),
      /** Where the run starts: the item's branch, or the default branch for its first run. */
      baseRef: z.string(),
      /** The project's default branch. */
      defaultBranch: z.string().optional(),
    })
    .optional(),
  /** The item's branch, `factory/flow-<key>-<n>`: the only branch this run may push. With a repo only. */
  branch: z.string().optional(),
  harness: z.object({
    id: z.enum(HARNESSES),
    role: z.enum(MODEL_ROLES),
    /** The model the role resolves to (ADR 0018); the harness may ignore it. */
    model: z.string().optional(),
    /**
     * How hard the model works (spec 70, Chat): the CLI's effort level ("low" … "max"), a chat's
     * choice or its agent's; absent, or one the harness doesn't know, means the harness's
     * default. A runner that predates it ignores it.
     */
    effort: z.string().max(20).optional(),
    prompt: z.string(),
  }),
  /** What the run is about (its org and status, or its chat). */
  context: z.record(z.string(), z.unknown()),
  /** Capabilities the job needs. A runner refuses a job whose needs its manifest doesn't cover. */
  requires: z.array(capabilitySchema),
  limits: z.object({ sessionTimeoutMs: z.number().int().positive() }),
  /** Every job-scoped call carries `fencingToken`; a stale one is refused (ADR 0035). */
  lease: z.object({ fencingToken, expiresAt: iso }),
  /**
   * MCP servers (streamable HTTP) to give the session, such
   * as the engine's own `factory` server with a bearer token valid while the run is claimed.
   * Optional and additive: a runner that predates it ignores it.
   */
  mcpServers: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .max(10)
    .optional(),
});

const eventBase = { jobId: id, seq: z.number().int().nonnegative(), at: iso };
const takeoverSchema = z.object({ label: z.string(), hint: z.string() });

/** An event on the wire: the per-job seq makes delivery idempotent (the cloud dedupes on it). */
export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("session.started"),
    sessionRef: z.string(),
    takeover: takeoverSchema.optional(),
    /** How the session runs (ADR 0450). Optional, additive: absent is a terminal. */
    mode: z.enum(SESSION_MODES).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("agent.status"),
    status: z.enum(["working", "idle", "waiting_input", "done", "error"]),
    message: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("log"),
    stream: z.enum(["terminal", "stdout", "stderr"]),
    text: z.string().max(64_000),
    /** The visible screen rather than lines that scrolled off (ADR 0400). Optional, additive. */
    screen: z.boolean().optional(),
  }),
  /**
   * What the agent said or was told, from the harness's transcript (ADR 0400). Additive: only a
   * runner at the engine's deployed commit sends it.
   */
  z.object({
    ...eventBase,
    type: z.literal("message"),
    role: z.enum(["assistant", "user"]),
    text: z.string().max(MESSAGE_MAX),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool"),
    name: z.string(),
    input: z.string().max(8_000).optional(),
    /** Pairs the call with its `tool.result` (ADR 0450). Optional, additive. */
    id: z.string().max(100).optional(),
  }),
  /** A stream session's tool result, its call's `id` as `toolId` (ADR 0450). */
  z.object({
    ...eventBase,
    type: z.literal("tool.result"),
    toolId: z.string().max(100),
    output: z.string().max(TOOL_OUTPUT_MAX),
    isError: z.boolean().optional(),
  }),
  /** One turn of a stream session ended (ADR 0450): counts only, never cost. Additive. */
  z.object({
    ...eventBase,
    type: z.literal("turn"),
    outcome: z.enum(["success", "error"]),
    durationMs: z.number().int().nonnegative().optional(),
    turns: z.number().int().nonnegative().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative(),
        cacheWriteTokens: z.number().int().nonnegative(),
      })
      .optional(),
    error: z.string().max(TURN_ERROR_MAX).optional(),
  }),
  /** A stream session handed to a person (ADR 0450): only older runners send it. Kept on the wire. */
  z.object({
    ...eventBase,
    type: z.literal("takeover"),
    sessionId: z.string().max(100),
    hint: z.string().max(TAKEOVER_HINT_MAX),
  }),
  z.object({
    ...eventBase,
    type: z.literal("session.ended"),
    outcome: z.enum(["completed", "failed", "timed_out", "cancelled"]),
    summary: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("job.state"),
    state: z.enum([
      "claimed",
      "preparing",
      "running",
      "collecting",
      "handed_back",
      "failed",
      "released",
    ]),
    detail: z.string().optional(),
  }),
]);

export const artifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("diff"),
    baseSha: sha,
    headSha: sha,
    branch: z.string(),
    patch: z.string(),
    stats: z.object({
      files: z.number().int(),
      insertions: z.number().int(),
      deletions: z.number().int(),
    }),
  }),
  z.object({ kind: z.literal("log"), name: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("screenshot"),
    name: z.string(),
    url: z.string(),
    contentType: z.literal("image/png"),
    base64: z.string(),
  }),
  z.object({ kind: z.literal("summary"), text: z.string() }),
  /**
   * What the run used, per model, read from the harness's own transcript (spec 09 M3, ADR 0373).
   * Counts only: the factory never sees keys or bills (ADR 0023).
   */
  z.object({
    kind: z.literal("usage"),
    harness: z.string().max(40),
    entries: z
      .array(
        z.object({
          model: z.string().max(100),
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          cacheReadTokens: z.number().int().nonnegative().default(0),
          cacheWriteTokens: z.number().int().nonnegative().default(0),
        }),
      )
      .max(20),
    /** First to last message of the session. */
    wallMs: z.number().int().nonnegative().optional(),
  }),
]);

/** An artifact on the wire; `id` is a content hash (`artifactId`) so re-uploads are idempotent. */
export const storedArtifactSchema = z.intersection(
  artifactSchema,
  z.object({ id: z.string().regex(/^a_[0-9a-f]{32}$/), jobId: id }),
);

export const handbackSchema = z.object({
  jobId: id,
  fencingToken,
  outcome: z.enum(["completed", "failed", "timed_out", "cancelled"]),
  summary: z.string().max(20_000).optional(),
  /**
   * Why the run did not complete, alone and short (a refused push, a timeout), apart from the
   * summary, which also carries the agent's own words. What a stopped item shows.
   */
  error: z.string().max(2_000).optional(),
  artifactIds: z.array(z.string()),
  /** The branch the run pushed (the job's branch), or empty for a job without a repository. */
  branch: z.string(),
  /** The branch's head after the push. */
  headSha: sha.optional(),
  /** The run's result (`flowResultSchema`), parsed by the cloud. */
  result: z.unknown().optional(),
});

// ---- requests and responses ----

/** A full git commit SHA. */
export const commitSha = z.string().regex(/^[0-9a-f]{40}$/, "a 40-character commit SHA");

/** Where a runner's self-update stands (ADR 0360). */
export const RUNNER_UPDATE_STATES = [
  "current",
  "waiting",
  "blocked",
  "updating",
  "rolled_back",
] as const;

export const runnerVersionSchema = z.object({
  /** The commit the runner's code is at. */
  sha: commitSha,
  /** Whether it updates itself (`autoUpdate` in its config, default on). */
  autoUpdate: z.boolean(),
  update: z.object({
    /**
     * `current`: at the desired version or ahead of it. `waiting`: behind it, updating at the first
     * idle heartbeat (still claiming; light jobs only once the update has waited too long, nothing
     * once it has waited much longer or the engine needs a newer runner, ADR 0520).
     * `blocked`: behind it and can't update (local changes, auto-update off, not on main…), with
     * the reason. `updating`: applying it now. `rolled_back`: the last update didn't start
     * cleanly and was reverted, with the reason.
     */
    state: z.enum(RUNNER_UPDATE_STATES),
    target: commitSha.nullable(),
    reason: z.string().max(500).nullable(),
    /**
     * What it claims while `waiting` (ADR 0520): `all` as usual, `light` jobs only (the update has
     * waited past its first cap), or `none` (past the second cap, or the engine needs a newer
     * runner). Optional: older runners omit it.
     */
    claims: z.enum(["all", "light", "none"]).optional(),
  }),
});
export type RunnerVersion = z.infer<typeof runnerVersionSchema>;

/**
 * A Claude account's name on a host (ADR 0410). `default` is whatever `claude` uses with no account
 * set. Names only: an account's credential never leaves its host.
 */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_ACCOUNT = "default";
export const accountNameSchema = z.string().regex(ACCOUNT_NAME, "lower-case letters, digits and -");

/** The host's Claude accounts, as it reports them on the heartbeat (ADR 0410). */
export const runnerAccountsSchema = z.object({
  /** Every account on the host, `default` included. */
  names: z.array(accountNameSchema).min(1).max(32),
  /** The one new jobs use. */
  active: accountNameSchema,
  /** Accounts whose last run hit a usage limit: when, and what Claude said. */
  limits: z
    .array(z.object({ name: accountNameSchema, at: iso, message: z.string().max(500) }))
    .max(32)
    .default([]),
});
export type RunnerAccounts = z.infer<typeof runnerAccountsSchema>;

export const heartbeatRequestSchema = z.object({
  manifest: capabilityManifestSchema,
  capacity: capacitySchema,
  /** Jobs the host still holds. Each one's lease is renewed if its fencing token is current. */
  activeJobs: z.array(z.object({ jobId: id, fencingToken })),
  /** The harness reported a rate limit: no new jobs until then. */
  rateLimitedUntil: iso.nullable().optional(),
  /** The runner's own code version and where its self-update stands (ADR 0360). Optional: older hosts omit it. */
  version: runnerVersionSchema.optional(),
  /** The host's Claude accounts, names only (ADR 0410). Optional: older hosts omit it. */
  accounts: runnerAccountsSchema.optional(),
  /**
   * The runner code's RUNNER_COMPAT (ADR 0520), sent with or without self-update. Optional: older
   * hosts omit it, which counts as 1. The engine sends no job to a runner below its own.
   */
  compat: z.number().int().min(0).optional(),
});

export const runnerCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel"), jobId: id, reason: z.string() }),
  z.object({ kind: z.literal("drain") }),
  /** The owner picked this account for new jobs (ADR 0410). Older hosts ignore it. */
  z.object({ kind: z.literal("account.use"), name: accountNameSchema }),
]);

export const heartbeatResponseSchema = z.object({
  commands: z.array(runnerCommandSchema),
  /** New lease expiry per renewed job. */
  leases: z.array(z.object({ jobId: id, expiresAt: iso })),
  /**
   * The runner code the factory runs (ADR 0360, amended by 0520): the last commit on the default
   * branch, at or before the deployed one, that changed runner code. A runner behind it updates
   * itself when idle; one at it or ahead of it is current. Null or missing: unknown (a dev engine),
   * so no update.
   */
  desiredVersion: commitSha.nullable().optional(),
  /**
   * The engine's RUNNER_COMPAT (ADR 0520): a runner whose own is lower claims nothing until it has
   * updated. Optional: an older engine omits it, and then nothing forces a drain.
   */
  minRunnerCompat: z.number().int().min(0).optional(),
});

export const claimRequestSchema = z.object({
  /** Host-generated; a retry of the same claim reuses it and gets the same job back. */
  claimId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  capacity: capacitySchema,
  manifest: capabilityManifestSchema,
});

export const claimResponseSchema = z.object({ job: jobSchema.nullable() });

export const tokenRequestSchema = z.object({ fencingToken });

/** A job token: never stored by the cloud, minted fresh per call (ADR 0033, 0052). */
export const tokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: iso,
  repo: z.object({ owner: z.string(), name: z.string() }),
  /** The one branch this token may be used to push. */
  pushBranch: z.string(),
});

export const eventsRequestSchema = z.object({
  fencingToken,
  events: z.array(runnerEventSchema).max(500),
});

export const artifactRequestSchema = z.object({ fencingToken, artifact: storedArtifactSchema });

export const releaseRequestSchema = z.object({
  jobId: id,
  fencingToken,
  finalState: z.enum(["handed_back", "failed"]),
  reason: z.string().max(2_000).optional(),
});

/** Every non-2xx answer from the channel carries this body. */
export const channelErrorSchema = z.object({
  error: z.string(),
  /** Stable refusal code, e.g. `fenced`, `killed`, `not_found`, `invalid_input`. */
  code: z.string().optional(),
});

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type RunnerCommand = z.infer<typeof runnerCommandSchema>;
export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type ClaimResponse = z.infer<typeof claimResponseSchema>;
export type TokenRequest = z.infer<typeof tokenRequestSchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type EventsRequest = z.infer<typeof eventsRequestSchema>;
export type ArtifactRequest = z.infer<typeof artifactRequestSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type ChannelError = z.infer<typeof channelErrorSchema>;
