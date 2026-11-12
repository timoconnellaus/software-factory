// Wire shapes of the runner channel, as zod schemas: the engine validates every call with them and
// the runner host builds its requests from the inferred types. Change them only with a contract
// version bump (CONTRACT_VERSION in ./types.ts), except for optional, additive fields an older
// runner never receives (ADR 0350: the light pool, the planning stage and the planning call).
import { z } from "zod";
import { PLANNING_OPS } from "./planning.ts";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  HARNESS_PERMISSION_MODES,
  HARNESSES,
  JOB_STAGES,
  MODEL_ROLES,
} from "./types.ts";

const iso = z.iso.datetime({ offset: true });

/** Most characters of one `message` event's text; the runner clips longer ones. */
export const MESSAGE_MAX = 8_000;
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

export const capacitySchema = z.object({
  /**
   * Concurrent jobs this runner will take. With `light` reported, this is the heavy pool (build,
   * verify) only (ADR 0301); without it, one pool for every job.
   */
  max: z.number().int().min(0).max(64),
  /** Jobs currently holding a workspace on this runner (in the heavy pool when `light` is set). */
  inUse: z.number().int().min(0),
  /** False while draining (the owner paused it); the scheduler sends nothing new. */
  accepting: z.boolean(),
  /**
   * The light pool (triage, spec, planning), ADR 0301. Optional: a runner that reports none
   * shares one pool and takes no planning jobs.
   */
  light: z
    .object({ max: z.number().int().min(0).max(64), inUse: z.number().int().min(0) })
    .optional(),
});

/** A host name a sandboxed command may reach: `example.com` or `*.example.com`, never `*`. */
const allowedDomain = z
  .string()
  .max(253)
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a host name, or *.host");

/** A Claude Code permission rule: `Tool` or `Tool(specifier)`. */
const permissionRule = z
  .string()
  .max(500)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\(.+\))?$/, "a permission rule like Bash(pnpm test:*)");

/**
 * The project's harness settings (ADR 0270), from `.factory/policy.json` on the default branch,
 * carried on each job. They can only choose a mode and add to allowlists: the deny rules, the
 * sandbox and its `allowUnsandboxedCommands: false` are the harness's floor and can't be changed.
 */
export const harnessProfileSchema = z
  .object({
    /** Permission mode per stage. Default: `bypassPermissions` (sandboxed) for build, else `dontAsk`. */
    permissionMode: z
      .partialRecord(z.enum(JOB_STAGES), z.enum(HARNESS_PERMISSION_MODES))
      .optional(),
    /** Extra allow rules per stage, on top of the stage's own. Deny rules still win. */
    allow: z.partialRecord(z.enum(JOB_STAGES), z.array(permissionRule).max(100)).optional(),
    /** Extra hosts sandboxed commands may reach, on top of the registry, GitHub and Cloudflare. */
    allowedDomains: z.array(allowedDomain).max(100).optional(),
  })
  .strict();
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

/** One stage job the scheduler assigned to a runner. Everything a runner needs, nothing more. */
export const jobSchema = z.object({
  jobId: id,
  runId: id,
  /** Run number within the work item (1, 2, …). Retries and send-backs get a new run. */
  runNo: z.number().int().positive(),
  stage: z.enum(JOB_STAGES),
  workItem: z.object({ id, number: z.number().int().positive(), title: z.string() }),
  repo: z.object({
    /** Canonical clone URL; the runner maps it to a local checkout or clones it. */
    url: z.string().url(),
    owner: z.string(),
    name: z.string(),
    /** Where the run starts: the work item branch `factory/<n>-<slug>`. */
    baseRef: z.string(),
    /**
     * The project's default branch (ADR 0320). A build merges it into the run branch before the
     * session, so the PR stays mergeable. Optional: a job without it skips the merge.
     */
    defaultBranch: z.string().optional(),
  }),
  /** The run branch, `factory/<n>-<slug>-run-<k>`. The only branch this run may push (ADR 0035). */
  branch: z.string(),
  harness: z.object({
    id: z.enum(HARNESSES),
    role: z.enum(MODEL_ROLES),
    /** The model the role resolves to (ADR 0018); the harness may ignore it. */
    model: z.string().optional(),
    prompt: z.string(),
    /**
     * The project's harness settings (ADR 0270). Optional and additive: a runner that predates it
     * ignores it, and a job without one gets the harness defaults.
     */
    profile: harnessProfileSchema.optional(),
  }),
  /** Stage input (spec, acceptance criteria, send-back notes). Never holdout tests (ADR 0034). */
  context: z.record(z.string(), z.unknown()),
  /**
   * A planning job (ADR 0300, 0350): the session it belongs to, the harness conversation to start
   * (`--session-id`) or resume (`--resume`), and whether this is a resume. The workspace is the
   * session's, kept across yields.
   */
  planning: z
    .object({
      sessionId: id,
      sessionRef: z.string().regex(/^[0-9a-f-]{36}$/),
      resume: z.boolean(),
    })
    .optional(),
  /** Capabilities the job needs. A runner refuses a job whose needs its manifest doesn't cover. */
  requires: z.array(capabilitySchema),
  /** Visual evidence to capture after the session, when the runner has `browser`. */
  evidence: z.object({ screenshotUrls: z.array(z.string()).optional() }).optional(),
  limits: z.object({ sessionTimeoutMs: z.number().int().positive() }),
  /** Every job-scoped call carries `fencingToken`; a stale one is refused (ADR 0035). */
  lease: z.object({ fencingToken, expiresAt: iso }),
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
  artifactIds: z.array(z.string()),
  /** The branch the run pushed. Must be the job's run branch. */
  branch: z.string(),
  /** The run branch's head after the push. Required for `build` (the cloud checks it on GitHub). */
  headSha: sha.optional(),
  /** The stage's structured result (./stage-results.ts), parsed by the cloud per stage. */
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
     * `current`: at the desired version. `waiting`: behind it, draining until its jobs finish.
     * `blocked`: behind it and can't update (local changes, auto-update off, not on main…), with
     * the reason. `updating`: applying it now. `rolled_back`: the last update didn't start
     * cleanly and was reverted, with the reason.
     */
    state: z.enum(RUNNER_UPDATE_STATES),
    target: commitSha.nullable(),
    reason: z.string().max(500).nullable(),
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
});

export const runnerCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel"), jobId: id, reason: z.string() }),
  z.object({ kind: z.literal("steer"), jobId: id, text: z.string() }),
  z.object({ kind: z.literal("drain") }),
  /** The owner picked this account for new jobs (ADR 0410). Older hosts ignore it. */
  z.object({ kind: z.literal("account.use"), name: accountNameSchema }),
]);

export const heartbeatResponseSchema = z.object({
  commands: z.array(runnerCommandSchema),
  /** New lease expiry per renewed job. */
  leases: z.array(z.object({ jobId: id, expiresAt: iso })),
  /**
   * The runner code the factory runs (ADR 0360): the commit of the default branch the engine was
   * deployed from. A runner behind it updates itself when idle. Null or missing: unknown (a dev
   * engine), so no update.
   */
  desiredVersion: commitSha.nullable().optional(),
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

/** One work item attachment as a run sees it (ADR 0310). Its filename is untrusted data. */
export const attachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: iso,
});

export const attachmentsRequestSchema = z.object({ fencingToken });
export const attachmentsResponseSchema = z.object({ attachments: z.array(attachmentMetaSchema) });
export const attachmentRequestSchema = z.object({ fencingToken, attachmentId: z.string() });
export const attachmentResponseSchema = z.object({
  attachment: attachmentMetaSchema,
  /** The file's bytes, base64. */
  base64: z.string(),
});

/**
 * The held steer call (ADR 0400): the run's queued messages, at once if there are any, else when one
 * arrives or after about `waitMs` (at most STEER_WAIT_MAX_MS) with none.
 */
export const steersRequestSchema = z.object({
  fencingToken,
  waitMs: z.number().int().min(0).max(60_000).optional(),
});
export const steersResponseSchema = z.object({
  steers: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      at: iso,
      /** Stop the current step first (`adapter.interrupt`, ADR 0470); else type it as is. */
      interrupt: z.boolean().optional(),
    }),
  ),
});
export type SteersRequest = z.infer<typeof steersRequestSchema>;

/**
 * The held terminal call (ADR 0440): answers with the job relay's socket URL, carrying a one-use
 * ticket, when someone is waiting to watch and no host is connected; else `connect: null` after
 * about `waitMs` (at most TERMINAL_WAIT_MAX_MS).
 */
export const terminalCallRequestSchema = z.object({
  fencingToken,
  waitMs: z.number().int().min(0).max(60_000).optional(),
});
export const terminalCallResponseSchema = z.object({
  connect: z.object({ url: z.string() }).nullable(),
});
export type TerminalCallRequest = z.infer<typeof terminalCallRequestSchema>;
export type TerminalCallResponse = z.infer<typeof terminalCallResponseSchema>;
export type SteersResponse = z.infer<typeof steersResponseSchema>;

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
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;
export type AttachmentsResponse = z.infer<typeof attachmentsResponseSchema>;
export type AttachmentResponse = z.infer<typeof attachmentResponseSchema>;

/**
 * A planning operation from a planning job's harness, relayed by the host (ADR 0350). The cloud adds
 * the job id from the path and runs `op` as the runner, scoped to the job's work item.
 */
export const planningCallRequestSchema = z.object({
  fencingToken,
  op: z.enum(PLANNING_OPS),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type PlanningCallRequest = z.infer<typeof planningCallRequestSchema>;
