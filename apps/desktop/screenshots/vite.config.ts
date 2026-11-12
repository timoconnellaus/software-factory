// The screenshot harness's view build (ADR 0460): the app's own view, with bridge.ts swapped for
// the fixture door. `node screenshots/shoot.mjs` serves it and drives Chrome.
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const bridge = resolve(import.meta.dirname, "../src/mainview/bridge.ts");
const fake = resolve(import.meta.dirname, "fake-bridge.ts");

const swapBridge: Plugin = {
  name: "swap-bridge",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!source.endsWith("bridge.ts")) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    return r?.id === bridge ? fake : null;
  },
};

export default defineConfig({
  plugins: [swapBridge, react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  root: resolve(import.meta.dirname, "../src/mainview"),
  server: { port: 5741, strictPort: true },
  logLevel: "warn",
});
