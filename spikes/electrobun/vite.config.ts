import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite.ts";

const UI = resolve(import.meta.dirname, "../../packages/ui/src");

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: [
			...electrobunViteAliases(resolve(import.meta.dirname, ".hutch/devkit")),
			// packages/ui straight from source, with its package.json exports mapped by hand.
			{ find: "@software-factory/ui/globals.css", replacement: `${UI}/styles/globals.css` },
			{ find: /^@software-factory\/ui\/lib\/(.*)$/, replacement: `${UI}/lib/$1.ts` },
			{ find: /^@software-factory\/ui\/hooks\/(.*)$/, replacement: `${UI}/hooks/$1.ts` },
			{ find: /^@software-factory\/ui\/components\/(.*)$/, replacement: `${UI}/components/$1.tsx` },
		],
		// One React: packages/ui has its own dev copy in its node_modules.
		dedupe: ["react", "react-dom"],
	},
	root: "src/mainview",
	base: "./",
	build: { outDir: "../../dist", emptyOutDir: true },
});
