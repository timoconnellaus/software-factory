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

## Amendment, 2026-11-12 (review of #90)
One sandboxed frame wasn't enough: a mockup could navigate its own frame (a meta refresh, `location =`)
to a page with no CSP, and `img-src https:` let it send anything out as an image URL. Now:
- **Two levels.** The app draws an outer frame (`sandbox="allow-scripts"`, opaque origin) holding the
  app's own document, whose CSP has `frame-src 'none'`; the mockup is that document's inner frame
  (`srcdoc`, `sandbox="allow-scripts"`). A srcdoc document inherits the outer's CSP, and the mockup
  gets it again first in its head. The browser refuses any navigation of the inner frame. The
  outer's watcher requires every document the inner frame holds to check in with a nonce the mockup
  can't read (the frame script keeps it in a closure and removes itself). Anything else, such as a
  refused navigation's error page, is replaced with the mockup. After two tries it is replaced with a
  static notice, so a mockup can't loop.
- **The CSP** allows only the CDNs for scripts, styles, fonts and images (`img-src data: blob:` and
  the CDNs), and nothing for connect, frame, child, worker, media, object, manifest, base or form.
- **WebRTC** isn't governed by CSP, sandbox or Permissions Policy in Chromium or WebKit (`webrtc
  'block'` isn't implemented; a STUN request reached the trap in both). The frame script removes
  the WebRTC constructors before the mockup runs, and child frames' windows aren't handed out. The
  real-engine test proves the direct use is blocked: without the block it leaks. In both engines a
  fresh child frame gives no working peer connection either. The tests keep the direct case, a fresh
  iframe and `frames[0]` in CI for both engines. **This is a script-level block, not an engine
  guarantee.** The engine-level fix is a follow-up (spec 21, "Follow-ups"): turn WebRTC off in the
  desktop app's WKWebView. In ordinary browsers (the website) there is no such switch. The residual
  there, if a mockup got past the script block, is a STUN request to a server of its choosing. That
  reveals that a mockup ran and the viewer's IP address, plus whatever the mockup encodes in the
  request (the mockup's own content and what was typed into it, never the app's data).
- **Not enabled in the desktop app yet:** the Electrobun bridge probe
  (`docs/reviews/2026-11-12-mockup-bridge-probe.md`) must run first and find nothing reachable.
- The app talks only to the inner frame's window. A `pin` counts only in comment mode, and never
  clears what the person typed.
- Storage: an artifact keeps its last 10 revisions (older ones pruned as new ones land), and an item
  holds at most 50 artifacts and 20 MB. Past that the operation refuses with a plain message.
- `apps/desktop/test-browser/mockup-isolation.test.ts` loads hostile mockups in Chromium and WebKit
  (Playwright, in CI). They try meta refresh, `location`, `window.open`, forms, links to `_top`, images,
  fetch/XHR/beacon/WebSocket/EventSource, CSS url/@import/fonts, prefetch/preload, WebRTC (directly,
  via a fresh frame, via `frames[0]`), a second looser CSP, `<base href>`, top and parent navigation,
  nested frames, workers and media. Each test asserts a trap server (HTTP and UDP) saw nothing, the
  app page didn't move, and the frame holds the mockup (or the stopped notice).

