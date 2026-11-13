// The planning MCP server's design checks (spec 22 part B, ADR 0305): a design is checked and drawn
// on the runner, as kim's are in its CLI. One that won't draw is refused with each problem's line,
// the line and a fix, and never reaches the cloud; one that draws is saved with its preview (an SVG
// this repo's code drew, with every part's box), and its layout warnings go back to the planner. A
// pulled design's base gets its preview after the pull. The checks package is loaded on first use,
// so the hooks never load the parsers.
import type { DesignPreview, DesignType, PlanningOp } from "@software-factory/runner-contract";

export type DesignChecker = (
  type: DesignType,
  source: string,
  name?: string,
) => Promise<
  | { ok: true; preview: DesignPreview }
  | { ok: false; errors: DesignPreview["warnings"]; message: string }
>;

type Call = (op: PlanningOp, args: Record<string, unknown>) => Promise<unknown>;

const loadChecker = async (): Promise<DesignChecker> =>
  (await import("@software-factory/planning-designs")).checkDesign;

/** What this server knows of an artifact's type, from the saves and reads it relayed. */
const known = new Map<string, DesignType | null>();

async function designTypeOf(call: Call, artifactId: string): Promise<DesignType | null> {
  if (known.has(artifactId)) return known.get(artifactId) ?? null;
  const read = (await call("artifact.read", { artifactId })) as { designType?: string | null };
  const type = (read.designType ?? null) as DesignType | null;
  known.set(artifactId, type);
  return type;
}

/** The refusal the planner reads: the sentence, then each problem with its line and fix. */
function refusal(message: string, errors: DesignPreview["warnings"]): string {
  return `${message}\n${JSON.stringify({ diagnostics: errors, fix: "Fix the design and save it again." }, null, 2)}`;
}

/**
 * Before `artifact.add` of a design, or `artifact.update` with new content of one: check and draw
 * it. Refused: the text to return. Saved: `args.preview` is set and the warnings are returned.
 */
export async function designBeforeSave(
  op: PlanningOp,
  args: Record<string, unknown>,
  call: Call,
  check?: DesignChecker,
): Promise<{ refused?: string; warnings?: DesignPreview["warnings"] } | null> {
  let type: DesignType | null = null;
  if (op === "artifact.add" && args.kind === "design" && typeof args.designType === "string") {
    type = args.designType as DesignType;
  } else if (op === "artifact.update" && typeof args.content === "string") {
    type = await designTypeOf(call, String(args.artifactId));
  }
  if (!type || typeof args.content !== "string") return null;
  const name = typeof args.title === "string" ? `"${args.title}"` : undefined;
  const result = await (check ?? (await loadChecker()))(type, args.content, name);
  if (!result.ok) return { refused: refusal(result.message, result.errors) };
  args.preview = result.preview;
  return { warnings: result.preview.warnings };
}

/**
 * After `design.pull` of a design (or an add whose id it learns): store the preview of the pulled
 * base (revision 0) and, for a first pull, of revision 1 (the same content). A pulled file that
 * won't draw is told to the planner, so its next revision fixes it.
 */
export async function designAfterPull(
  op: PlanningOp,
  result: unknown,
  call: Call,
  check?: DesignChecker,
): Promise<{ warnings?: DesignPreview["warnings"]; wontDraw?: string } | null> {
  const r = result as { artifactId?: string; revision?: number; changed?: boolean };
  if (op !== "design.pull" || !r.artifactId) return null;
  const base = (await call("artifact.read", { artifactId: r.artifactId, revision: 0 }).catch(
    () => null,
  )) as { designType?: string | null; content?: string } | null;
  known.set(r.artifactId, (base?.designType ?? null) as DesignType | null);
  if (!base?.designType || typeof base.content !== "string") return null;
  const result2 = await (check ?? (await loadChecker()))(
    base.designType as DesignType,
    base.content,
    "the pulled file",
  );
  if (!result2.ok) return { wontDraw: `${result2.message}. Fix it in your next revision.` };
  const revisions = r.changed ? [0] : [0, r.revision ?? 1];
  for (const revision of revisions) {
    await call("design.preview", { artifactId: r.artifactId, revision, preview: result2.preview });
  }
  return { warnings: result2.preview.warnings };
}
