// What a stage waits on (lib/stage-wait.ts): the owner's "1 running" with every runner slot free
// was verify waiting on GitHub's CI. The server says what each item waits on (`waitingOn` on
// `workItem.board`, `workItem.list` and `workItem.get`, core's waiting-on.ts); the app only puts it
// in words, reads nothing per card, and says nothing once a read has failed.
import type { BoardItem, OpOutput } from "@software-factory/client/ops";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { readFailedStore, stageWait, type WaitingOn } from "../src/mainview/lib/stage-wait.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const at = (stage: string, waitingOn: WaitingOn, status = "running") =>
  stageWait({ stage, status, waitingOn });

describe("stageWait", () => {
  it("says what verify waits on, as the server says it", () => {
    expect(at("verify", { kind: "runner" })).toBe("Verify: waiting for a runner");
    expect(at("verify", { kind: "ci" })).toBe("Verify: waiting on CI");
    expect(at("verify", { kind: "person", on: "question" })).toBe("Verify: waiting for an answer");
    expect(at("verify", { kind: "person", on: "gate" })).toBe("Verify: waiting for an approval");
  });

  it("never says CI when the server doesn't (a slot agent after the packet, or no fact)", () => {
    // After the packet, verify's afterVerify slot steps run with stage verify: the server says
    // agent, runner or person for them, or nothing. None of them reads as CI.
    expect(at("verify", { kind: "agent" })).toBeNull();
    expect(at("verify", null)).toBeNull();
    expect(stageWait({ stage: "verify", status: "running" })).toBeNull();
  });

  it("says the merge queue's place and the head's step", () => {
    expect(at("merge", { kind: "queue", position: 3 }, "waiting")).toBe(
      "Merge: in the queue (position 3)",
    );
    expect(at("merge", { kind: "updating", position: 1 })).toBe(
      "Merge: updating from the default branch (next to land)",
    );
    expect(at("merge", { kind: "ci", position: 1 })).toBe("Merge: waiting on CI (next to land)");
    expect(at("merge", { kind: "queue", position: 1, merging: true })).toBe("Merge: merging");
    expect(at("merge", { kind: "queue", position: 2, held: true })).toBe(
      "Merge: held, the default branch is red",
    );
  });

  it("says why a queued job can't start, a person asked at the update bound, and a hold", () => {
    expect(at("build", { kind: "runner", reason: "waiting on review" })).toBe(
      "Build: waiting on review",
    );
    expect(at("merge", { kind: "person", on: "question", position: 1 })).toBe(
      "Merge: waiting for an answer",
    );
    const until = "2026-11-13T15:30:00.000Z";
    const time = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(at("merge", { kind: "holding", position: 1, until })).toBe(
      `Merge: holding until ${time}`,
    );
  });

  it("tells a subscriber when a refetch fails, and when one succeeds again", async () => {
    const client = new QueryClient();
    const key = ["workItem.get", "wi_1"];
    client.setQueryData(key, { ok: true });
    const store = readFailedStore(client, key);
    const seen: boolean[] = [];
    const stop = store.subscribe(() => seen.push(store.getSnapshot()));
    expect(store.getSnapshot()).toBe(false);
    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error("offline")),
        retry: false,
        staleTime: 0,
      })
      .catch(() => null);
    expect(store.getSnapshot()).toBe(true);
    expect(seen).toContain(true);
    await client.fetchQuery({ queryKey: key, queryFn: () => ({ ok: true }), staleTime: 0 });
    expect(store.getSnapshot()).toBe(false);
    expect(seen.at(-1)).toBe(false);
    stop();
  });

  it("says nothing for an item not moving on its own", () => {
    expect(at("verify", { kind: "ci" }, "paused")).toBeNull();
    expect(at("verify", { kind: "ci" }, "done")).toBeNull();
  });
});

/** The fixture board with one item in verify waiting on CI and another an agent works on. */
function board(input: unknown) {
  const b = (ANSWERS["workItem.board"] as (i: unknown) => OpOutput<"workItem.board">)(input);
  // #9 and #26 (the personal org's): in delivery, and nobody's gate or question.
  const moving = b.items.filter((i) => i.status === "running" || i.status === "waiting");
  return {
    ...b,
    items: b.items.map((i): BoardItem => {
      if (i.id === "wi_9")
        return { ...i, status: "running", stage: "verify", waitingOn: { kind: "ci" } };
      if (i.id === "wi_26") return { ...i, status: "running", waitingOn: { kind: "agent" } };
      // Every other moving item: running, with nobody working on it.
      if (moving.includes(i)) return { ...i, status: "running", waitingOn: null };
      return i;
    }),
  };
}

describe("the board's cards and counts", () => {
  it("say what the board read says, with no read per card", async () => {
    const asked: string[] = [];
    const html = await renderPage("/work", {
      answers: {
        "workItem.board": board,
        "workItem.get": (input) => {
          asked.push((input as { workItemId: string }).workItemId);
          return ANSWERS["workItem.get"]?.(input as { workItemId: string });
        },
      },
    });
    expect(textOf(html)).toContain("Verify: waiting on CI");
    expect(asked).toEqual([]);
  });

  it("counts as Agent working only the item a runner has claimed a job for", async () => {
    const html = await renderPage("/work?layout=list", { answers: { "workItem.board": board } });
    const text = textOf(html);
    expect(text).toMatch(/Agent working\s*1\b/);
  });

  it("says nothing it can't vouch for once the board read has failed", async () => {
    const html = await renderPage("/work", {
      answers: { "workItem.board": board },
      // The last answer said CI; the refetch since failed, and the cache keeps that answer.
      after: async (client) => {
        for (const q of client.getQueryCache().findAll({ queryKey: ["work", "board"] }))
          await client
            .fetchQuery({
              queryKey: q.queryKey,
              queryFn: () => Promise.reject(new Error("the door is down")),
              retry: false,
              staleTime: 0,
            })
            .catch(() => null);
      },
    });
    expect(textOf(html)).not.toContain("Verify: waiting on CI");
  });
});

async function strip(detail: OpOutput<"workItem.get">, failed = false) {
  const { StageStrip } = await import("../src/mainview/routes/work.$id.index.tsx");
  const { workItemQuery } = await import("../src/mainview/lib/queries.ts");
  const client = new QueryClient();
  const key = workItemQuery(detail.item.id).queryKey;
  client.setQueryData(key, detail);
  if (failed)
    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error("offline")),
        retry: false,
        staleTime: 0,
      })
      .catch(() => null);
  return renderToString(
    <QueryClientProvider client={client}>
      <StageStrip detail={detail} />
    </QueryClientProvider>,
  );
}

describe("the item page's stage strip", () => {
  const base = () =>
    ANSWERS["workItem.get"]?.({ workItemId: "wi_crm_5" }) as OpOutput<"workItem.get">;
  const inVerify = (waitingOn: WaitingOn): OpOutput<"workItem.get"> => {
    const d = base();
    return {
      ...d,
      item: { ...d.item, stage: "verify" as const, status: "running" as const },
      waitingOn,
    };
  };

  it("says what verify waits on", async () => {
    const html = await strip(inVerify({ kind: "ci" }));
    expect(html).toContain('data-testid="stage-wait"');
    expect(textOf(html)).toContain("Verify: waiting on CI");
  });

  it("says nothing extra while an agent works on it, or when the server doesn't say", async () => {
    expect(await strip(inVerify({ kind: "agent" }))).not.toContain('data-testid="stage-wait"');
    expect(await strip(inVerify(null))).not.toContain('data-testid="stage-wait"');
  });

  it("clears the line once its read has failed, rather than keep the last one", async () => {
    const html = await strip(inVerify({ kind: "ci" }), true);
    expect(html).not.toContain('data-testid="stage-wait"');
  });
});
