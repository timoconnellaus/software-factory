// Planning visuals (spec 21, ADR 0472): the controls a mockup declares, the values an answer sets in
// it, and the frame a mockup is drawn in. Shared by the cloud (validation, `applied` in news), the
// harness (tool schemas) and the apps (live previews), so they can't drift. Runtime-neutral.
import { z } from "zod";

/**
 * A control a mockup declares (kim's semantics, the factory's attribute names):
 * - `--accent`: a CSS variable, set on the document's root;
 * - `@nav`: a variant attribute, `data-plan-nav="…"`, styled with `[data-plan-nav="top"]`;
 * - `#headline`: a text slot, an element with `data-plan-text="headline"` holding only text.
 */
export const CONTROL_PATTERN = /^(--[a-z][a-z0-9-]*|@[a-z][a-z0-9-]*|#[a-z][a-z0-9-]*)$/;
export const controlSchema = z
  .string()
  .trim()
  .regex(CONTROL_PATTERN, "a control is --variable, @attribute or #text-slot, e.g. --accent, @nav, #headline");

/** CSS units a number answer may carry. */
export const UNIT_PATTERN = /^(px|rem|em|%|vh|vw|ch|deg|ms|s)$/;

/** The most an artifact revision may hold, in UTF-8 bytes (kim's limit; a D1 row, ADR 0472). */
export const ARTIFACT_MAX_BYTES = 1_900_000;

/** Every control an HTML document declares, sorted. */
export function declaredControls(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/(?:^|[\s;{(,])--([a-z][a-z0-9-]*)\s*:/g)) found.add(`--${m[1]}`);
  for (const m of html.matchAll(/var\(\s*--([a-z][a-z0-9-]*)/g)) found.add(`--${m[1]}`);
  for (const m of html.matchAll(/data-plan-text\s*=\s*["']([a-z][a-z0-9-]*)["']/g)) {
    found.add(`#${m[1]}`);
  }
  for (const m of html.matchAll(/\[?data-plan-([a-z][a-z0-9-]*)\b/g)) {
    if (m[1] !== "text") found.add(`@${m[1]}`);
  }
  return [...found].sort();
}

/** The bound fields of a question, as the cloud stores and the apps read them. */
export interface BoundQuestion {
  kind: string;
  artifactId: string | null;
  optionValues: Record<string, Record<string, string>> | null;
  control: string | null;
  unit: string | null;
}

/**
 * What an answer sets in its question's artifact: the chosen options' values (a multiple-choice
 * answer joins them, later options winning), a number with its unit, or a text slot's text. Null
 * when the question isn't bound or the answer sets nothing.
 */
export function appliedValues(
  q: BoundQuestion,
  answer: string | null,
): Record<string, string> | null {
  if (!q.artifactId || answer === null) return null;
  if (q.optionValues && Object.keys(q.optionValues).length) {
    const chosen = q.kind === "multiple-choice" ? answer.split(", ") : [answer];
    const values: Record<string, string> = {};
    for (const option of chosen) Object.assign(values, q.optionValues[option] ?? {});
    return Object.keys(values).length ? values : null;
  }
  if (q.control && q.kind === "number" && answer.trim() !== "") {
    return { [q.control]: `${answer.trim()}${q.unit ?? ""}` };
  }
  if (q.control && q.kind === "text") return { [q.control]: answer };
  return null;
}

/** A frame's size: desktop unless the title or description says phone or tablet (kim's rule). */
export function frameSize(title: string, description: string | null): {
  width: number;
  height: number;
  device: "desktop" | "tablet" | "phone";
} {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  if (/\b(phone|mobile)\b/.test(text)) return { width: 390, height: 844, device: "phone" };
  if (/\btablet\b/.test(text)) return { width: 834, height: 1112, device: "tablet" };
  return { width: 1280, height: 800, device: "desktop" };
}

/** A comment pinned to a spot in an artifact: the element, and where it is (spec 21). */
export const pinSchema = z.object({
  artifactId: z.string().min(1),
  /** The element's data-name, else a short description such as `button "Pay"`. */
  element: z.string().trim().min(1).max(300),
  /** A CSS selector that finds the element again, when it has no data-name. */
  selector: z.string().trim().min(1).max(1_000).nullable().default(null),
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  /** Where in the element's box the pin sits, so it follows the element. */
  fx: z.number().finite().min(0).max(1),
  fy: z.number().finite().min(0).max(1),
  /** The document's width when the pin was placed. */
  width: z.number().finite().positive().max(10_000),
});
export type Pin = z.output<typeof pinSchema>;
