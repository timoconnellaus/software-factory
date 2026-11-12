import { existsSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const devkit = resolve(import.meta.dirname, ".hutch/devkit");

/** Electrobun's view SDK lives in the Hutch devkit (ADR 0370); `pnpm devkit` fetches it. */
async function electrobunAliases() {
  const helper = resolve(devkit, "api/config/electrobun-vite.ts");
  if (!existsSync(helper))
    throw new Error("no Electrobun devkit: run `pnpm --filter @software-factory/desktop devkit`");
  const { electrobunViteAliases } = (await import(helper)) as {
    electrobunViteAliases: (root: string) => { find: RegExp; replacement: string }[];
  };
  return electrobunViteAliases(devkit);
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: await electrobunAliases(),
    dedupe: ["react", "react-dom"],
  },
  root: "src/mainview",
  base: "./",
  build: { outDir: "../../dist", emptyOutDir: true },
}));
