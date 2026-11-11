# Spec 21: Planning M2, visuals

Read first:
- ADRs [0280](../adr/0280-planning-is-a-live-session-on-a-runner.md) and
  [0285](../adr/0285-planning-artifacts-and-the-kim-folder.md);
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
