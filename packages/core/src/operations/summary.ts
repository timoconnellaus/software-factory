// What a presence prompt may show of text a person or agent wrote (spec 40 M4b, ADR 0391): the
// engine's facts first, such text last, cleaned and cut. Used by every describeDecision case and
// the config summaries (config.ts).

/** The longest summary a Touch ID sheet or phone prompt is given (spec 40 M4b). */
export const MAX_SUMMARY = 120;

/**
 * A title as a summary may show it: no double quotes (it is quoted), no format characters (Cf:
 * zero-width and bidi controls, which hide or reorder text), no line or paragraph separators (Zl,
 * Zp) or control characters (which break the line), whitespace collapsed. Titles are written by
 * agents and people; the key helper refuses a summary with any of these, so leaving one in would
 * also make the item undecidable from the desktop.
 */
export function cleanTitle(title: string): string {
  return title
    .replace(/\p{Cf}/gu, "")
    .replace(/["\p{Zl}\p{Zp}\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `facts "title"`: the facts whole and first, then the title, cut to the room the facts leave under
 * MAX_SUMMARY (and left out when there's too little). Whatever a title says, it can't push the
 * engine's facts off the prompt, nor pose as one of them; the facts are never truncated.
 */
export function titled(
  facts: string,
  title: string | null | undefined,
  /** Words before the quoted title, shown only with it (`; project` → `…; project "Acme"`). */
  label = "",
): string {
  const lead = label;
  const t = [...cleanTitle(title ?? "")];
  const room = MAX_SUMMARY - [...facts].length - [...lead].length - 3;
  if (t.length === 0 || room < 8) return facts;
  return `${facts}${lead} "${t.length > room ? `${t.slice(0, room - 1).join("")}…` : t.join("")}"`;
}

/**
 * Engine-written text that may carry a person's words (a policy change's summary names stages and
 * values): format characters dropped, line breaks and control characters as spaces. Quotes stay.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Zl}\p{Zp}\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
