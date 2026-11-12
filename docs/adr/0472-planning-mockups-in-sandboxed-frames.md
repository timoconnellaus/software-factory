# ADR 0472: Planning mockups live in D1 and render in sandboxed frames

Status: accepted, 2026-11-12 (spec 21, block AE). Amends [ADR 0305](0305-planning-artifacts-and-the-kim-folder.md)
for storage; builds on [0350](0350-how-the-planning-loop-is-wired.md) and [0470](0470-planning-steering.md).

## Context
Spec 21 gives the planner mockups: HTML it writes, shown beside its questions, chosen between as
option cards, changed live by answers, and commented on by pinning a spot. The plan assumed content
in R2 and mockups served "from a separate, sandboxed origin". Two facts from the build:
- the R2 bucket the engine has is the attachments bucket, whose stray-blob sweep deletes every key
  without an attachment row, so planning content can't share it;
- the daily UI is the desktop app (spec 40), which renders the view in a webview; the website is
  shrinking to auth (ADR 0392). A separate hosted origin would add a domain, a route and a cookie
  story for a page the desktop can render itself.

## Decision
- **Content in D1, by revision.** `core_planning_artifacts` holds what an artifact is (kind, title,
  description, keep, the latest revision); `core_planning_artifact_revisions` holds each revision's
  content and the controls it declares. A revision is at most 1,900,000 bytes, kim's own limit, so
  it fits a D1 row. Every revision is kept.
- **An opaque origin, not a hosted one.** A mockup renders in an `<iframe sandbox="allow-scripts">`
  (no `allow-same-origin`, no forms, no popups, no top navigation) from `srcdoc`, with a
  Content-Security-Policy `<meta>` the app adds first: no network but the CDNs mockups may use for
  fonts and libraries (`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`,
  `fonts.googleapis.com`, `fonts.gstatic.com`), no `connect-src`. Its origin is `null`: its
  scripts can't read the app's cookies, storage or DOM, and can't call the client door.
- **One small protocol over `postMessage`.** The app injects a script into each frame. The frame
  posts `ready` (with the controls it found and its height), `pin` (the element under the click:
  its `data-name`, else a short description, a selector, and where in the page and the element it
  sits) and `values` (what it applied). The app posts `apply` (values to set), `preview` (values
  shown while an option is hovered) and `pin-mode`. The app accepts messages only from its own
  frames (`event.source`), and treats every field as untrusted data.
- **Controls, as kim's.** A mockup declares what answers may change: a CSS variable (`--accent`,
  used through `var(--accent)`), a variant attribute (`@nav` is `data-plan-nav`, styled with
  `[data-plan-nav="top"]`), or a text slot (`#headline` is `data-plan-text="headline"`). The server
  reads them from the HTML on each revision. A question binding an undeclared control is refused,
  and a revision that drops a bound control answers with `warnings`.

## Consequences
- Mockups need nothing new in the engine but tables and operations; the desktop renders them
  locally from what `artifact.get` returns.
- A mockup can't call home or exfiltrate through the network beyond the allowed CDNs' GET requests.
- The 1.9 MB cap is a limit on what the planner can draw (as in kim); larger assets belong in the
  repo, not the plan.
