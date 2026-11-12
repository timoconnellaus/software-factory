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
  // The phone app (ADR 0541): a `mobile` token's kind sets it, nothing in a request does.
  "mobile",
  "mcp",
  "runner-channel",
  "workflow",
  "cron",
  "connector",
  "test",
] as const;
export type Surface = (typeof SURFACES)[number];
/** The surfaces whose calls come from a person's own device with a key (ADR 0391, 0541). */
export const DEVICE_SURFACES = ["desktop", "mobile"] as const;
export type DeviceSurface = (typeof DEVICE_SURFACES)[number];
export const isDeviceSurface = (s: Surface): s is DeviceSurface =>
  (DEVICE_SURFACES as readonly string[]).includes(s);

export interface Origin {
  surface: Surface;
  workflowId?: string;
  step?: string;
  /** Free-form request id from the surface, for correlating logs. */
  requestId?: string;
  /**
   * The device behind a `desktop` or `mobile` call (ADR 0391, 0541). Set by the client door, never
   * the caller.
   */
  deviceId?: string;
  /**
   * Who is calling, by network: a hash of the address the door saw (an IPv4 address, or an IPv6
   * /64), for the per-caller limits on the phone's unsigned sign-in (ADR 0541). Set by the door,
   * never the caller.
   */
  caller?: string;
  /**
   * A verified presence proof (ADR 0391, 0541): the client door redeemed a Touch ID or fingerprint
   * signature for exactly this operation and the digest of this input. Set by the door, never the
   * caller.
   */
  presence?: { op: string; inputDigest: string; challengeId: string };
}

export const FOREMAN: Actor = { type: "agent", id: "foreman" };
/** The pull (ADR 0491): starts released work under the active limit. Never reviewable by default. */
export const SCHEDULER: Actor = { type: "scheduler", id: "pull" };
