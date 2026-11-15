// The screenshot harness's fixture door (ADR 0460): typed answers to the reads the view makes, so
// every screen can be shot without an engine, and the route and behaviour tests see the same data.
// The new core's answers are in flow-fixtures.ts; here are who is signed in and this person's
// runners. Never shipped: the app's own bridge talks to the main process.
import type { OpInput, OpName, OpOutput } from "@software-factory/client/ops";
import { AUTO_ANSWERS } from "./flow-auto-fixtures.ts";
import { FLOW_ANSWERS } from "./flow-fixtures.ts";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const ME = "usr_owner";
const PERSONAL = "org_personal";
const CLIENT = "org_client";

/** A refusal in the server's shape: the fake door answers `{ ok: false, code, error }`. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listed = OpOutput<"runner.list">["runners"][number];
type Health = OpOutput<"inbox.list">["runners"][number];

const listed = (over: Partial<Listed> & Pick<Listed, "id" | "name">): Listed => ({
  ownerUserId: ME,
  keyVersion: 1,
  manifest: {
    contractVersion: "1",
    runnerKind: "local",
    harnesses: ["claude-code"],
    capabilities: ["checks"],
  },
  capacityMax: 2,
  light: { max: 6, inUse: 0 },
  accepting: true,
  rateLimitedUntil: null,
  lastSeenAt: ago(0),
  version: "5da8988",
  desiredVersion: "5da8988",
  autoUpdate: true,
  update: null,
  accounts: { names: ["work"], active: "work", requested: null, limits: [] },
  ...over,
});

/** This person's runners: the M5 busy, the M1 behind on its code, an old Mac offline. */
const RUNNERS: Listed[] = [
  listed({ id: "rnr_m5", name: "M5", light: { max: 6, inUse: 2 } }),
  listed({
    id: "rnr_m1",
    name: "M1",
    version: "41c07aa",
    update: { state: "behind", target: "5da8988", reason: null },
  }),
  listed({ id: "rnr_mini", name: "Mac mini", lastSeenAt: ago(60 * 26), accepting: false }),
];

const HEALTH: Health[] = [
  {
    id: "rnr_m5",
    name: "M5",
    state: "busy",
    inUse: 1,
    max: 2,
    light: { inUse: 2, max: 6 },
    rateLimitedUntil: null,
    lastSeenAt: ago(0),
    paused: null,
    update: null,
  },
  {
    id: "rnr_m1",
    name: "M1",
    state: "online",
    inUse: 0,
    max: 2,
    light: { inUse: 0, max: 6 },
    rateLimitedUntil: null,
    lastSeenAt: ago(0),
    paused: null,
    update: { state: "behind", reason: null },
  },
  {
    id: "rnr_mini",
    name: "Mac mini",
    state: "offline",
    inUse: 0,
    max: 2,
    light: null,
    rateLimitedUntil: null,
    lastSeenAt: ago(60 * 26),
    paused: null,
    update: null,
  },
];

type Answers = { [N in OpName]?: (input: OpInput<N>) => OpOutput<N> };

export const ANSWERS: Answers = {
  // The new core's (spec 70): flow-fixtures.ts.
  ...FLOW_ANSWERS,
  // Auto's schedules: flow-auto-fixtures.ts.
  ...AUTO_ANSWERS,
  "org.list": () => ({
    userId: ME,
    orgs: [
      { id: PERSONAL, name: "Personal", kind: "personal", role: "owner" },
      { id: CLIENT, name: "Client", kind: "team", role: "admin" },
    ],
  }),
  "runner.list": () => ({ runners: RUNNERS }),
  // Only the runners' health is read from the old inbox (Team > Runners).
  "inbox.list": () => ({
    gates: [],
    questions: [],
    running: [],
    runners: HEALTH,
    planning: [],
    wipHolds: [],
    protection: [],
    releaseFlags: [],
    mainRed: [],
  }),
};
