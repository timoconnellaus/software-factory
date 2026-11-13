// The planning design checks (spec 22 part B, ADR 0305): run on the runner by the harness's planning
// MCP server before a design is saved, as kim's run in its CLI. A design that doesn't parse, or isn't
// the type it says, is refused with each problem's line, the line itself and a fix; layout warnings
// save with it. Each design is drawn to a static SVG with the box of every part (the preview the app
// shows as an image, and the `.svg` written beside it in `.kim/designs/`).
import { createHash } from "node:crypto";
import type { DesignFinding, DesignPreview, DesignType } from "@software-factory/runner-contract";
import { drawD2 } from "./d2.ts";
import { drawDataModel } from "./dbml.ts";
import { DesignParseError, describeErrors } from "./errors.ts";
import { checkMermaid, drawSequence, drawState } from "./mermaid.ts";
import { drawApi } from "./openapi.ts";
import type { Drawn } from "./types.ts";

export type { Drawn } from "./types.ts";

/** At most this many errors are reported at once; fixing them often fixes the rest. */
const MAX_ERRORS = 8;
const PARSE_FIX = "Fix the source at this line; the message says what the parser expected";

export type DesignCheck =
  | { ok: true; preview: DesignPreview }
  | { ok: false; errors: DesignFinding[]; message: string };

async function draw(type: DesignType, source: string): Promise<Drawn> {
  switch (type) {
    case "data-model":
      return drawDataModel(source);
    case "architecture":
    case "data-flow":
      return drawD2(source);
    case "sequence":
      await checkMermaid(type, source);
      return drawSequence(source);
    case "state":
      await checkMermaid(type, source);
      return drawState(source);
    case "api":
      return drawApi(source);
  }
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Checks a design and draws it. Not ok: the errors (each with its line, the line's text and a fix)
 * and one sentence for the planner. Ok: the preview, with the layout warnings it saves with.
 */
export async function checkDesign(
  type: DesignType,
  source: string,
  name = `this ${type} design`,
): Promise<DesignCheck> {
  const lines = source.split("\n");
  try {
    const drawn = await draw(type, source);
    return {
      ok: true,
      preview: {
        svg: drawn.svg,
        width: drawn.width,
        height: drawn.height,
        parts: drawn.parts.slice(0, 1_000),
        warnings: drawn.warnings.slice(0, 20),
        sha256: sha256(source),
      },
    };
  } catch (error) {
    const wrong = error instanceof DesignParseError && error.message === "wrong diagram";
    const errors: DesignFinding[] = describeErrors(error).map((p) => {
      const line = p.line !== null && p.line >= 1 ? p.line : null;
      const at = line !== null ? lines[line - 1] : undefined;
      return {
        code: wrong ? "design/wrong-diagram" : "design/syntax",
        message: p.message.slice(0, 2_000),
        line,
        column: p.column !== null && p.column >= 1 ? p.column : null,
        ...(at !== undefined ? { text: at.slice(0, 500) } : {}),
        parts: [],
        fixes: wrong
          ? ["Start the file with the header for its type, or add it as the design type it is"]
          : [PARSE_FIX],
      };
    });
    const first = errors[0];
    const place =
      first?.line == null
        ? ""
        : first.column == null
          ? ` (line ${first.line})`
          : ` (line ${first.line}, column ${first.column})`;
    const more = errors.length > 1 ? `, and ${errors.length - 1} more` : "";
    return {
      ok: false,
      errors: errors.slice(0, MAX_ERRORS),
      message: `${name} won't draw, so it wasn't saved${place}: ${first?.message ?? "it could not be read"}${more}`,
    };
  }
}
