// Spec 22 part B: the planning MCP server checks a design on the runner before it is saved. One
// that won't draw is refused with its lines and never relayed; one that draws goes with its
// preview, and its layout warnings come back; a pulled design's base gets its preview.
import { describe, expect, it } from "vitest";
import { handleMcp, planningTools } from "../src/index.ts";

const relay = { url: "http://127.0.0.1:1/planning", token: "t" };

/** A fake relay: records each call, answers by op. */
function fakeRelay(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const sent: { op: string; input: Record<string, unknown> }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { op: string; input: Record<string, unknown> };
    sent.push(body);
    const answer = answers[body.op];
    try {
      return new Response(JSON.stringify({ ok: true, result: answer ? answer(body.input) : {} }));
    } catch (error) {
      return new Response(
        JSON.stringify({ ok: false, code: "conflict", error: (error as Error).message }),
        { status: 409 },
      );
    }
  }) as typeof globalThis.fetch;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      relay,
      { fetch },
    )) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: r.result.isError === true, text: r.result.content[0]?.text ?? "" };
  };
  return { sent, call };
}

describe("design checks in the planning MCP server (spec 22 part B)", () => {
  it("refuses a DBML design that won't parse, with its line, and relays nothing", async () => {
    const { sent, call } = fakeRelay({});
    const r = await call("artifact_add", {
      kind: "design",
      designType: "data-model",
      title: "Schema",
      content: "Table users {\n  id int [pk\n}\n",
    });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/^"Schema" won't draw, so it wasn't saved \(line \d+/);
    expect(r.text).toContain('"diagnostics"');
    expect(sent).toEqual([]);
  });

  it("saves a design that draws with its preview, and hands back its layout warnings", async () => {
    const { sent, call } = fakeRelay({
      "artifact.add": () => ({ artifactId: "pa_1", revision: 1, controls: [] }),
    });
    const content = ["a", "b", "c"]
      .flatMap((s) => ["x", "y", "z"].map((t) => `${s} -> ${t}`))
      .join("\n");
    const r = await call("artifact_add", {
      kind: "design",
      designType: "architecture",
      title: "Flows",
      content,
    });
    expect(r.error).toBe(false);
    const preview = sent[0]?.input.preview as { svg: string; parts: unknown[] };
    expect(preview.svg.startsWith("<svg")).toBe(true);
    expect(preview.parts.length).toBe(15);
    expect(JSON.parse(r.text).layoutWarnings[0].code).toBe("layout/crossing");
  });

  it("checks a new revision of a design it learns the type of, and leaves a mockup alone", async () => {
    const { sent, call } = fakeRelay({
      "artifact.read": (input) =>
        input.artifactId === "pa_d"
          ? { designType: "sequence", kind: "design", content: "" }
          : { designType: null, kind: "mockup", content: "" },
      "artifact.update": () => ({ artifactId: "x", revision: 2, controls: [], warnings: [] }),
    });
    const bad = await call("artifact_update", {
      artifactId: "pa_d",
      content: "sequenceDiagram\n  A->>B hi\n",
    });
    expect(bad.error).toBe(true);
    expect(sent.map((s) => s.op)).toEqual(["artifact.read"]);
    await call("artifact_update", { artifactId: "pa_m", content: "<p>hi</p>" });
    expect(sent.at(-1)?.op).toBe("artifact.update");
    expect(sent.at(-1)?.input.preview).toBeUndefined();
  });

  it("previews a pulled design's base and first revision", async () => {
    const { sent, call } = fakeRelay({
      "design.pull": () => ({ artifactId: "pa_p", revision: 1, changed: false }),
      "artifact.read": () => ({
        designType: "data-model",
        kind: "design",
        content: "Table users {\n  id int [pk]\n}\n",
      }),
    });
    const r = await call("design_pull", { path: ".kim/designs/schema.dbml" });
    expect(r.error).toBe(false);
    expect(sent.map((s) => [s.op, s.input.revision])).toEqual([
      ["design.pull", undefined],
      ["artifact.read", 0],
      ["design.preview", 0],
      ["design.preview", 1],
    ]);
  });

  it("reports a pull whose drawing wasn't stored as pulled, and never caches a failed read (review of #163)", async () => {
    const { call } = fakeRelay({
      "design.pull": () => ({ artifactId: "pa_q", revision: 1, changed: false }),
      "artifact.read": () => ({
        designType: "data-model",
        kind: "design",
        content: "Table users {\n  id int [pk]\n}\n",
      }),
      "design.preview": () => {
        throw new Error("the plan is waiting at the gate");
      },
    });
    const r = await call("design_pull", { path: ".kim/designs/users.dbml" });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text).design.previewNotStored).toMatch(/wasn't stored: .*gate/);

    let reads = 0;
    const flaky = fakeRelay({
      "artifact.read": () => {
        reads++;
        if (reads === 1) throw new Error("try again");
        return { designType: "data-model", kind: "design", content: "" };
      },
      "artifact.update": () => ({ artifactId: "pa_f", revision: 2, controls: [], warnings: [] }),
    });
    const first = await flaky.call("artifact_update", { artifactId: "pa_f", content: "Table a {" });
    expect(first.error).toBe(true);
    // The type wasn't remembered as "not a design": the next save is read again and checked.
    const second = await flaky.call("artifact_update", {
      artifactId: "pa_f",
      content: "Table a {",
    });
    expect(second.error).toBe(true);
    expect(second.text).toMatch(/won't draw/);
    expect(flaky.sent.some((x) => x.op === "artifact.update")).toBe(false);
  });

  it("never offers the model the preview: no design_preview tool, no preview field", () => {
    const tools = planningTools();
    expect(tools.map((t) => t.name)).not.toContain("design_preview");
    const add = tools.find((t) => t.name === "artifact_add");
    expect(JSON.stringify(add?.inputSchema)).not.toContain('"preview"');
  });
});
