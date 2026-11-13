// Data models in DBML (spec 22): parsed with @dbml/parse (the compiler behind @dbml/core's dbmlv2,
// as kim does), drawn as an entity diagram of table cards, one part per table, enum and relation.

import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout } from "@dbml/parse";
import type { DesignFinding, DesignPart } from "@software-factory/runner-contract";
import { DesignParseError } from "./errors.ts";
import { placeGraph } from "./graph.ts";
import { midBox, readability, sig } from "./layout.ts";
import { INK, path, rect, svgDocument, text, textWidth } from "./svg.ts";
import type { Drawn } from "./types.ts";

interface Field {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  notNull: boolean;
}
interface Table {
  name: string;
  kind: "table" | "enum";
  fields: Field[];
}
interface Relation {
  from: { table: string; fields: string[]; many: boolean };
  to: { table: string; fields: string[]; many: boolean };
}

type Raw = {
  tables?: {
    name: string;
    schemaName?: string | null;
    fields: {
      name: string;
      type?: { type_name?: string };
      pk?: boolean;
      unique?: boolean;
      not_null?: boolean;
    }[];
    indexes?: { pk?: boolean; columns?: { value: string; type?: string }[] }[];
  }[];
  enums?: { name: string; schemaName?: string | null; values: { name: string }[] }[];
  refs?: {
    endpoints: {
      tableName: string;
      schemaName?: string | null;
      fieldNames: string[];
      relation: string;
    }[];
  }[];
};

const qualify = (schema: string | null | undefined, name: string) =>
  schema && schema !== "public" ? `${schema}.${name}` : name;

/** Parses DBML; throws a DesignParseError with every problem at its line. */
export function parseDataModel(source: string): { tables: Table[]; relations: Relation[] } {
  const project = new MemoryProjectLayout();
  project.setSource(DEFAULT_ENTRY, source);
  const compiler = new Compiler(project);
  const errors = compiler.parse.errors(DEFAULT_ENTRY);
  if (errors.length) {
    const problems = errors.map((e) => ({
      message: e.diagnostic,
      line: e.nodeOrToken.startPos.line + 1,
      column: e.nodeOrToken.startPos.column + 1,
    }));
    throw new DesignParseError(problems.map((p) => p.message).join("\n"), problems);
  }
  const db = compiler.parse.rawDb(DEFAULT_ENTRY) as unknown as Raw;
  const fks = new Set<string>();
  const relations: Relation[] = [];
  for (const ref of db.refs ?? []) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    const end = (e: typeof a) => ({
      table: qualify(e.schemaName, e.tableName),
      fields: [...e.fieldNames],
      many: e.relation === "*",
    });
    let from = end(a);
    let to = end(b);
    // The many side holds the foreign key; with one-to-one, the declaring side.
    const holder = from.many ? from : to.many ? to : from;
    for (const f of holder.fields) fks.add(`${holder.table}.${f}`);
    const key = (e: typeof from) => `${e.table}(${e.fields.join(",")})`;
    if (key(from) > key(to)) [from, to] = [to, from];
    relations.push({ from, to });
  }
  const tables: Table[] = [];
  for (const t of db.tables ?? []) {
    const name = qualify(t.schemaName, t.name);
    const compositePk = new Set(
      (t.indexes ?? [])
        .filter((i) => i.pk)
        .flatMap((i) =>
          (i.columns ?? []).filter((c) => c.type !== "expression").map((c) => c.value),
        ),
    );
    tables.push({
      name,
      kind: "table",
      fields: t.fields.map((f) => ({
        name: f.name,
        type: f.type?.type_name ?? "",
        pk: Boolean(f.pk) || compositePk.has(f.name),
        fk: fks.has(`${name}.${f.name}`),
        unique: Boolean(f.unique),
        notNull: Boolean(f.not_null),
      })),
    });
  }
  for (const e of db.enums ?? []) {
    tables.push({
      name: qualify(e.schemaName, e.name),
      kind: "enum",
      fields: e.values.map((v) => ({
        name: v.name,
        type: "",
        pk: false,
        fk: false,
        unique: false,
        notNull: false,
      })),
    });
  }
  return { tables, relations };
}

const HEAD = 30;
const ROW = 22;
const FIELD_PX = 12;

const relationId = (r: Relation) =>
  `ref ${r.from.table}(${r.from.fields.join(",")}) - ${r.to.table}(${r.to.fields.join(",")})`;

/** Draws the data model: a card per table and enum, a line per relation. */
export function drawDataModel(source: string): Drawn {
  const model = parseDataModel(source);
  const widthOf = (t: Table) =>
    Math.max(
      140,
      textWidth(t.name, 13) + 40,
      ...t.fields.map(
        (f) => textWidth(f.name, FIELD_PX, true) + textWidth(f.type, FIELD_PX, true) + 72,
      ),
    );
  const placed = placeGraph(
    model.tables.map((t) => ({
      id: t.name,
      w: widthOf(t),
      h: HEAD + Math.max(1, t.fields.length) * ROW + 6,
    })),
    model.relations.map((r) => ({ id: relationId(r), from: r.from.table, to: r.to.table })),
    { direction: "LR", nodesep: 36, ranksep: 90 },
  );
  const parts: DesignPart[] = [];
  let body = "";
  for (const r of model.relations) {
    const id = relationId(r);
    const e = placed.edges.get(id);
    if (!e) continue;
    body += path(e.points);
    const card = (many: boolean) => (many ? "n" : "1");
    const first = e.points[0];
    const last = e.points[e.points.length - 1];
    if (first)
      body += text(first.x + 6, first.y - 6, card(r.from.many), { size: 11, fill: INK.muted });
    if (last) body += text(last.x - 20, last.y - 8, card(r.to.many), { size: 11, fill: INK.muted });
    parts.push({
      id,
      kind: "relation",
      label: `${r.from.table}.${r.from.fields.join(",")} → ${r.to.table}.${r.to.fields.join(",")}`,
      sig: sig([r.from.many, r.to.many]),
      box: midBox(e.points),
    });
  }
  for (const t of model.tables) {
    const at = placed.nodes.get(t.name);
    if (!at) continue;
    body += rect(at.x, at.y, at.w, at.h, { fill: INK.card });
    body += `<path d="M${at.x} ${at.y + HEAD} H${at.x + at.w}" stroke="${INK.line}"/>`;
    body += text(at.x + 12, at.y + 20, t.name, { size: 13, weight: 600 });
    if (t.kind === "enum")
      body += text(at.x + at.w - 12, at.y + 20, "enum", {
        size: 11,
        fill: INK.muted,
        anchor: "end",
      });
    t.fields.forEach((f, i) => {
      const y = at.y + HEAD + i * ROW + 16;
      const mark = f.pk ? "PK" : f.fk ? "FK" : "";
      if (mark) body += text(at.x + 10, y, mark, { size: 9, weight: 700, fill: INK.accent });
      body += text(at.x + 32, y, f.name, { size: FIELD_PX, mono: true });
      if (f.type)
        body += text(at.x + at.w - 10, y, f.type, {
          size: FIELD_PX,
          mono: true,
          fill: INK.muted,
          anchor: "end",
        });
    });
    parts.push({
      id: `${t.kind} ${t.name}`,
      kind: t.kind,
      label: t.name,
      sig: sig(t.fields),
      box: { x: at.x, y: at.y, w: at.w, h: at.h },
    });
  }
  const warnings: DesignFinding[] = [];
  const small = readability({ w: placed.width, h: placed.height }, FIELD_PX, [
    "Split the schema into one design per area (such as billing.dbml and accounts.dbml); a table another area refers to can appear in both",
    `It holds ${model.tables.length} tables: keep only the ones this plan touches, and mention the rest in a Note`,
  ]);
  if (small) warnings.push(small);
  return {
    svg: svgDocument(placed.width, placed.height, body),
    width: placed.width,
    height: placed.height,
    parts,
    warnings,
  };
}
