// What a stage waits on when no job runs for it (lib/stage-wait.ts): the owner's "1 running" with
// every runner slot free was verify waiting on GitHub's CI. The wording, and the board's hook
// reading it from the item's and the project's cached reads.
import type { OpOutput } from "@software-factory/client/ops";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { type StageFacts, stageWait } from "../src/mainview/lib/stage-wait.ts";
import { useStageWait } from "../src/mainview/lib/use-stage-wait.ts";
import { textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const T0 = "2026-11-13T10:00:00.000Z";
const T1 = "2026-11-13T10:05:00.000Z";
const T2 = "2026-11-13T10:20:00.000Z";
const T3 = "2026-11-13T10:30:00.000Z";
const verify = (over: Partial<StageFacts> = {}): StageFacts => ({
  item: { stage: "verify", status: "running" },
  stages: [
    { stage: "build", startedAt: "2026-11-13T09:00:00.000Z", endedAt: T0 },
    { stage: "verify", startedAt: T0, endedAt: null },
  ],
  runs: [],
  reviewPacket: null,
  ...over,
});
const run = (status: string, startedAt: string, endedAt: string | null, stage = "verify") => ({
  stage,
  status,
  startedAt,
  endedAt,
});

describe("stageWait: verify", () => {
  it("waits for a runner when no verify run has started this attempt", () => {
    expect(stageWait(verify())).toBe("Verify: waiting for a runner");
    // A verify run from an earlier attempt doesn't count.
    expect(
      stageWait(
        verify({
          runs: [run("completed", "2026-11-13T08:00:00.000Z", "2026-11-13T08:10:00.000Z")],
        }),
      ),
    ).toBe("Verify: waiting for a runner");
  });

  it("says nothing while a verify run holds a slot", () => {
    for (const status of ["claimed", "preparing", "running", "collecting"])
      expect(stageWait(verify({ runs: [run(status, T1, null)] }))).toBeNull();
  });

  it("waits on CI once the runner handed back and no packet has been recorded since", () => {
    expect(stageWait(verify({ runs: [run("completed", T1, T2)] }))).toBe("Verify: waiting on CI");
    // A packet from an earlier round doesn't answer this one.
    expect(
      stageWait(verify({ runs: [run("completed", T1, T2)], reviewPacket: { createdAt: T1 } })),
    ).toBe("Verify: waiting on CI");
    // Recorded since: CI has answered, the stage moves on.
    expect(
      stageWait(verify({ runs: [run("completed", T1, T2)], reviewPacket: { createdAt: T3 } })),
    ).toBeNull();
  });

  it("says nothing it can't tell, or for an item not moving on its own", () => {
    expect(stageWait(verify({ stages: undefined }))).toBeNull();
    expect(stageWait(verify({ item: { stage: "verify", status: "paused" } }))).toBeNull();
    expect(stageWait(verify({ item: { stage: "build", status: "running" } }))).toBeNull();
  });
});

describe("stageWait: merge", () => {
  const merge = (over: Partial<StageFacts> = {}): StageFacts => ({
    item: { stage: "merge", status: "waiting" },
    ...over,
  });

  it("says its place in the queue", () => {
    expect(stageWait(merge({ mergeQueue: { position: 3 } }))).toBe(
      "Merge: in the queue (position 3)",
    );
    expect(stageWait(merge({ mergeQueue: { position: 1 } }))).toBe(
      "Merge: in the queue (position 1, next to land)",
    );
    expect(stageWait(merge({ delivery: { position: 2, state: "waiting", branch: "main" } }))).toBe(
      "Merge: in the queue (position 2)",
    );
  });

  it("says when a red main holds it", () => {
    expect(stageWait(merge({ delivery: { position: 2, state: "held", branch: "main" } }))).toBe(
      "Merge: held, main is red",
    );
  });

  it("says nothing out of the queue (the gate: it needs a person)", () => {
    expect(stageWait(merge())).toBeNull();
  });
});

function Probe(props: { id: string; projectId: string; stage: string; status: string }) {
  return <span>{useStageWait(props) ?? "none"}</span>;
}

describe("useStageWait on a board card", () => {
  const render = (client: QueryClient, props: Parameters<typeof Probe>[0]) =>
    renderToString(
      <QueryClientProvider client={client}>
        <Probe {...props} />
      </QueryClientProvider>,
    );

  it("reads the item for a card in verify", () => {
    const client = new QueryClient();
    const f = verify({ runs: [run("completed", T1, T2)] });
    client.setQueryData(["workItem", "wi_1"], {
      stages: f.stages,
      runs: f.runs,
      reviewPacket: null,
      mergeQueue: null,
    });
    expect(
      render(client, { id: "wi_1", projectId: "p", stage: "verify", status: "running" }),
    ).toContain("Verify: waiting on CI");
  });

  it("reads the project's deliveries for a card in merge", () => {
    const client = new QueryClient();
    client.setQueryData(["delivery", "p"], {
      repositories: [
        {
          branch: "main",
          deliveries: [
            { workItemId: "wi_0", position: 1, state: "merging" },
            { workItemId: "wi_2", position: 2, state: "waiting" },
          ],
        },
      ],
    });
    expect(
      render(client, { id: "wi_2", projectId: "p", stage: "merge", status: "waiting" }),
    ).toContain("Merge: in the queue (position 2)");
  });

  it("reads nothing for other stages", () => {
    const client = new QueryClient();
    expect(
      render(client, { id: "wi_3", projectId: "p", stage: "build", status: "running" }),
    ).toContain("none");
  });
});

/** A verify run, started at T1, as `workItem.get` lists it. */
const verifyRun = (
  status: string,
  endedAt: string | null,
): OpOutput<"workItem.get">["runs"][number] => ({
  id: "run_v1",
  jobId: "job_v1",
  runNo: 1,
  stage: "verify",
  runnerId: "runner_m5",
  branch: "sf/5",
  status,
  outcome: endedAt ? "completed" : null,
  summary: null,
  headSha: "abc1234",
  takeover: null,
  startedAt: T1,
  endedAt,
  log: "kept",
  archiveIncident: null,
});

async function strip(detail: OpOutput<"workItem.get">) {
  const { StageStrip } = await import("../src/mainview/routes/work.$id.index.tsx");
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <StageStrip detail={detail} />
    </QueryClientProvider>,
  );
}

describe("the item page's stage strip", () => {
  const base = () =>
    ANSWERS["workItem.get"]?.({ workItemId: "wi_crm_5" }) as OpOutput<"workItem.get">;

  it("says verify is waiting on CI after the runner handed back", async () => {
    const d = base();
    const answer = {
      ...d,
      item: { ...d.item, stage: "verify" as const, status: "running" as const },
      stages: [
        {
          stage: "build" as const,
          attempt: 1,
          status: "done",
          reason: null,
          startedAt: "2026-11-13T09:00:00.000Z",
          endedAt: T0,
        },
        {
          stage: "verify" as const,
          attempt: 1,
          status: "running",
          reason: null,
          startedAt: T0,
          endedAt: null,
        },
      ],
      runs: [verifyRun("completed", T2)],
      reviewPacket: null,
    };
    const html = await strip(answer);
    expect(html).toContain('data-testid="stage-wait"');
    expect(textOf(html)).toContain("Verify: waiting on CI");
  });

  it("says nothing extra while a job runs for the stage", async () => {
    const d = base();
    const answer = {
      ...d,
      item: { ...d.item, stage: "verify" as const, status: "running" as const },
      stages: [
        {
          stage: "verify" as const,
          attempt: 1,
          status: "running",
          reason: null,
          startedAt: T0,
          endedAt: null,
        },
      ],
      runs: [verifyRun("running", null)],
    };
    const html = await strip(answer);
    expect(html).not.toContain('data-testid="stage-wait"');
  });
});
