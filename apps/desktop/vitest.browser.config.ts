// The mockup isolation test (spec 21 criterion 1, review of #90): hostile mockups in real browser
// engines (Chromium, and WebKit as the desktop app's WKWebView). Run with `pnpm test:browser`
// after `npx playwright install chromium webkit`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test-browser/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
