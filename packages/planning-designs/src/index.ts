// The planning design checks (spec 22 part B, ADR 0305): run on the runner by the harness's planning
// MCP server before a design is saved, as kim's run in its CLI. A design that doesn't parse, or isn't
// the type it says, is refused with each problem's line, the line itself and a fix; layout warnings
// save with it. Each design is drawn to a static SVG with the box of every part (the preview the app
// shows as an image, and the `.svg` written beside it in `.kim/designs/`).
import { createHash } from "node:crypto";
import {
  DESIGN_PREVIEW_MAX_BYTES,
  type DesignFinding,
  type DesignPreview,
  type DesignType,
  designPreviewSchema,
} from "@software-factory/runner-contract";
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

/**
 * Ok: the preview, or null when the drawing couldn't be kept (too big to store), with the warnings
 * either way. Not ok: the errors and one sentence for the planner.
 */
export type DesignCheck =
  | { ok: true; preview: DesignPreview | null; warnings: DesignFinding[] }
  | { ok: false; errors: DesignFinding[]; message: string };

/** The most design text this checks; a bigger design is refused (split it). */
export const DESIGN_SOURCE_MAX_BYTES = 300_000;
/** How long a check may take before it is stopped and the save refused. */
export const DESIGN_CHECK_TIMEOUT_MS = 30_000;

const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

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
  if (Buffer.byteLength(source) > DESIGN_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        {
          code: "design/too-big",
          message: `It is over ${DESIGN_SOURCE_MAX_BYTES / 1000} KB`,
          line: null,
          column: null,
          parts: [],
          fixes: ["Split it into one design per area"],
        },
      ],
      message: `${name} is over ${DESIGN_SOURCE_MAX_BYTES / 1000} KB, so it wasn't saved: split it into one design per area`,
    };
  }
  try {
    const drawn = await draw(type, source);
    const warnings = drawn.warnings.slice(0, 20);
    const preview = {
      svg: drawn.svg,
      width: drawn.width,
      height: drawn.height,
      // Ids and labels fit the schema (review of #163); a cut id still compares stably.
      parts: drawn.parts
        .slice(0, 1_000)
        .map((p) => ({ ...p, id: cut(p.id, 300), label: cut(p.label, 300) })),
      warnings,
      sha256: sha256(source),
    };
    // A drawing too big to keep (or one the cloud wouldn't take) saves the design without it.
    const parsed = designPreviewSchema.safeParse(preview);
    if (Buffer.byteLength(drawn.svg) > DESIGN_PREVIEW_MAX_BYTES || !parsed.success) {
      const why =
        Buffer.byteLength(drawn.svg) > DESIGN_PREVIEW_MAX_BYTES
          ? `its drawing is over ${DESIGN_PREVIEW_MAX_BYTES / 1000} KB`
          : `its drawing couldn't be kept (${parsed.error?.issues[0]?.message ?? "invalid"})`;
      return {
        ok: true,
        preview: null,
        warnings: [
          ...warnings.slice(0, 19),
          {
            code: "preview/not-kept",
            message: `Saved without a drawing: ${why}. People see its source in the System tab`,
            line: null,
            column: null,
            parts: [],
            fixes: ["Split it into one design per area"],
          },
        ],
      };
    }
    return { ok: true, preview: parsed.data, warnings };
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

/**
 * `checkDesign` in a worker thread, stopped after `timeoutMs` (review of #163): the parsers and
 * layouts run synchronously on agent-written text, so a pathological design can't hang the MCP
 * server. A timeout or a crash refuses the save.
 */
export async function checkDesignBounded(
  type: DesignType,
  source: string,
  name = `this ${type} design`,
  timeoutMs = DESIGN_CHECK_TIMEOUT_MS,
): Promise<DesignCheck> {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    workerData: { type, source, name },
    // The workspace's TypeScript (parameter properties included) runs as the runner host runs it.
    execArgv: ["--experimental-transform-types", "--no-warnings"],
  });
  const refused = (message: string, code: string): DesignCheck => ({
    ok: false,
    errors: [
      {
        code,
        message,
        line: null,
        column: null,
        parts: [],
        fixes: ["Make it smaller, or split it"],
      },
    ],
    message: `${name} couldn't be checked, so it wasn't saved: ${message}`,
  });
  return await new Promise<DesignCheck>((resolve) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(refused(`checking took over ${timeoutMs / 1000} s`, "design/timeout"));
    }, timeoutMs);
    worker.once("message", (result: DesignCheck) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(refused(error.message, "design/check-failed"));
    });
  });
}
