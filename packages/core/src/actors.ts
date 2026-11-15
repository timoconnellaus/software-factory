// Who is calling (ADR 0004). The surface sets the actor, never the caller: the website and the
// client door set `human` from the session or token, the runner channel sets `runner` from the
// verified signature, the GitHub webhook sets `intake`.
export const ACTOR_TYPES = ["human", "runner", "intake"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Actor {
  type: ActorType;
  /** A user id (human), a runner id (or a device login's fixed id), an intake source. */
  id: string;
}

export const SURFACES = [
  "app",
  "cli",
  "desktop",
  // The phone app (ADR 0541): a `mobile` token's kind sets it, nothing in a request does.
  "mobile",
  "runner-channel",
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
  /**
   * The runner channel's verified signing time (unix seconds) of a heartbeat or claim, which are not
   * kept in the channel's idempotency store: one not newer than the runner's last changes none of
   * the runner's state (ADR 0590). Set by the channel, never the caller.
   */
  signedAt?: number;
}
