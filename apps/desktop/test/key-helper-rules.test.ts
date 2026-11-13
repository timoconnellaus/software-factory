// The engine's port of the key helper's summary rules (packages/core/src/testing/key-helper.ts),
// which the engine tests run every policy summary through, stays in step with the helper itself
// (Core.swift's `parsePresenceMessage`): a summary the helper refuses can't be decided (review of
// #156, item 4).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELPER_MAX_SUMMARY,
  keyHelperRefusal,
} from "../../../packages/core/src/testing/key-helper.ts";

const CORE_SWIFT = resolve(
  import.meta.dirname,
  "../native/sf-keys-app/Sources/SFKeysCore/Core.swift",
);

describe("the key helper's summary rules", () => {
  it("match Core.swift", () => {
    expect(existsSync(CORE_SWIFT), CORE_SWIFT).toBe(true);
    const swift = readFileSync(CORE_SWIFT, "utf8");
    expect(swift).toMatch(new RegExp(`maxSummaryCharacters = ${HELPER_MAX_SUMMARY}\\b`));
    expect(swift).toContain("CharacterSet.controlCharacters");
    expect(swift).toContain('Refusal("empty summary")');
  });

  it("refuse what the helper refuses", () => {
    expect(keyHelperRefusal("Approve a change")).toBeNull();
    expect(keyHelperRefusal("x".repeat(HELPER_MAX_SUMMARY))).toBeNull();
    expect(keyHelperRefusal("x".repeat(HELPER_MAX_SUMMARY + 1))).toBe("summary too long");
    expect(keyHelperRefusal("a\u00adb")).toBe("control characters in the summary");
    expect(keyHelperRefusal("a\u202eb")).toBe("control characters in the summary");
    expect(keyHelperRefusal("a\nb")).toBe("control characters in the summary");
    expect(keyHelperRefusal("   ")).toBe("empty summary");
  });
});
