// Who is calling (ADR 0004). The surface sets the actor, never the caller: the app sets `human` from
// the signed-in session, the runner channel sets `runner` from the verified signature, the Workflow
// sets `agent` (the foreman), connectors set `intake`.

// `scheduler` is the factory's own pull (ADR 0491): it only starts work a person (or a policy
// that lets agents) already released, so it reads and writes but can do nothing else.
export const ACTOR_TYPES = [
  "human",
  "agent",
  "runner",
  "intake",
  "self-improve",
  "scheduler",
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Actor {
  type: ActorType;
  /** A user id (human), an agent role such as `foreman`, a runner id, an intake source. */
  id: string;
}

export const SURFACES = [
  "app",
  "cli",
  "desktop",
  "mcp",
  "runner-channel",
  "workflow",
  "cron",
  "connector",
  "test",
] as const;
export type Surface = (typeof SURFACES)[number];

export interface Origin {
  surface: Surface;
  workflowId?: string;
  step?: string;
  /** Free-form request id from the surface, for correlating logs. */
  requestId?: string;
  /** The desktop device behind a `desktop` call (ADR 0391). Set by the client door, never the caller. */
  deviceId?: string;
  /**
   * A verified presence proof (ADR 0391): the client door redeemed a Touch ID signature for exactly
   * this operation and the digest of this input. Set by the door, never the caller.
   */
  presence?: { op: string; inputDigest: string; challengeId: string };
}

export const FOREMAN: Actor = { type: "agent", id: "foreman" };
/** The pull (ADR 0491): starts released work under the active limit. Never reviewable by default. */
export const SCHEDULER: Actor = { type: "scheduler", id: "pull" };
/**
 * The babysitter's deliverer (spec 53, ADR 0580): engine code, no model, that lands approved merges
 * per repository. It acts with the item Workflow's actor type, so a merge approval's checks
 * (operation, actor type, work item, used once) hold for it unchanged.
 */
export const BABYSITTER: Actor = { type: "agent", id: "babysitter" };
