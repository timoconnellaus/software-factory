// The babysitter's screens (spec 53 §9) through the real router: the Overview's Babysitter line,
// each way a culprit is known, the Held badge, and the red-main Inbox card while its read is out,
// failed or answered. A read that isn't answered never reads as "nothing held".
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const PENDING = 'data-testid="read-pending"';
const ERROR = 'data-testid="read-error"';
const failed = { error: "the factory isn't reachable" };
const REPO = "repo_software-factory";
const SUSPECT = {
  workItemId: "wi_8",
  number: 8,
  title: "Retry a planning session that lost its runner",
  prNumber: 41,
  mergeSha: "4d1c9e2a7b",
};

/** `delivery.status` for the factory's repository: trunk red, #13 held, with `main` overrides. */
function status(main: Record<string, unknown> = {}, branch = "trunk") {
  return {
    result: {
      repositories: [
        {
          repositoryId: REPO,
          owner: "example",
          name: "software-factory",
          branch,
          main: {
            state: "red",
            headSha: "4d1c9e2a7b",
            failing: ["ci"],
            lastGreenSha: "b7e0f31c55",
            redSince: new Date(Date.now() - 18 * 60_000).toISOString(),
            firstRedSha: "4d1c9e2a7b",
            checkedAt: new Date().toISOString(),
            suspects: [SUSPECT],
            culpritWorkItemId: null,
            attribution: null,
            attributedBy: null,
            candidateWorkItemId: null,
            ...main,
          },
          deliveries: [
            {
              workItemId: "wi_13",
              number: 13,
              title: "Guard the tests in verify",
              position: 1,
              state: "held",
              repair: false,
              driver: "babysitter",
              headSha: "9c41e07d2b",
              enqueuedAt: new Date().toISOString(),
            },
          ],
        },
      ],
    },
  };
}

describe("the Overview's Babysitter line", () => {
  it("shows the branch red, what fails and what is held, by the repository's own branch name", async () => {
    const text = textOf(await renderPage("/factory", { answers: { "delivery.status": status() } }));
    expect(text).toContain("trunk is red");
    expect(text).toContain("ci on 4d1c9e2");
    expect(text).toContain("Holding 1 until trunk is green");
  });

  it("says how the culprit is known: proven, named by a person, the job's guess, or still being checked", async () => {
    const said = async (main: Record<string, unknown>) =>
      textOf(await renderPage("/factory", { answers: { "delivery.status": status(main) } }));
    // (textOf puts a space after the item's link: "#8 :".)
    expect(await said({ culpritWorkItemId: "wi_8", attributedBy: "proven" })).toContain(
      "Culprit #8 : proven, the red reproduced",
    );
    expect(await said({ culpritWorkItemId: "wi_8", attributedBy: "person" })).toContain(
      "Culprit #8 : named by a person",
    );
    const guess = await said({ culpritWorkItemId: "wi_8", attributedBy: "agent" });
    expect(guess).toContain("Suspected #8 : the babysit job's guess, not proven");
    expect(guess).not.toContain("Culprit #8");
    expect(await said({ candidateWorkItemId: "wi_8" })).toContain(
      "Checking #8 : rerunning the failing checks",
    );
    expect(await said({})).toContain("1 suspect, none proven");
  });

  it("shows the error with Retry, not an empty line, when its read failed", async () => {
    const html = await renderPage("/factory", { answers: { "delivery.status": failed } });
    expect(html).toContain(ERROR);
    expect(textOf(html)).toContain("Couldn't load the babysitter.");
  });
});

describe("the Held badge", () => {
  it("marks a held item's card with its repository's branch", async () => {
    const html = await renderPage("/work", { answers: { "delivery.status": status() } });
    expect(html).toContain('data-testid="held-wi_13"');
    expect(textOf(html)).toContain("Held: trunk is red");
  });

  it("says the delivery is unknown when its read failed, never nothing", async () => {
    const html = await renderPage("/work", { answers: { "delivery.status": failed } });
    expect(html).not.toContain('data-testid="held-wi_13"');
    expect(html).toContain('data-testid="held-unknown-wi_13"');
  });
});

describe("the red-main Inbox card", () => {
  const inbox = (input: unknown) => ({
    ...(ANSWERS["inbox.list"] as (i: unknown) => Record<string, unknown>)(input),
    mainRed: [
      {
        projectId: "prj_factory",
        name: "Factory",
        repositoryId: REPO,
        repo: { owner: "example", name: "software-factory" },
        branch: "trunk",
        headSha: "4d1c9e2a7b",
        failing: ["ci", "typecheck"],
        redSince: new Date(Date.now() - 18 * 60_000).toISOString(),
        lastGreenSha: "b7e0f31c55",
      },
    ],
  });
  const path = `/?item=main-red-${REPO}`;

  it("shows the failing checks, the culprit, what landed and what is held once loaded", async () => {
    const text = textOf(
      await renderPage(path, {
        answers: {
          "inbox.list": inbox,
          "delivery.status": status({ culpritWorkItemId: "wi_8", attributedBy: "proven" }),
        },
      }),
    );
    expect(text).toContain("trunk is red");
    expect(text).toContain("Failing ci, typecheck on 4d1c9e2 last green b7e0f31");
    expect(text).toContain("Culprit #8 : proven");
    expect(text).toContain("#8 Retry a planning session that lost its runner");
    expect(text).toContain("Held (1) #13 Guard the tests in verify");
  });

  it("shows a skeleton, not 'nothing is waiting', while the babysitter's line loads", async () => {
    const html = await renderPage(path, {
      answers: { "inbox.list": inbox, "delivery.status": status() },
      pending: [["delivery"]],
    });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("Nothing is waiting to merge.");
  });

  it("shows the error with Retry, not 'nothing is waiting', when that read failed", async () => {
    const html = await renderPage(path, {
      answers: { "inbox.list": inbox, "delivery.status": failed },
    });
    expect(html).toContain(ERROR);
    expect(textOf(html)).not.toContain("Nothing is waiting to merge.");
    // What the inbox itself says still shows.
    expect(textOf(html)).toContain("Failing ci, typecheck");
  });
});
