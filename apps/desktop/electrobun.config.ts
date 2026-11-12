import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Software Factory",
    identifier: "com.software-factory.desktop",
    version: "0.0.1",
    // Sign-in callback and work-item links (ADR 0391, 0372). macOS registers the scheme once the
    // .app is in /Applications.
    urlSchemes: ["sf"],
  },
  runtime: {
    // It lives in the menu bar: closing the window keeps the app and the runner up.
    exitOnLastWindowClosed: false,
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      // The runner child (ADR 0390): a pinned Node 24 and the bundled sf-runner. The key helper
      // makes and uses the Secure Enclave key (ADR 0391). All three come from scripts/bundle.sh.
      "vendor/node": "runner/node",
      "vendor/sf-runner.mjs": "runner/sf-runner.mjs",
      "vendor/sf-keys": "native/sf-keys",
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      createDmg: false,
    },
  },
} satisfies ElectrobunConfig;
