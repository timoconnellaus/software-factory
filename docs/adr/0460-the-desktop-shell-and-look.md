# ADR 0460: The desktop shell and look

Status: accepted, 2026-11-12. Spec [41](../specs/41-desktop-shell-and-look.md). Design:
[`docs/design/factory-ui/`](../design/factory-ui/README.md).

## Context
The owner approved a new design for the desktop app: a desktop window rather than a web page, with an
org rail, a sidebar, a content panel with a nested list per section, tabs, a command palette and a
status bar. The desktop's screens came from sf-app (spec 40 M3) and still had sf-app's shell: a
shadcn sidebar and a header with a breadcrumb.

The design also shows things `main` has no backend for yet: a backlog, projects that aren't
repositories, boards with workflow lanes, chat and the Factory pages. Other builds are adding that
backend (specs 50 and 51).

## Decision
1. **The window is the chrome.**
   - The window uses Electrobun's `hiddenInset` title bar. The view draws the toolbar under the
     traffic lights.
   - The toolbar carries Electrobun's drag-region class, and its controls carry the no-drag class.
   - The body never scrolls. The shell is a fixed grid, and only the nested list and the page
     scroll.
   - This is the only change on the Bun side: two window options.
2. **Sections are route layouts.**
   - Each section (Inbox, Work, Settings) is a layout route that renders its nested list and an
     outlet for the page. The list is part of the section, not a global component.
   - A list item is a link. Selection is the URL: the Inbox's `?item=`, a work item's `/work/$id`.
     So deep links, back and forward and tabs work without extra state.
3. **Tabs, pins and the chosen org are this Mac's view state, not factory state.**
   - They live in the view: memory, mirrored to `localStorage`. They never reach the factory.
   - A tab is a route path. A pin is a work item id. The org is an org id, or none for **All**.
   - If pins or saved views ever need to follow a person across devices, they become operations
     then.
4. **The chosen org scopes on the client.** The reads already return every org's items with their
   `orgId` or `projectId`, so the rail filters what is loaded and asks for nothing new. The amber dot
   comes from the same inbox read.
5. **The look is tokens.**
   - `packages/ui` gains the design's tokens: the window, panel, line and chip colours and the
     "needs you" ring, in light and dark.
   - A separate stylesheet, `@software-factory/ui/desktop.css`, maps shadcn's base tokens onto them.
     Only the desktop imports it, so `apps/app` is unchanged.
   - Dark mode follows the system, as the app already does. The design has no dark version, so dark
     uses the same structure on a neutral dark scale.
6. **A screen shows only real data.**
   - The status bar shows only what the inbox read and the session give: runners, slots, running,
     waiting, the sync state.
   - The budget and "update ready" wait for usage capture and spec 40 M4.
   - Sections with no backend aren't in the navigation. Spec 41 lists them as later slices.
7. **Focus mode is shell state.**
   - `focus` names the work item whose planning has the whole window. The shell reads it to swap
     the toolbar for the session bar and to hide the rail, sidebar and nested list.
   - It is never restored on launch, and leaving the item clears it.
8. **Screenshots come from a fixture door.**
   - The view takes its transport through `connect()` already. The screenshot harness
     (`apps/desktop/screenshots/`) builds the view with a bridge that answers operations from typed
     fixtures (`OpOutput<…>`), then drives Chrome over CDP at 1440×900 in light and dark.
   - The fixtures exist only in the harness. The app never ships them.

## Consequences
- New sections are added as layout routes with their own nested list, behind their backend.
- The desktop and sf-app look different. sf-app is shrinking to auth (ADR 0392), so that is
  accepted.
- The Bun side changes by two window options and nothing else.
