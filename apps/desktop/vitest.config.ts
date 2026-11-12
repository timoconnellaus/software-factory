// Pure logic runs on Node: deep links, PKCE, the door client, backoff, and the view's timeline wording.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
