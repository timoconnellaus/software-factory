import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Our own port (docs/parallel-work.md): other sessions run dev servers on this Mac too.
const PORT = Number(process.env.PORT ?? 5180);

export default defineConfig(({ command }) => ({
  // `#/…` is src/, as in `import { op } from "#/lib/ops"`.
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: PORT, strictPort: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // `pnpm dev` also runs sf-engine locally so the ENGINE binding resolves. Deploys build the
      // app alone; sf-engine deploys from apps/engine.
      ...(command === "serve"
        ? { auxiliaryWorkers: [{ configPath: "../engine/wrangler.jsonc" }] }
        : {}),
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}));
