// API designs in OpenAPI 3 YAML (spec 22): read with `yaml` (its errors carry the line), checked for
// the shape OpenAPI 3 needs, and drawn as a list of endpoints and a card per schema.
import type { DesignFinding, DesignPart } from "@software-factory/runner-contract";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { DesignParseError, type Problem } from "./errors.ts";
import { readability, sig } from "./layout.ts";
import { INK, rect, svgDocument, text, textWidth } from "./svg.ts";
import type { Drawn } from "./types.ts";

const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"] as const;
const METHOD_INK: Record<string, string> = {
  get: "#1a8f52",
  post: "#1f6bff",
  put: "#8a5a00",
  patch: "#8a5a00",
  delete: "#b42318",
};

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface Api {
  title: string;
  endpoints: { method: string; path: string; summary: string; detail: unknown }[];
  schemas: { name: string; fields: { name: string; type: string }[]; detail: unknown }[];
}

/** Reads and checks an OpenAPI 3 document; throws a DesignParseError at its lines. */
export function parseApi(source: string): Api {
  const counter = new LineCounter();
  const doc = parseDocument(source, { lineCounter: counter, prettyErrors: false });
  if (doc.errors.length) {
    throw new DesignParseError(
      doc.errors.map((e) => e.message).join("\n"),
      doc.errors.slice(0, 8).map((e) => {
        const at = counter.linePos(e.pos[0]);
        return { message: e.message.split("\n")[0] ?? e.message, line: at.line, column: at.col };
      }),
    );
  }
  // The line of a key (where a person reads the problem), else of its value.
  const lineOf = (keys: string[]): number | null => {
    const parent = keys.length > 1 ? doc.getIn(keys.slice(0, -1), true) : doc.contents;
    if (isMap(parent)) {
      const pair = parent.items.find(
        (i) => isScalar(i.key) && String(i.key.value) === keys[keys.length - 1],
      );
      const range = isScalar(pair?.key) ? pair.key.range : undefined;
      if (range) return counter.linePos(range[0]).line;
    }
    return null;
  };
  const problems: Problem[] = [];
  const root = doc.toJS() as unknown;
  if (!isObject(root)) {
    throw new DesignParseError("not a mapping", [
      {
        message: "An OpenAPI document is a mapping with `openapi`, `info` and `paths`",
        line: 1,
        column: null,
      },
    ]);
  }
  if (typeof root.openapi !== "string" || !/^3\./.test(root.openapi)) {
    problems.push({
      message: "`openapi` must name version 3 (such as `openapi: 3.1.0`)",
      line: lineOf(["openapi"]) ?? 1,
      column: null,
    });
  }
  if (!isObject(root.info) || typeof root.info.title !== "string") {
    problems.push({ message: "`info` needs a `title`", line: lineOf(["info"]) ?? 1, column: null });
  }
  if (!isObject(root.paths)) {
    problems.push({
      message: "`paths` must be a mapping of paths to operations",
      line: lineOf(["paths"]) ?? 1,
      column: null,
    });
  }
  const endpoints: Api["endpoints"] = [];
  if (isObject(root.paths)) {
    for (const [p, item] of Object.entries(root.paths)) {
      if (!p.startsWith("/")) {
        problems.push({
          message: `The path \`${p}\` must start with /`,
          line: lineOf(["paths", p]),
          column: null,
        });
      }
      if (!isObject(item)) {
        problems.push({
          message: `\`${p}\` must be a mapping of methods to operations`,
          line: lineOf(["paths", p]),
          column: null,
        });
        continue;
      }
      for (const m of METHODS) {
        const op = item[m];
        if (op === undefined) continue;
        if (!isObject(op)) {
          problems.push({
            message: `\`${m}\` under \`${p}\` must be an operation (a mapping)`,
            line: lineOf(["paths", p, m]),
            column: null,
          });
          continue;
        }
        if (op.responses !== undefined && !isObject(op.responses)) {
          problems.push({
            message: `\`${m} ${p}\`'s responses must be a mapping of status codes`,
            line: lineOf(["paths", p, m, "responses"]),
            column: null,
          });
        }
        endpoints.push({
          method: m,
          path: p,
          summary: typeof op.summary === "string" ? op.summary : "",
          detail: op,
        });
      }
    }
  }
  if (problems.length)
    throw new DesignParseError(problems.map((x) => x.message).join("\n"), problems);
  const schemas: Api["schemas"] = [];
  const all =
    isObject(root.components) && isObject(root.components.schemas) ? root.components.schemas : {};
  for (const [name, s] of Object.entries(all)) {
    const props = isObject(s) && isObject(s.properties) ? s.properties : {};
    schemas.push({
      name,
      fields: Object.entries(props).map(([f, v]) => ({
        name: f,
        type: isObject(v)
          ? typeof v.$ref === "string"
            ? (v.$ref.split("/").pop() ?? "")
            : String(v.type ?? "")
          : "",
      })),
      detail: s,
    });
  }
  return { title: isObject(root.info) ? String(root.info.title) : "", endpoints, schemas };
}

/** Draws the API: the endpoints as rows, then a card per schema. */
export function drawApi(source: string): Drawn {
  const api = parseApi(source);
  const pad = 24;
  const rowH = 30;
  const parts: DesignPart[] = [];
  let body = text(pad, pad + 16, api.title, { size: 16, weight: 600 });
  let y = pad + 32;
  const rowW = Math.max(
    420,
    ...api.endpoints.map((e) => 90 + textWidth(e.path, 13, true) + textWidth(e.summary, 13) + 40),
  );
  for (const e of api.endpoints) {
    body += rect(pad, y, rowW, rowH - 4, { radius: 5 });
    body += text(pad + 10, y + 18, e.method.toUpperCase(), {
      size: 11,
      weight: 700,
      fill: METHOD_INK[e.method] ?? INK.muted,
    });
    body += text(pad + 76, y + 18, e.path, { size: 13, mono: true });
    if (e.summary) {
      body += text(pad + 76 + textWidth(e.path, 13, true) + 16, y + 18, e.summary, {
        size: 13,
        fill: INK.muted,
      });
    }
    parts.push({
      id: `${e.method.toUpperCase()} ${e.path}`,
      kind: "endpoint",
      label: `${e.method.toUpperCase()} ${e.path}`,
      sig: sig(e.detail),
      box: { x: pad, y, w: rowW, h: rowH - 4 },
    });
    y += rowH;
  }
  y += 16;
  let x = pad;
  let rowBottom = y;
  const maxW = Math.max(rowW + pad, 720);
  for (const s of api.schemas) {
    const w = Math.max(
      160,
      textWidth(s.name, 13) + 32,
      ...s.fields.map((f) => textWidth(`${f.name}  ${f.type}`, 12, true) + 28),
    );
    const h = 30 + Math.max(1, s.fields.length) * 20 + 6;
    if (x + w > maxW && x > pad) {
      x = pad;
      y = rowBottom + 16;
    }
    body += rect(x, y, w, h);
    body += text(x + 12, y + 20, s.name, { size: 13, weight: 600 });
    s.fields.forEach((f, i) => {
      body += text(x + 12, y + 46 + i * 20, f.name, { size: 12, mono: true });
      body += text(x + w - 12, y + 46 + i * 20, f.type, {
        size: 12,
        mono: true,
        fill: INK.muted,
        anchor: "end",
      });
    });
    parts.push({
      id: `schema ${s.name}`,
      kind: "schema",
      label: s.name,
      sig: sig(s.detail),
      box: { x, y, w, h },
    });
    x += w + 16;
    rowBottom = Math.max(rowBottom, y + h);
  }
  const width = Math.max(rowW + 2 * pad, x + pad, 480);
  const height = Math.max(rowBottom, y) + pad;
  const warnings: DesignFinding[] = [];
  const small = readability({ w: width, h: height }, 12, [
    "Split the API into one design per resource or area",
    "Keep only the endpoints this plan adds or changes",
  ]);
  if (small) warnings.push(small);
  return { svg: svgDocument(width, height, body), width, height, parts, warnings };
}
