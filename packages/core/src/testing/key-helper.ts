// The key helper's rules for a summary (apps/desktop/native/sf-keys-app, `parsePresenceMessage` in
// Core.swift), ported so engine tests can check every summary they produce would be signed: a
// summary the helper refuses makes the decision impossible from the desktop. A drift test in
// apps/desktop compares these with Core.swift (review of #156, item 4).

/** Core.swift `maxSummaryCharacters`. */
export const HELPER_MAX_SUMMARY = 300;

/**
 * Why the helper would refuse this summary, or null. Swift counts Characters (grapheme clusters)
 * and refuses any scalar in `CharacterSet.controlCharacters` (general categories Cc and Cf).
 */
export function keyHelperRefusal(summary: string): string | null {
  if (summary.trim().length === 0) return "empty summary";
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(summary)];
  if (graphemes.length > HELPER_MAX_SUMMARY) return "summary too long";
  if (/[\p{Cc}\p{Cf}]/u.test(summary)) return "control characters in the summary";
  return null;
}
