# Spec 41: The desktop shell and look

**Read first**: [ADR 0460](../adr/0460-the-desktop-shell-and-look.md), the approved design
[`docs/design/factory-ui/`](../design/factory-ui/README.md) (start with `Main.html`), [spec 40](40-desktop-app.md)
(the desktop app, whose M3 screens this restyles) and [ADR 0391](../adr/0391-the-client-door-desktop-devices-and-presence.md)
(gate decisions and presence, which this does not change).

## Goal
The desktop app looks and behaves like the approved design: a desktop window with a toolbar, an org
rail, a sidebar, a white content panel with a nested list per section, and a status bar. Slice 1
gets the shell and the look over the data and operations `main` has today. The sections that need
new backend come in later slices, once that backend lands.

## Slice 1: the shell and the look (this build)
**Scope**
- **The window.** The title bar is hidden (`hiddenInset`). The traffic lights sit in the toolbar.
  The toolbar is the window's drag region, and its controls are not. The chrome never scrolls: only
  the nested list and the page do.
- **The toolbar** (44px):
  - back and forward, through the router's history;
  - the sidebar toggle;
  - tabs: the open places, each a route. Clicking one goes there. You can open a new tab and close
    one. The active tab follows navigation;
  - search (⌘K): a command palette over the places in the app and the work items the app has
    loaded, matched by number and title;
  - **New item**, which opens New work.
- **The org rail** (52px): **All** at the top, then one square per org from `org.list`. An amber
  dot means something in that org waits on you. Choosing an org scopes the sidebar, the lists and
  the status bar's counts to it. **All** shows every org.
- **The sidebar** (196px):
  - the org's name;
  - Inbox, with the count of what waits on you;
  - Work;
  - Pinned: work items pinned on this Mac;
  - Settings, at the bottom.
- **The content panel**: white, radius 12, on the grey window. A section's nested list (212px) sits
  on its left, and the page fills the rest.
- **The status bar** (28px), from real data:
  - each runner, online or not;
  - heavy and light slots in use;
  - items running;
  - waiting on you;
  - the sync state: when the app last heard from the factory, or that it can't reach it.
- **Keyboard**:
  - ⌘K search; ⌘N or N New work;
  - ⌘1 Inbox, ⌘2 Work, ⌘, Settings;
  - ⌘[ and ⌘] back and forward;
  - ⌃⌘S the sidebar;
  - ⌘T a new tab, ⌘W close the tab;
  - ↑ and ↓ move through a nested list.
- **The look.** The README's tokens become design-system tokens in `packages/ui`, in light and dark.
  The desktop app uses them; `apps/app` keeps its look.
- **The screens, moved into the shell and restyled to their design counterparts:**

  | Screen | Design |
  | --- | --- |
  | Inbox: the list of what waits, then the selected merge, spec, question or notice | `InboxMerge.html`, `InboxQuestion.html` |
  | Work: in the factory, done, each project; board and list | `WorkActive.html`, `WorkActiveAll.html`, `WorkDone.html` |
  | Work item: the header, stage strip and tabs (Overview, Plan, Runs, Review, Activity) and the details column | `ItemOverview.html`, `ItemPlan.html`, `ItemRuns.html`, `ItemReview.html`, `ItemActivity.html` |
  | New work | `WorkNew.html` |
  | Setup | `Setup.html` |
  | Settings: Setup, This Mac | `SettingsProjects.html`, `SettingsDevices.html` |
- **Gate decisions** still go through `decide()` and Touch ID (ADR 0391). Only how the screen looks
  changes.

**Out of scope for slice 1.** These have no backend on `main`, so their nav entries are left out
rather than shown empty:
- Chat;
- Backlog and Ready;
- boards per project with workflow lanes;
- saved views;
- the Factory section;
- members, connections and notifications in Settings;
- the budget and "update ready" in the status bar.

**Acceptance criteria**
1. The window has no system title bar. The toolbar drags the window, and its buttons, tabs and
   search still click.
2. At 1440×900, neither the window nor the chrome scrolls. Only the nested list and the page do.
3. The toolbar, org rail, sidebar, panel and status bar match the design's sizes (44, 52, 196, 212,
   28px; panel radius 12).
4. The sidebar's Inbox count equals the gates and questions waiting on you (`inbox.list`), scoped to
   the chosen org.
5. The status bar shows each runner's state and the heavy and light slots from `inbox.list`, the
   running and waiting counts, and the sync state from the last successful read. It shows no budget
   and no update notice.
6. Every shortcut in the scope works, and none fires while you type in a field (except ⌘K, ⌘N and
   ⌘W).
7. ⌘K finds a loaded work item by number or title and opens it, and runs the place commands.
8. Light and dark follow the system. `apps/app` renders as it did before.
9. The Inbox selects the first item by default and `?item=` selects a given one. Merge and Send back
   still go through `decide()`.
10. No nav entry leads to an empty or placeholder screen, and no screen shows data that isn't from an
    operation or this Mac.
11. There are screenshots of every restyled screen, in light and dark at 1440×900, beside their
    design files, in `docs/screenshots/desktop-shell/`.
12. `pnpm lint`, `pnpm typecheck` and the desktop tests pass. New tests cover the shell's pure logic:
    tabs, shortcuts, org scoping, status bar wording, the nested list's selection and routing.

## Later slices
| Slice | What | Waits on |
| --- | --- | --- |
| 2 | Backlog and Ready, release, projects that aren't repositories, a board per project with the workflow's lanes and who decides each one, saved views, New item into the backlog (`WorkBacklog`, `WorkReady`, `WorkProject`, `WorkNew`, `ItemBacklog`) | Spec 50, the work model |
| 3 | The review with the checks the factory ran, each criterion proven or not, the test guard, After the merge, usage per stage (`ItemReview`, `InboxMerge`'s chips) | Spec 51, verify evidence |
| 4 | Chat: ask and tell, add to the backlog, release, draft a policy change (`Chat`, `ChatNew`) | A chat backend |
| 5 | The Factory section: Overview, Workflows, Agents, Autopilots, Checks and incidents, Runners, Policy | Spec 09's config, and runner and incident reads exposed to the desktop |
| 6 | Settings: members, connections, devices and notifications; the All orgs page; the budget and "update ready" in the status bar; sign-in restyled | Usage capture, spec 40 M4 (updates) |
| 7 | A live run in the work item (`ItemRunLive`): the transcript and steering from spec 31 | `run.live` and `run.steer` on the client door |
