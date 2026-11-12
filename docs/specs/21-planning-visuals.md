# Spec 21: Planning M2, visuals

Read first:
- ADRs [0300](../adr/0300-planning-is-a-live-session-on-a-runner.md) and
  [0305](../adr/0305-planning-artifacts-and-the-kim-folder.md);
- [spec 20](20-planning-loop.md);
- the mockup [`planning-three-pane.html`](../../.kim/mockups/planning-three-pane.html) (the
  Mockups and Canvas tabs);
- kim's skill, in the "Workspace: plan, diagrams, mockups" section, as the reference for behaviour.

## Goal
The planning agent can draw what it's asking about, and the person can choose by looking. Option
cards show thumbnails, one mockup's controls can change live as you hover an option, and comments
pinned on an element go back to the agent.

## Scope
- **Artifacts**
  - `core_planning_artifacts`: kind, title, description, revision, and keep or drop, with content
    in R2.
  - Operations: `artifact.add`, `artifact.update`, `artifact.delete`, `artifact.show`.
  - Frame sizes as kim's: desktop 1280 × 800 unless the title or description says phone (390 ×
    844) or tablet (834 × 1112).
- **Sandboxed origin**
  - Mockups are served from a separate origin with a strict CSP and no cookies.
  - A `postMessage` protocol carries pinned comments, values and screenshots.
- **Questions linked to mockups**
  - `artifactId` brings the artifact on screen when the question is focused.
  - `optionArtifacts` render options as thumbnail cards.
- **Live controls**
  - The mockup declares CSS variables, variant attributes and text slots.
  - `optionValues` maps options to values. A number question binds a variable with a unit and a
    min and max, and shows a slider. A text question binds a slot.
  - Hovering an option previews it. A saved answer stays applied, and its `applied` values reach
    the agent.
- **Canvas**: one frame per design, in rows by question, with pan, zoom, drag and open full size at
  the three widths.
- **Pinned comments**
  - A pin names the element (its `data-name`, or a short description) and its position, and
    reaches the agent as a chat message with a `pin`.
- **Screenshots**: the agent renders frames on its runner (headless Chrome) to check its work.
- **App**: Mockups and Canvas tabs in the workspace pane.

## Out of scope
System designs and `.kim/` write-back (spec 22). Phone notifications (spec 15).

## Acceptance criteria
1. The agent adds an HTML mockup, and it renders in the Mockups tab and on the canvas at its frame
   size. A script in it can't read `sf-app`'s cookies or DOM, and a test asserts the frame's origin
   differs from the app's.
2. A single-choice question with `optionArtifacts` shows thumbnail cards. Choosing one answers the
   question, and the answer reaches the agent as in spec 20.
3. Hovering an option of a bound question changes the mockup live. The saved answer's `applied`
   values arrive with the answer. An undeclared control is refused with a clear error.
4. A comment pinned on an element reaches the agent naming that element's `data-name`. The agent's
   reply appears in the chat linked to the pin.
5. The canvas lays frames out in rows by question, and each frame opens full size at 1280, 834 and
   390.
6. An artifact revision keeps the history. The app shows the latest revision and whether it's kept
   or interview-only.

## As built
- Built against the designs `docs/design/factory-ui/PlanFocusMockup.html` and
  `docs/design/mobile/PlanMockups.html`, in the desktop app's Planning tab. sf-app's Planning tab
  is unchanged.
- **Content in D1, not R2** (ADR 0472). Migration 0243 adds `core_planning_artifacts` and
  `core_planning_artifact_revisions` (one row per revision, up to 1.9 MB, with the controls it
  declares). The attachments bucket's sweep deletes keys without an attachment row, and a mockup
  is small text read with its revision, so D1 keeps the history in one place.
- **Opaque origin, not a separate one** (ADR 0472). The frame renders from `srcdoc` in
  `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so its origin is opaque: no
  cookies, storage, DOM or door. `frameDocument` (desktop `lib/mockup-frame.ts`) puts a CSP (no
  `connect-src`, no form posts; CDNs for fonts and libraries) and the frame script before anything
  of the planner's, whatever its HTML; the view accepts messages only from the frame's own window.
  `test/mockup-frame.test.ts` covers criterion 1.
- Operations: `artifact.add`, `artifact.update` (a new revision; `warnings` when it drops a control
  a question binds), `artifact.delete`, `artifact.show`, `artifact.read` (planner) and
  `artifact.get` (a person, by revision). `planning.get` returns the artifacts' latest revision
  metadata and controls, and `session.shownArtifactId`.
- Questions: `artifactId`, `optionArtifacts`, `optionValues`, `control`, `unit`, `min`, `max`,
  `step`, checked by `checkQuestionVisuals` against the controls the artifact declares (`--var`,
  `@attr` as `data-plan-<name>`, `#slot` as `data-plan-text`). An undeclared control is refused
  with a message listing the declared ones. `answer.submitted` news carries `applied`
  (`appliedValues`).
- Pins: `chat.send { pin }` (element, selector, position and fraction, frame width), checked to be
  this item's artifact. News carries the pin with the artifact's title. A planner reply to a pinned
  comment (`chat.reply { replyTo }`) shows "re <element>" in the chat.
- App: Plan / Mockups / Canvas tabs, and Comment (C) for comment mode. Mockups shows option cards
  (Choose X, Open full size, the card's pins, Ask for another option) or the shown mockup; hovering
  an option or moving a bound slider previews it live. The canvas lays frames in rows by question,
  with zoom (buttons, ctrl-wheel), drag (positions kept per item on the device) and open full size
  at 1280, 834 and 390.
- **Deferred:** the agent rendering its own frames on its runner (headless Chrome). It needs a
  runner capability and is left for a later slice; the planner reads its HTML back with
  `artifact.read`.
- Screenshots: `docs/screenshots/planning/visuals-*.png` (before: `visuals-before.png`).
