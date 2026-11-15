// The dock badge and notifications read the new core's inbox across orgs (flow.inbox.all): work
// plus decisions, once per item, each named for its notification.
import { describe, expect, it } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { waitingOnYou } from "../src/shared/flow-inbox.ts";

describe("waitingOnYou", () => {
  it("counts work and decisions across orgs, not what agents are working on", () => {
    const all = ANSWERS["flow.inbox.all"]?.({} as Record<string, never>);
    const waiting = waitingOnYou(all);
    // Personal: API-9 waits on a decision, API-10 and API-7 on you; Client: WEB-31 on you.
    expect(waiting.map((w) => w.line)).toEqual([
      "API-9 waits on a decision: Paginate the audit log endpoint",
      "API-10 needs you: Add rate limiting to the public API",
      "API-7 needs you: Rename the billing plan enum",
      "WEB-31 needs you: Invoice footer shows the old address",
    ]);
    expect(new Set(waiting.map((w) => w.id)).size).toBe(waiting.length);
  });

  it("is nothing before the first read", () => {
    expect(waitingOnYou(undefined)).toEqual([]);
    expect(waitingOnYou({ orgs: [] })).toEqual([]);
  });
});
