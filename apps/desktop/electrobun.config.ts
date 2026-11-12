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
  // The first-install download (spec 40 M4): postPackage zips the signed wrapper.
  scripts: {
    postPackage: "scripts/hook-post-package.ts",
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
      // Signing and notarization (spec 40 M4) are Electrobun's own: they have to happen after it
      // writes the build hash into Resources/version.json, which no hook sees. They switch on with
      // the release environment's variables: ELECTROBUN_DEVELOPER_ID, ELECTROBUN_TEAMID, and the
      // App Store Connect key (ELECTROBUN_APPLEAPIKEY, ELECTROBUN_APPLEAPIISSUER,
      // ELECTROBUN_APPLEAPIKEYPATH). Local builds stay unsigned.
      codesign: !!process.env.ELECTROBUN_DEVELOPER_ID,
      notarize: !!process.env.ELECTROBUN_DEVELOPER_ID && !!process.env.ELECTROBUN_APPLEAPIKEYPATH,
      // Bun (JavaScriptCore) and Node (V8) JIT-compile under the hardened runtime. Nothing else: no
      // keychain access group (only the key helper may carry one, ADR 0391).
      entitlements: {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
      },
    },
  },
} satisfies ElectrobunConfig;
