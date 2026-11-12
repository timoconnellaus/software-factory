import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "SF Spike",
		identifier: "dev.software-factory.spike",
		version: "0.0.1",
		// Deep links: sign-in callback and work-item links. macOS only registers the scheme once the
		// .app is in /Applications.
		urlSchemes: ["sf-spike"],
	},
	runtime: {
		// It lives in the menu bar: closing the window must not quit (or stop the runner).
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: { entrypoint: "src/bun/index.ts" },
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// The runner child: a pinned Node 24 and the bundled sf-runner (scripts/vendor-node.mjs,
			// scripts/bundle-runner.mjs), plus a stand-in runner for supervision tests.
			"vendor/node": "runner/node",
			"vendor/sf-runner.mjs": "runner/sf-runner.mjs",
			"fake-runner/runner.mjs": "runner/fake-runner.mjs",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			createDmg: false,
		},
	},
} satisfies ElectrobunConfig;
