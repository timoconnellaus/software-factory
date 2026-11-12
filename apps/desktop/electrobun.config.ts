import type { ElectrobunConfig } from "electrobun";

// Release builds set the version (CI: 0.1.<run> on canary, the tag on stable); local builds are 0.0.1.
const version = process.env.SF_DESKTOP_VERSION?.trim() || "0.0.1";

export default {
  app: {
    name: "Software Factory",
    identifier: "com.software-factory.desktop",
    version,
    // Sign-in callback and work-item links (ADR 0391, 0372). macOS registers the scheme once the
    // .app is in /Applications.
    urlSchemes: ["sf"],
  },
  runtime: {
    // It lives in the menu bar: closing the window keeps the app and the runner up.
    exitOnLastWindowClosed: false,
  },
  // Signing and notarization (spec 40 M4): postBuild signs the full app before it is compressed into
  // the update archive; postWrap signs the self-extracting wrapper people download first. Both do
  // nothing without MACOS_SIGNING_IDENTITY, so local builds stay unsigned.
  scripts: {
    postBuild: "scripts/hook-post-build.ts",
    postWrap: "scripts/hook-post-wrap.ts",
  },
  // Updates (spec 40 M4): canary and stable share one folder; files are prefixed by channel.
  release: {
    baseUrl: "https://downloads.zerobsai.com/desktop",
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
