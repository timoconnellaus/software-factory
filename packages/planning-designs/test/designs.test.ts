// Spec 22 part B: the runner's design checks. Errors refuse the save with the line, the line's text
// and a fix; layout warnings save and name the parts; every preview is a plain, safe SVG with the
// box of each part.
import { designPreviewSchema, unsafeSvg } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { checkDesign, sha256 } from "../src/index.ts";

const DBML = `Table users {
  id int [pk]
  email varchar [unique, not null]
}

Table posts {
  id int [pk]
  user_id int [ref: > users.id]
  title varchar
}

Enum status {
  draft
  published
}
`;

describe("the design checks (spec 22 part B)", () => {
  it("refuses a DBML design with a syntax error, naming the line and a fix (criterion 1)", async () => {
    const r = await checkDesign(
      "data-model",
      "Table users {\n  id int [pk\n  name varchar\n}\n",
      "users.dbml",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(
      /^users\.dbml won't draw, so it wasn't saved \(line \d+, column \d+\)/,
    );
    const first = r.errors[0];
    expect(first?.code).toBe("design/syntax");
    expect(first?.line).toBeGreaterThanOrEqual(2);
    expect(first?.text).toBeDefined();
    expect(first?.fixes[0]).toMatch(/Fix the source at this line/);
  });

  it("draws a data model with a part per table, enum and relation", async () => {
    const r = await checkDesign("data-model", DBML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.preview.parts.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["table users", "table posts", "enum status"]));
    expect(r.preview.parts.find((p) => p.kind === "relation")?.label).toBe(
      "posts.user_id → users.id",
    );
    expect(r.preview.sha256).toBe(sha256(DBML));
    expect(designPreviewSchema.safeParse(r.preview).success).toBe(true);
    // A column changed: the table's signature changes, the other table's doesn't.
    const r2 = await checkDesign("data-model", DBML.replace("title varchar", "title text"));
    if (!r2.ok) throw new Error("expected ok");
    const sigOf = (p: typeof r.preview, id: string) => p.parts.find((x) => x.id === id)?.sig;
    expect(sigOf(r2.preview, "table posts")).not.toBe(sigOf(r.preview, "table posts"));
    expect(sigOf(r2.preview, "table users")).toBe(sigOf(r.preview, "table users"));
  });

  it("saves a D2 design whose arrows cross, with a layout warning naming them (criterion 1)", async () => {
    // Three sources each connected to three targets can't be drawn without crossings.
    const src = ["a", "b", "c"]
      .flatMap((s) => ["x", "y", "z"].map((t) => `${s} -> ${t}`))
      .join("\n");
    const r = await checkDesign("architecture", src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const crossing = r.preview.warnings.find((w) => w.code === "layout/crossing");
    expect(crossing?.parts).toHaveLength(2);
    expect(crossing?.message).toMatch(/`edge \w -> \w` crosses `edge \w -> \w`/);
    expect(r.preview.parts.filter((p) => p.kind === "box")).toHaveLength(6);
    expect(r.preview.parts.filter((p) => p.kind === "edge")).toHaveLength(9);
  });

  it("refuses a D2 design that doesn't compile, at its line", async () => {
    const r = await checkDesign("architecture", "api -> db\nweb -> {\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.line).toBe(2);
    expect(r.errors[0]?.text).toBe("web -> {");
  });

  it("checks Mermaid with Mermaid's parser and draws sequences and states", async () => {
    const bad = await checkDesign("sequence", "sequenceDiagram\n  A->>B hi\n");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.line).toBe(2);
    const wrong = await checkDesign("state", "sequenceDiagram\n  A->>B: hi\n");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.errors[0]?.code).toBe("design/wrong-diagram");
    const seq = await checkDesign(
      "sequence",
      "sequenceDiagram\n  participant A as App\n  A->>B: login\n  B-->>A: token\n  A->>B: login\n",
    );
    if (!seq.ok) throw new Error(seq.message);
    expect(seq.preview.parts.map((p) => p.id)).toEqual([
      "participant A",
      "participant B",
      "message A -> B",
      "message B -> A",
      "message A -> B #2",
    ]);
    const state = await checkDesign(
      "state",
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> [*]\n",
    );
    if (!state.ok) throw new Error(state.message);
    expect(state.preview.parts.map((p) => p.id)).toEqual(
      expect.arrayContaining(["state Idle", "state Running", "transition Idle -> Running"]),
    );
  });

  it("checks OpenAPI's shape at its lines and draws endpoints and schemas", async () => {
    const bad = await checkDesign(
      "api",
      "openapi: 2.0\ninfo:\n  title: X\npaths:\n  users:\n    get: {}\n",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.line)).toEqual([1, 5]);
    }
    const yamlError = await checkDesign("api", "openapi: 3.1.0\ninfo: [\n");
    expect(yamlError.ok).toBe(false);
    const ok = await checkDesign(
      "api",
      "openapi: 3.1.0\ninfo:\n  title: Notes\npaths:\n  /notes:\n    get:\n      summary: List notes\n    post:\n      summary: Add a note\ncomponents:\n  schemas:\n    Note:\n      properties:\n        id: { type: string }\n",
    );
    if (!ok.ok) throw new Error(ok.message);
    expect(ok.preview.parts.map((p) => p.id)).toEqual(["GET /notes", "POST /notes", "schema Note"]);
  });

  it("escapes design text: a label can't put markup in the preview", async () => {
    const r = await checkDesign(
      "architecture",
      'a: "<script>alert(1)</script>"\nb: "<image href=\'https://x\'/>"\na -> b: "onload=x"\n',
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.preview.svg).not.toMatch(/<script|<image/);
    expect(unsafeSvg(r.preview.svg)).toBeNull();
    expect(unsafeSvg("<svg><script>x</script></svg>")).toMatch(/script/);
    expect(unsafeSvg('<svg><rect onclick="x"/></svg>')).toMatch(/event/);
    expect(unsafeSvg('<svg><rect fill="url(https://x)"/></svg>')).toMatch(/outside/);
  });
});
