// Who is calling (ADR 0004). The surface sets the actor, never the caller: the app sets `human` from
// the signed-in session, the runner channel sets `runner` from the verified signature, the Workflow
// sets `agent` (the foreman), connectors set `intake`.

export const ACTOR_TYPES = ["human", "agent", "runner", "intake", "self-improve"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Actor {
  type: ActorType;
  /** A user id (human), an agent role such as `foreman`, a runner id, an intake source. */
  id: string;
}

export const SURFACES = [
  "app",
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
}

export const FOREMAN: Actor = { type: "agent", id: "foreman" };
