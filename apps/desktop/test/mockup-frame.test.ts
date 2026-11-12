// Spec 21 criterion 1 (ADR 0472): a mockup frame can't reach the app. The CSP and the frame
// script come before anything of the planner's, however its HTML is written, and the frame is
// sandboxed without `allow-same-origin`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSP, frameDocument } from "../src/mainview/lib/mockup-frame.ts";

const CSP_META = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>`;

describe("mockup frames", () => {
  it("puts the CSP and the frame script first, whatever the planner's HTML looks like", () => {
    for (const html of [
      "<!doctype html><html><head><title>A</title></head><body><p>x</p></body></html>",
      "<!--<head>--><script>fetch('https://example.com')</script><head></head>",
      "<p>A fragment</p>",
      "<!DOCTYPE HTML><HTML><BODY>x</BODY></HTML>",
    ]) {
      const doc = frameDocument(html);
      expect(doc.startsWith(CSP_META)).toBe(true);
      expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    }
  });

  it("allows no calls home and no form posts", () => {
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).toContain("form-action 'none'");
  });

  it("renders the frame sandboxed with scripts only, so its origin is opaque", () => {
    const view = readFileSync(
      new URL("../src/mainview/components/planning-visuals.tsx", import.meta.url),
      "utf8",
    );
    const code = view.replace(/^\s*\/\/.*$/gm, "");
    const sandboxes = [...code.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);
    expect(sandboxes.length).toBeGreaterThan(0);
    for (const s of sandboxes) expect(s).toBe("allow-scripts");
    expect(code).not.toContain("allow-same-origin");
  });
});
