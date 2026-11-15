// The screenshot harness's fixture door (ADR 0460): typed answers to the reads the view makes, so
// every screen can be shot without an engine, and the route and behaviour tests see the same data.
// The new core's answers are in flow-fixtures.ts; here are who is signed in and this person's
// runners. Never shipped: the app's own bridge talks to the main process.
import type { OpInput, OpName, OpOutput } from "@software-factory/client/ops";
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

type Answers = { [N in OpName]?: (input: OpInput<N>) => OpOutput<N> };

export const ANSWERS: Answers = {
  // The new core's (spec 70): flow-fixtures.ts.
  ...FLOW_ANSWERS,
  "org.list": () => ({
    userId: ME,
    orgs: [
      { id: PERSONAL, name: "Personal", kind: "personal", role: "owner" },
      { id: CLIENT, name: "Client", kind: "team", role: "admin" },
    ],
  }),
  "runner.list": () => ({ runners: RUNNERS }),
};
