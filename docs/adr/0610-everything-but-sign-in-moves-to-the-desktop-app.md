# ADR 0610: Everything but sign-in moves to the desktop app, policy decisions included

Status: accepted, 2026-11-13 (the owner's decisions below). Spec [40](../specs/40-desktop-app.md)
M5, brought forward. **Amends** [ADR 0391](0391-the-client-door-desktop-devices-and-presence.md)
(what stays browser-only), [0392](0392-the-website-shrinks-to-auth.md) (when the website shrinks),
[0516](0516-the-workflow-classifier-is-an-allow-list.md)'s rule that an org config change is decided in the
app only, and [0543](0543-policy-changes-are-approved-on-the-phone-with-a-fingerprint.md) where it
names the website as a place to approve. Consistent with [ADR 0340](0340-a-cli-for-people-gates-stay-in-the-browser.md):
no token an agent might hold (CLI, MCP, runner, agent) gains anything.

## Context
ADR 0392 shrinks the website to sign-in once the desktop app has every screen (spec 40 M5). Until
then the website grew screens of its own: the project config editor, the org workflow editor and
some Setup steps. The decisions behind those screens stayed **browser-only** on purpose: until the
Secure Enclave key helper (spec 40 M4b, [ADR 0394](0394-the-key-helper-is-its-own-signed-bundle.md))
is in every build, a process running as the owner on their Mac can act as the desktop app, so the
website was the one place a policy decision could not be made by such a process. These are:
- approving a change that loosens a project's config or an org workflow (`approval.decide` on an org
  config proposal);
- editing org workflows and agents, rolling an org's config back, adopting projects' workflows into
  the org (`workflow.save`, `workflow.createFromTemplate`, `workflow.archive`, `agent.save`,
  `orgConfig.rollback`, `orgConfig.adoptProjectWorkflows`);
- turning on auto-approval ("dark factory mode", ADR 0515), which is a workflow setting;
- lifting an auto-approval hold (a project config save, ADR 0515 rule 7);
- turning a kill switch off (`killSwitch.set { on: false }`).

## Decision
The owner decided, on 2026-11-13, in his words:
1. On the website: "it looks like the web app has features now - but I only want them in the
   desktop app. Let's leave the web just for auth as a utility. Everything else happens in the
   app."
2. Asked whether the policy decisions above should wait for the key helper: "Move everything to the
   desktop app now and accept the risk until the helper exists."
3. Asked when the website's work pages come out: "Remove them now."

So:
- **The website keeps only auth as a utility:** sign-in and sign-out, Connect GitHub and its
  callback, the device approval pages (CLI, desktop, phone, runner), device management, and the
  `/open/*` trampoline. Every other route is removed and redirects through `/open/` to the desktop
  app; no screen exists in both apps (spec 40 M5, now).
- **Every other screen is in the desktop app,** including the project config editor and the org
  workflow editor, built before the website's copies are removed.
- **The policy decisions above become decidable on the `desktop` surface, each with a presence
  proof** (the same Touch ID proof the merge gate takes, for that exact operation and input). The
  org config approval that ADR 0516 kept in the app only takes the proof on the desktop too.
- **Nothing else changes about who may decide.** The phone stays as ADR 0541 and 0543 have it. No
  agent, runner, CLI or MCP token may make any of these decisions; tests pin the refusals. Device
  approvals (CLI, desktop, phone, runner logins) stay on the website, where the device being
  approved isn't the one approving.

## The accepted risk, in plain terms
Until the key helper lands, **a process running as the owner on their Mac can act as the desktop
app.** It can read the desktop token and use the key the app holds today. With policy decisions
decidable on the desktop, such a process could therefore approve a loosening of the factory's own
rules: an org workflow change, turning on auto-approval, lifting a hold, a kill switch off.

What still stands in the way:
- **The presence proof** each of these decisions needs. Until the helper, it is made with the app's
  current key, which has the same weakness: a process that can act as the app can use that key.
  It stops a stolen token being used anywhere else, not a process on this Mac.
- **The audit journal** records every decision with the device and the proof's summary, so a
  decision nobody remembers making shows up, and can be rolled back (config and org config keep
  their versions).
- **Nothing merges without `factory/verify` and the merge gate** (ADR 0020, 0021, 0037). A loosened
  rule changes what the factory may do on its own, but every change still reaches `main` only
  through verify, and self-modify still goes to a person (ADR 0515's `SELF_MODIFY_PATHS` hold in
  code, whatever a workflow says).

**The key helper's PR 4 tightens this** to proofs from helper-held keys only: a key the app's own
process can't use, which asks for Touch ID (or the login password) on every signature and shows the
engine's summary of the decision. From then on, a process on the Mac can make a prompt appear but
can't approve it (ADR 0391, consequences).

## Consequences
- Spec 40 M1's acceptance criterion 5 changes: turning a kill switch off is presence-decidable on
  the desktop. Approving a device login and registering a runner or rotating its key stay refused
  on the desktop.
- `packages/core/test/decidability.test.ts` changes in the PR that makes these operations
  decidable, so the change shows in that PR.
- Any further loosening (a decision without a proof, or from another surface) is a human-only change
  to this ADR.
- A person without the desktop app can no longer change policy or see work from a browser. The
  website says so and links to the download.

## Amendment, 2026-11-13: as built (step 3)
- **Presence-decidable on the desktop only** (`presenceDecidable` with `presenceSurfaces:
  ["desktop"]`): `workflow.save`, `workflow.createFromTemplate`, `workflow.archive`, `agent.save`,
  `orgConfig.rollback`, `orgConfig.adoptProjectWorkflows`, `override.approve` and `killSwitch.set`
  with `on: false`. `approval.decide` on an org config proposal and `override.approve` check in the
  handler that the call came from the website or carries a desktop proof (`policyDecisionSurface`).
  The phone stays refused for all of them (ADR 0541, 0543).
- **Adopting projects' workflows as a dry run** writes nothing and decides nothing, so it is one tap
  on the desktop (`desktopOneTap`, a new per-input flag for the desktop only); the CLI and MCP stay
  refused, as before.
- **Each proof's summary is the engine's**, naming what is decided and, first, what it loosens
  (`policy-summary.ts`): for example `Save the org workflow (v4 to v5): loosens: …: "Release" in
  "Acme"`. Names come last, without quotes or invisible characters, at most 60 characters.
- `packages/core/test/decidability.test.ts` pins the table; `test/policy-decisions.test.ts` pins
  that agents, runners, the CLI, MCP, the phone and a desktop without a proof are refused.
