// The inbox's rows, the workflow editor's edits and what it sends, a server problem placed beside
// its status, and an item's plugin fields as chips (flow-edit.ts).
import { describe, expect, it } from "vitest";
import type { FlowItem, FlowStatus } from "../src/flow.ts";
import {
  asProblems,
  fieldChips,
  inboxQuestion,
  inboxRows,
  moveStatus,
  newStatus,
  nextRow,
  problemsByStatus,
  removeStatus,
  sendsBackTo,
  statusesToSave,
  statusIdFor,
} from "../src/flow-edit.ts";

const item = (id: string, updatedAt: string, over: Partial<FlowItem> = {}): FlowItem => ({
  id,
  orgId: "org_1",
  projectId: "prj_1",
  number: 1,
  title: `Item ${id}`,
  body: "",
  statusId: "review",
  waiting: { on: "nothing" },
  error: null,
  stay: 1,
  createdBy: "usr_me",
  createdAt: updatedAt,
  updatedAt,
  ...over,
});

const S = (id: string, over: Partial<FlowStatus> = {}): FlowStatus => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  owner: { kind: "none" },
  ...over,
});

describe("the inbox", () => {
  const a = item("a", "2026-11-15T10:00:00Z");
  const b = item("b", "2026-11-15T11:00:00Z");
  const c = item("c", "2026-11-15T09:00:00Z");

  it("puts decisions and work together, newest first, each once", () => {
    const rows = inboxRows({ work: [a, c], decisions: [b, a], truncated: false });
    expect(rows.map((r) => [r.item.id, r.kind])).toEqual([
      ["b", "decision"],
      ["a", "decision"],
      ["c", "work"],
    ]);
  });

  it("asks the question in plain words", () => {
    expect(inboxQuestion({ item: a, kind: "work" }, "Review")).toBe("Review: Item a");
    expect(inboxQuestion({ item: a, kind: "decision" }, "Review")).toBe("Decide: Item a");
  });

  it("moves to the next row after acting, else the one before, else none", () => {
    const rows = inboxRows({ work: [a, b, c], decisions: [], truncated: false });
    expect(nextRow(rows, "b")).toBe("a");
    expect(nextRow(rows, "c")).toBe("a");
    expect(nextRow(rows.slice(0, 1), "b")).toBeNull();
  });
});

describe("the workflow editor", () => {
  it("makes a status's id from its name, unlike the others", () => {
    expect(statusIdFor("Ready for review!", new Set())).toBe("ready-for-review");
    expect(statusIdFor("Review", new Set(["review", "review-2"]))).toBe("review-3");
    expect(statusIdFor("  ", new Set())).toBe("status");
  });

  it("sends new statuses with ids from their names, and every route to them follows", () => {
    const added = { ...newStatus("Deploy"), owner: { kind: "person", userId: "u" } } as FlowStatus;
    const draft = [
      S("build", { onDone: added.id, brief: "Build it", owner: { kind: "agent", agentId: "a" } }),
      added,
      S("done", { onReject: added.id, brief: "left over" }),
    ];
    const { statuses, ids } = statusesToSave(draft);
    expect(statuses.map((s) => s.id)).toEqual(["build", "deploy", "done"]);
    expect(statuses[0]?.onDone).toBe("deploy");
    expect(statuses[2]?.onReject).toBe("deploy");
    expect(ids.get(added.id)).toBe("deploy");
    // A brief goes only with an agent owner.
    expect(statuses[0]?.brief).toBe("Build it");
    expect(statuses[2]).not.toHaveProperty("brief");
  });

  it("moves a status left and right, and not past either end", () => {
    const list = [S("a"), S("b"), S("c")];
    expect(moveStatus(list, 1, -1).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(moveStatus(list, 1, 1).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(moveStatus(list, 0, -1)).toBe(list);
  });

  it("removes a status and sends what pointed at it back to the defaults", () => {
    const list = [S("a", { onDone: "c" }), S("b", { onReject: "c" }), S("c")];
    const next = removeStatus(list, 2);
    expect(next.map((s) => s.id)).toEqual(["a", "b"]);
    expect(next[0]).not.toHaveProperty("onDone");
    expect(next[1]).not.toHaveProperty("onReject");
    expect(removeStatus([S("a")], 0)).toHaveLength(1);
  });

  it("says where a status sends back only when it isn't the status before", () => {
    const list = [S("a"), S("b", { onReject: "a" }), S("c", { onReject: "a" })];
    expect(sendsBackTo(list, 1)).toBeNull();
    expect(sendsBackTo(list, 2)?.name).toBe("A");
  });

  it("places the server's problems beside the draft status they name", () => {
    const added = newStatus("Deploy");
    const draft = [S("build"), added];
    const { statuses: sent } = statusesToSave(draft);
    const problems = asProblems([
      { statusId: "deploy", message: "Deploy points at itself." },
      { statusId: null, message: "statuses.0.name: Too small" },
      { statusId: null, message: "name: Too big" },
      "not a problem",
    ]);
    const by = problemsByStatus(problems, sent, draft);
    expect(by.get(added.id)).toEqual(["Deploy points at itself."]);
    expect(by.get("build")).toEqual(["Name: Too small"]);
    expect(by.get("")).toEqual(["name: Too big"]);
  });
});

describe("plugin fields", () => {
  it("shows each field with a value, labelled and in the definitions' order", () => {
    const chips = fieldChips(
      { fields: { priority: "High", customer: "Acme", empty: "", due_date: "Friday", ok: true } },
      [
        { id: "customer", label: "Customer", type: "text" },
        { id: "priority", label: "Priority", type: "text" },
      ],
    );
    expect(chips.map((c) => `${c.label}: ${c.value}`)).toEqual([
      "Customer: Acme",
      "Priority: High",
      "Due date: Friday",
      "Ok: Yes",
    ]);
    expect(fieldChips({}, undefined)).toEqual([]);
  });
});
