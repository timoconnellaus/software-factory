# Handoff: the desktop app (spec 40), M4 onward

Written 2026-11-12 by the session that built spec 40 M1–M3. Delete this file in the PR that finishes
M4a (fold anything still true into `docs/handoff.md`).

Read first: `AGENTS.md`, `docs/handoff.md` (the "Desktop app" entry),
`docs/specs/40-desktop-app.md` (M4 "As built"), ADRs `docs/adr/0390`–`0392`, and
`apps/desktop/README.md`.

Block **W** is the desktop app's: migrations 0160–0169, ADRs 0390–0399. Other sessions keep taking
numbers in their branches, so check `docs/parallel-work.md` on `main` **and in open PRs** before
using one.

## Merged on `main`
- Spike #44, spec #46.
- M1 #49: the client door, desktop devices, presence proofs, migration 0160.
- M2a #52 and M2b #54 (the live socket).
- M3 #56: the screens, and `packages/client`.
- #58: the view's `bun.call` fix.

They're deployed, and `/client/v1/*` and `/open/*` respond correctly in production.

## In progress: M4a, signed releases
Branch `timoconnellaus/desktop-m4`, pushed, **no PR yet**. This file is on that branch.

- **`.github/workflows/desktop-release.yml`:**
  - Runs on `macos-15` in the GitHub environment `release`, which only `main` and `v*` tags can use.
  - Builds canary (version `0.1.<run>`) on pushes to `main` that touch the app, and stable on `v*` tags.
  - Imports the certificate into a throwaway keychain.
  - Uploads to R2 bucket `sf-desktop-releases` under `desktop/`, using the repo's `CLOUDFLARE_API_TOKEN`.
- **Signing is Electrobun's own** (`mac.codesign`/`notarize` in `apps/desktop/electrobun.config.ts`),
  switched on by the `ELECTROBUN_*` variables:
  - `ELECTROBUN_DEVELOPER_ID` and `ELECTROBUN_TEAMID`;
  - `ELECTROBUN_APPLEAPIKEY`, `ELECTROBUN_APPLEAPIISSUER` and `ELECTROBUN_APPLEAPIKEYPATH`.

  Signing from a build hook doesn't work. Electrobun rewrites `Contents/Resources/version.json`
  after every hook, which breaks the seal, and macOS then says the app is "damaged". This was found
  on the M5.
- **`scripts/hook-post-package.ts`** zips the signed wrapper as the first-install download,
  `<channel>-macos-arm64-Software-Factory.zip`.
- **`scripts/vendor-node.mjs`** downloads Node 24.21.0 from nodejs.org and checks it against
  SHASUMS256 when `NODE_DIST_VERSION` is set. It copies the local `node` otherwise.
- **`src/bun/updates.ts`** checks every 6 hours, downloads in the background, and adds a menu-bar
  item, "Restart to update", which stops the runner first.

## Infrastructure already set up
- **R2:** bucket `sf-desktop-releases` in the factory's Cloudflare account (repo variable
  `CLOUDFLARE_ACCOUNT_ID`). Its custom domain is `downloads.zerobsai.com`, and the release
  `baseUrl` is `https://downloads.zerobsai.com/desktop`.
- **Secrets in the `release` environment**, already set:
  - `MACOS_CERT_P12` and `MACOS_CERT_PASSWORD`: only the Developer ID Application identity.
  - `MACOS_SIGNING_IDENTITY` and `APPLE_TEAM_ID`.
  - `ASC_KEY_P8`, `ASC_KEY_ID` and `ASC_ISSUER_ID`: a notarization key with the Developer role,
    already checked with `notarytool`.
- **The Developer ID** is in the **M5's** login keychain. The M1 has none, and shouldn't: CI is
  the place to sign.

## Running when this was handed off
A test of commit `75503ba` on the M5, in worktree
`~/orca/workspaces/software-factory/desktop-m4-signing-test`, in the Orca terminal titled
"app check". It does the full Electrobun-signed and notarized canary build, launches it, and
then has to show all of these:
- `codesign --verify --deep --strict` still valid **after** the first launch (`verify=0`);
- `spctl` accepting it;
- the app's `bun` and its processes running.

It prints `END-FULL` when it's done.

To read it:
1. Get the handle from `orca worktree ps --environment m5 --json`, on the `desktop-m4-signing-test`
   workspace.
2. Run `orca terminal read --environment m5 --terminal <handle> --json`.

The earlier failed launch was moved to the Trash from the "damaged" dialog.

## Next steps
1. **If the M5 test passes:**
   - Open the M4a PR and attach it: `local/cli/bin/sf attach <pr>`.
   - The owner has told us to merge desktop PRs ourselves once `ci` passes, so merge it with
     `gh pr merge --merge`. Before merging, check `ci` on the PR's **current head commit**
     (`gh api repos/<owner>/<repo>/commits/<sha>/check-runs`), because `gh pr checks` can report
     the previous commit's result.
   - Watch the first `Desktop release` run. Check that
     `https://downloads.zerobsai.com/desktop/canary-macos-arm64-update-v2.json` and
     `…/canary-macos-arm64-Software-Factory.zip` load.
   - Tell the owner to install from the zip: unzip it and move it to `/Applications`.
2. **If it fails:**
   - Look for files changed after signing (`codesign --verify --deep --strict --verbose=4` on the
     launched app).
   - Check whether Electrobun's signing covers `Resources/app/runner/node` and
     `Resources/app/native/sf-keys` with the JIT entitlements (`codesign -d --entitlements -`).
3. **M4b, the Secure Enclave key (Touch ID approvals).** Tested on the M5 with the real
   certificate:
   - A command-line `sf-keys` signed with `keychain-access-groups` and no provisioning profile is
     killed (`Killed: 9`, restricted entitlement).
   - Without the entitlement, the Secure Enclave refuses with `-34018`.

   The fix:
   - Make `sf-keys` its own small bundle (`SF Keys.app` inside the app) with its own App ID, for
     example `com.software-factory.desktop.keys`, and an embedded **Developer ID provisioning
     profile**.
   - The owner has to create the App ID and the profile in the Apple Developer portal. Give them
     step-by-step instructions, and add the profile as a `release` secret.
   - Find out whether Electrobun's signing re-signs a nested `.app` and overwrites its
     entitlements.
   - ADR 0391's guarantees must still hold: only the helper may use the key, and it shows only the
     signed, engine-written summary.

   Until M4b lands, signed builds use a software key, and the engine refuses software keys for
   gate decisions (`DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in production).
4. **The rest of M4:** the client door's `update_required` version handshake.
5. **M5:** reduce `apps/app` to sign-in, Connect GitHub, the device approval pages, device
   management and `/open/*`.
   - **Keep the project settings and workflows pages (spec 09) on the website** for now: the
     desktop app doesn't have them yet.
   - The `factory/verify` check and notifications should link through `/open/`.

## Things to watch for
- **Stage files explicitly** on branches that don't have `apps/desktop/.gitignore`. A `git add -A`
  there once committed 138k lines from `.hutch/` and `build/`.
- **When `main` moves,** merge it in and keep both sides of every conflict. The project uses
  merge commits only: no rebase or force-push.
- **Electrobun's request proxy is a function,** so RPC names like `call` used to hit
  `Function.prototype`. `src/mainview/request.ts` handles it; keep using `bunRequests`.
- **Pushes print "Cannot update this protected ref" / "creations being restricted"** but succeed.
  Compare local and remote heads to be sure.
- **Orca terminals on the M5:**
  - Don't run commands that open a pager (for example `git log` without `| cat`); it stalls the
    terminal.
  - Chat sessions can't be sent text with `orca terminal send`.
