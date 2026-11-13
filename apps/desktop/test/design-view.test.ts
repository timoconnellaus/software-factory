// Spec 22 part B: what the System tab draws over a design's preview: changes against the pulled
// base by part, pins on a part that follow it, and the preview only ever as an image.
import type { DesignPreview } from "@software-factory/client/planning";
import { describe, expect, it } from "vitest";
import {
  comparison,
  designOverlays,
  pinOn,
  pinOnPart,
  pinPlace,
  svgDataUrl,
} from "../src/mainview/lib/design-view.ts";

const part = (id: string, sig: string, x = 0) => ({
  id,
  kind: "table" as const,
  label: id,
  sig,
  box: { x, y: 0, w: 100, h: 50 },
});
const preview = (parts: ReturnType<typeof part>[]): DesignPreview => ({
  svg: "<svg/>",
  width: 400,
  height: 100,
  parts,
  warnings: [],
  sha256: "0".repeat(64),
});

describe("the System tab's drawing (spec 22 part B)", () => {
  it("marks parts added and changed against the base, and lists the removed ones", () => {
    const base = preview([part("table a", "1"), part("table b", "1"), part("table gone", "1")]);
    const now = preview([part("table a", "1"), part("table b", "2"), part("table new", "1", 200)]);
    const d = designOverlays(now, base);
    expect(d.overlays.map((o) => [o.part.id, o.change])).toEqual([
      ["table a", null],
      ["table b", "changed"],
      ["table new", "added"],
    ]);
    expect(d.removed.map((p) => p.id)).toEqual(["table gone"]);
    expect(d.counts).toEqual({ added: 1, changed: 1, removed: 1 });
    // No base (a design the planner made): nothing is marked.
    expect(designOverlays(now, null).overlays.every((o) => o.change === null)).toBe(true);
  });

  it("pins on a part by its id, and the pin follows the part when it moves", () => {
    const pin = pinOnPart("art_1", { width: 400 }, part("table users", "1", 100), {
      x: 175,
      y: 10,
    });
    expect(pin).toMatchObject({ artifactId: "art_1", element: "table users", fx: 0.75, fy: 0.2 });
    expect(pinPlace(pin, [part("table users", "1", 300)])).toEqual({ x: 375, y: 10 });
    expect(pinPlace(pin, [])).toEqual({ x: 175, y: 10 });
  });

  it("shows the SVG only as a data URL for an image", () => {
    expect(svgDataUrl('<svg><text>a&b "c"</text></svg>')).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Ctext%3Ea%26b%20%22c%22%3C%2Ftext%3E%3C%2Fsvg%3E",
    );
  });

  it("never shows a failed, pending or drawing-less base as no changes (review of #168)", () => {
    const base = preview([part("table a", "1")]);
    const read = (
      r: Partial<{ isPending: boolean; isError: boolean; error: unknown; data: unknown }>,
    ) => ({ isPending: false, isError: false, ...r }) as Parameters<typeof comparison>[2];
    expect(comparison(false, true, read({ data: { preview: base } }))).toEqual({ kind: "off" });
    expect(comparison(true, false, read({ data: { preview: base } }))).toEqual({ kind: "off" });
    expect(comparison(true, true, read({ isPending: true }))).toEqual({ kind: "loading" });
    expect(comparison(true, true, read({ isError: true, error: new Error("offline") }))).toEqual({
      kind: "error",
      message: "offline",
    });
    expect(comparison(true, true, read({ data: { preview: null } }))).toEqual({
      kind: "no-drawing",
    });
    expect(comparison(true, true, read({ data: { preview: base } }))).toEqual({
      kind: "ready",
      base,
    });
  });

  it("places a pin on its part, and not at all when the part is gone from a later revision", () => {
    const pin = pinOnPart("a", { width: 400 }, part("table users", "1"), { x: 50, y: 25 }, 2);
    expect(pin.revision).toBe(2);
    expect(pinOn(pin, [part("table users", "1", 100)], 3)).toEqual({ x: 150, y: 25 });
    expect(pinOn(pin, [], 3)).toBeNull();
    expect(pinOn({ ...pin, element: "nowhere" }, [], 2)).toEqual({ x: 50, y: 25 });
    // A part that exists without a box isn't "removed": the pin stays where it was put.
    expect(pinOn(pin, [{ ...part("table users", "1"), box: null }], 3)).toEqual({ x: 50, y: 25 });
  });
});
