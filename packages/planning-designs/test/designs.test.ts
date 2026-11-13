// Spec 22 part B: the runner's design checks. Errors refuse the save with the line, the line's text
// and a fix; layout warnings save and name the parts; every preview is a plain, safe SVG with the
// box of each part.
import {
  type DesignPreview,
  designPreviewSchema,
  unsafeSvg,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { checkDesign, checkDesignBounded, sha256 } from "../src/index.ts";

/** The preview of a check that drew one. */
function must(r: Awaited<ReturnType<typeof checkDesign>>): DesignPreview {
  if (!r.ok || !r.preview) throw new Error(r.ok ? "no preview" : r.message);
  return r.preview;
}

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
    const ids = must(r).parts.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["table users", "table posts", "enum status"]));
    expect(must(r).parts.find((p) => p.kind === "relation")?.label).toBe(
      "posts.user_id → users.id",
    );
    expect(must(r).sha256).toBe(sha256(DBML));
    expect(designPreviewSchema.safeParse(must(r)).success).toBe(true);
    // A column changed: the table's signature changes, the other table's doesn't.
    const r2 = await checkDesign("data-model", DBML.replace("title varchar", "title text"));
    if (!r2.ok) throw new Error("expected ok");
    const sigOf = (p: DesignPreview, id: string) => p.parts.find((x) => x.id === id)?.sig;
    expect(sigOf(must(r2), "table posts")).not.toBe(sigOf(must(r), "table posts"));
    expect(sigOf(must(r2), "table users")).toBe(sigOf(must(r), "table users"));
  });

  it("saves a D2 design whose arrows cross, with a layout warning naming them (criterion 1)", async () => {
    // Three sources each connected to three targets can't be drawn without crossings.
    const src = ["a", "b", "c"]
      .flatMap((s) => ["x", "y", "z"].map((t) => `${s} -> ${t}`))
      .join("\n");
    const r = await checkDesign("architecture", src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const crossing = must(r).warnings.find((w) => w.code === "layout/crossing");
    expect(crossing?.parts).toHaveLength(2);
    expect(crossing?.message).toMatch(/`edge \w -> \w` crosses `edge \w -> \w`/);
    expect(must(r).parts.filter((p) => p.kind === "box")).toHaveLength(6);
    expect(must(r).parts.filter((p) => p.kind === "edge")).toHaveLength(9);
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
    expect(must(seq).parts.map((p) => p.id)).toEqual([
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
    expect(must(state).parts.map((p) => p.id)).toEqual(
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
    expect(must(ok).parts.map((p) => p.id)).toEqual(["GET /notes", "POST /notes", "schema Note"]);
  });

  it("escapes design text: a label can't put markup in the preview", async () => {
    const r = await checkDesign(
      "architecture",
      'a: "<script>alert(1)</script>"\nb: "<image href=\'https://x\'/>"\na -> b: "onload=x"\n',
    );
    if (!r.ok) throw new Error(r.message);
    expect(must(r).svg).not.toMatch(/<script|<image/);
    expect(unsafeSvg(must(r).svg)).toBeNull();
  });

  it("keeps only the elements and attributes it draws, whatever the prefix (review of #163)", () => {
    const refused = [
      "<svg><script>x</script></svg>",
      '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
      '<svg><h:script xmlns:h="http://www.w3.org/1999/xhtml">x</h:script></svg>',
      '<svg><h:img src="https://x"/></svg>',
      '<svg><rect onclick="x"/></svg>',
      '<svg><rect fill="url(https://x)"/></svg>',
      "<svg><foreignObject/></svg>",
      "<svg><!-- c --></svg>",
      "<!DOCTYPE svg><svg/>",
      '<svg><rect xlink:href="#a"/></svg>',
      '<svg xmlns="http://www.w3.org/1999/xhtml"/>',
      "<svg><text>a & b</text></svg>",
      "<svg><rect></svg>",
    ];
    for (const svg of refused) expect(unsafeSvg(svg), svg).not.toBeNull();
    expect(
      unsafeSvg(
        '<svg width="1"><rect fill="url(#a)" x="0"/><text>&lt;b&gt; &#39;x&#39;</text></svg>',
      ),
    ).toBeNull();
  });

  it("draws labels that merely mention onload=, url( or javascript: (review of #163)", async () => {
    for (const [type, src] of [
      [
        "sequence",
        "sequenceDiagram\n  A->>B: set online = true\n  B->>A: url(docs) @import javascript:x\n",
      ],
      ["architecture", 'a -> b: "onload=x url(https://y)"\n'],
    ] as const) {
      const r = await checkDesign(type, src);
      expect(r.ok && r.preview !== null, src).toBe(true);
    }
  });

  it("cuts long part ids, saves a too-big drawing without it, and refuses a too-big design", async () => {
    const long = "t".repeat(400);
    const cutIds = must(await checkDesign("data-model", `Table ${long} {\n  id int\n}\n`));
    expect(cutIds.parts[0]?.id.length).toBe(300);
    const tables = Array.from(
      { length: 600 },
      (_, i) => `Table t${i} {\n  id int [pk]\n  name text\n  created_at timestamp\n}`,
    ).join("\n");
    const big = await checkDesign("data-model", tables);
    expect(big.ok).toBe(true);
    if (big.ok) {
      expect(big.preview).toBeNull();
      expect(big.warnings.at(-1)?.code).toBe("preview/not-kept");
    }
    const huge = await checkDesign("data-model", `// ${"x".repeat(310_000)}\n`);
    expect(huge.ok).toBe(false);
  });

  it("stops a check that takes too long, and checks in a worker otherwise", async () => {
    const quick = await checkDesignBounded("data-model", DBML);
    expect(quick.ok).toBe(true);
    const slow = await checkDesignBounded("architecture", "a -> b\n", "slow.d2", 1);
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.errors[0]?.code).toBe("design/timeout");
  });

  it("says which Mermaid lines the drawing leaves out (review of #163)", async () => {
    const r = await checkDesign(
      "sequence",
      "sequenceDiagram\n  A->>B: hi\n  Note right of B: thinks\n  alt ok\n    B-->>A: yes\n  end\n",
    );
    if (!r.ok) throw new Error(r.message);
    const left = r.warnings.find((w) => w.code === "preview/not-drawn");
    expect(left?.message).toMatch(/lines 3, 4, 6/);
  });
});
