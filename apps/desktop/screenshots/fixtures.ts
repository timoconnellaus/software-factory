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
  listed({
    id: "rnr_m5",
    name: "M5",
    light: { max: 6, inUse: 2 },
    accounts: {
      names: ["default", "work"],
      active: "work",
      requested: null,
      limits: [
        {
          name: "default",
          at: ago(90),
          message: "Claude usage limit reached; resets at 5pm",
        },
      ],
    },
  }),
  listed({
    id: "rnr_m1",
    name: "M1",
    version: "41c07aa",
    update: { state: "behind", target: "5da8988", reason: null },
  }),
  listed({ id: "rnr_mini", name: "Mac mini", lastSeenAt: ago(60 * 26), accepting: false }),
];

/**
 * Connect a runner: `BCDF-GHJK` is a Mac waiting to be connected, `MTRX-7Q2P` a code already used;
 * any other code is unknown, as the engine says it. Connecting one adds it to the list, as a runner
 * that hasn't checked in yet.
 */
const WAITING = "BCDF-GHJK";
const USED = "MTRX-7Q2P";
const normalize = (code: string) => {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
};
const connected = new Set<string>();

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
  "runner.deviceLookup": ({ userCode }) => {
    const code = normalize(userCode);
    if (code !== WAITING && code !== USED)
      throw new Refusal("not_found", "no such code: check it against your terminal");
    const done = code === USED || connected.has(code);
    return {
      userCode: code,
      suggestedName: code === WAITING ? "Office-iMac" : "studio",
      status: done ? "consumed" : "pending",
      expiresAt: new Date(now + 8 * 60_000).toISOString(),
      decidedByYou: connected.has(code),
      runnerId: null,
    };
  },
  "runner.approveDevice": ({ userCode, name }) => {
    const code = normalize(userCode);
    if (code !== WAITING || connected.has(code))
      throw new Refusal("conflict", "this code was already used: run `sf-runner login` again");
    connected.add(code);
    const runnerId = "rnr_office";
    RUNNERS.push(
      listed({
        id: runnerId,
        name,
        lastSeenAt: null,
        light: null,
        version: null,
        autoUpdate: null,
        accounts: null,
      }),
    );
    return { runnerId, name };
  },
  "runner.denyDevice": () => ({ denied: true }),
  "runner.account.use": ({ runnerId, name }) => {
    const r = RUNNERS.find((x) => x.id === runnerId);
    if (!r?.accounts) throw new Refusal("conflict", "this runner hasn't reported its accounts");
    r.accounts = { ...r.accounts, requested: name === r.accounts.active ? null : name };
    return { runnerId, requested: name, active: r.accounts.active };
  },
  // A project's Settings, for an org with no GitHub connection: the website's connect flow.
  "github.connectStart": () => ({
    url: "https://github.com/apps/software-factory/installations/new?state=fixture",
    state: "fixture",
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
  }),
};
