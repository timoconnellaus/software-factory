// Wire shapes of the runner channel, as zod schemas: the engine validates every call with them and
// the runner host builds its requests from the inferred types. Change them only with a contract
// version bump (CONTRACT_VERSION in ./types.ts).
import { z } from "zod";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  HARNESS_PERMISSION_MODES,
  HARNESSES,
  JOB_STAGES,
  MODEL_ROLES,
} from "./types.ts";

const iso = z.iso.datetime({ offset: true });
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const fencingToken = z.number().int().nonnegative();
const id = z.string().min(1).max(100);

export const capabilitySchema = z.enum(CAPABILITIES);

export const capabilityManifestSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  /** The adapter kind, e.g. "orca" or "local". Informational: the core never branches on it. */
  runnerKind: z.string().min(1).max(40),
  harnesses: z.array(z.enum(HARNESSES)).min(1),
  capabilities: z.array(capabilitySchema),
});

export const capacitySchema = z.object({
  /** Concurrent jobs this runner will take. */
  max: z.number().int().min(0).max(64),
  /** Jobs currently holding a workspace on this runner. */
  inUse: z.number().int().min(0),
  /** False while draining (the owner paused it); the scheduler sends nothing new. */
  accepting: z.boolean(),
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

export const heartbeatRequestSchema = z.object({
  manifest: capabilityManifestSchema,
  capacity: capacitySchema,
  /** Jobs the host still holds. Each one's lease is renewed if its fencing token is current. */
  activeJobs: z.array(z.object({ jobId: id, fencingToken })),
  /** The harness reported a rate limit: no new jobs until then. */
  rateLimitedUntil: iso.nullable().optional(),
});

export const runnerCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel"), jobId: id, reason: z.string() }),
  z.object({ kind: z.literal("steer"), jobId: id, text: z.string() }),
  z.object({ kind: z.literal("drain") }),
]);

export const heartbeatResponseSchema = z.object({
  commands: z.array(runnerCommandSchema),
  /** New lease expiry per renewed job. */
  leases: z.array(z.object({ jobId: id, expiresAt: iso })),
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
