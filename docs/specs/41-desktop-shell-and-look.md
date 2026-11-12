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
  - ↑ and ↓ move through a nested list;
  - F focus mode on the Plan tab, Esc to leave it.
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
  | Plan, docked in the work item and in focus mode | `ItemPlan.html`, `PlanFocus.html` |
- **Focus mode.** F on the Plan tab gives planning the whole window, and Esc gives it back. The org
  rail, the sidebar and the nested list are hidden, and a session bar replaces the toolbar: Exit
  focus, the item, the planner's state and Open terminal. The status bar stays. Leaving the item
  leaves focus.
- **Open terminal.** Every session view (the work item header and the Plan tab, docked or in focus)
  has one Open terminal place. In this slice it shows what `main` has: the live run's takeover hint,
  the tmux attach command on its runner (ADR 0380), with Copy. With no live run that has a hint, the
  button isn't shown.
  *Amended 2026-11-12 (spec 42, ADR 0530):* slice 9 is built. Open terminal shows for any live run
  and opens the session's web terminal in place; the tmux command is behind "Attach from a terminal
  instead".
- **The plan is a document.** The Plan pane is a plain document in its pane, not a page on a canvas.
- The Plan tab is restyled over what the planning operations support today: questions, the plan,
  chat, accept defaults, request changes, approve. New ways to steer the planner belong to the
  planning build.
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
   search still click. Double-clicking the toolbar's empty space, or the session bar's in focus
   mode, does what System Settings says for a title bar: zoom (the default), minimise or nothing.
   A double-click on a button, tab, the search field or anything marked no-drag does not. The
   traffic lights sit centred in the 44px toolbar. All of this is checked in the real window
   (`screencapture` of the dev build), not only in the harness.
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
11. F on the Plan tab hides the rail, sidebar and nested list and shows the session bar. Esc
    restores them. Open terminal shows only when a live run has a takeover hint.
12. There are screenshots of every restyled screen, in light and dark at 1440×900, beside their
    design files, in `docs/screenshots/desktop-shell/`.
13. `pnpm lint`, `pnpm typecheck` and the desktop tests pass. New tests cover the shell's pure logic:
    tabs, shortcuts, org scoping, status bar wording, the nested list's selection and routing.
14. A header's actions are one button family from `packages/ui` (`size="md"` / `"icon-md"`): 28px
    high, the same radius, ring and fill in light and dark, icon and label centred, 8px apart. A
    destructive action differs only by its red text. This holds for a button inside a Radix
    trigger (`asChild`) too.
15. A planning question shows its options with the recommended one selected and badged, the
    reason beside it, and "Accept recommended" answers it in one click. Answered questions are
    compact rows with a tick and "default" or "changed by you".

## Later slices
| Slice | What | Waits on |
| --- | --- | --- |
| 2 | Backlog and Ready, release, projects that aren't repositories, a board per project with the workflow's lanes and who decides each one, saved views, New item into the backlog (`WorkBacklog`, `WorkReady`, `WorkProject`, `WorkNew`, `ItemBacklog`) | Spec 50, the work model |
| 3 | The review with the checks the factory ran, each criterion proven or not, the test guard, After the merge, usage per stage (`ItemReview`, `InboxMerge`'s chips) | Spec 51, verify evidence |
| 4 | Chat: ask and tell, add to the backlog, release, draft a policy change (`Chat`, `ChatNew`) | A chat backend |
| 5 | The Factory section: Overview, Workflows, Agents, Autopilots, Checks and incidents, Runners, Policy | Spec 09's config, and runner and incident reads exposed to the desktop |
| 6 | Settings: members, connections, devices and notifications; the All orgs page; the budget and "update ready" in the status bar; sign-in restyled | Usage capture, spec 40 M4 (updates) |
| 7 | The item side panel (`WorkActivePanel`, the README's "The item side panel"): a running item opens in a panel over the board, expandable to full size, instead of a separate live-run page. Cards and list rows open items through one helper (`openItem` in `lib/places.ts`), so this slice changes that one place | Nothing new on the backend; the design on `factory-ui-design` (#61) |
| 8 | A live run in the work item (`ItemRunLive`), in the side panel: the transcript and steering from spec 31 | `run.live` and `run.steer` on the client door |
| 9 | Open terminal opens the session's web terminal in the app, not just the tmux command (built: spec 42) | The web terminal (spec 35, #66) reaching the client door: today it runs through sf-app's own server socket (`run.terminal.attach`), which the desktop can't open |
| 10 | Planning as designed in `ItemPlan`, `PlanFocus`, `PlanFocusMockup`: edit a plan line directly, chat after the current step or as an interrupt, let the planner finish alone, mockups with pinned comments and option cards, stop and pause, Mockups, System and Canvas tabs | The planning build |

## As built (slice 1)
- **Screenshots** are in [`docs/screenshots/desktop-shell/`](../screenshots/desktop-shell/), each
  screen in light and dark, and the design files in `design/`. They come from the harness in
  `apps/desktop/screenshots/` (`node apps/desktop/screenshots/shoot.mjs --design`), which serves the
  real view over a fixture door (ADR 0460).
- **Work board lanes** are the factory's stages (Intake to Merge). The design's lanes (Queued, Plan,
  Build, Verify, Review, Merge, with who decides each) are the project's workflow, which comes with
  spec 50. Work has a **Stopped** view when anything failed or was cancelled. The design has none,
  but without it those items would show nowhere.
- **Work counts** in the nested list cover each org's 100 most recent items, the most
  `workItem.list` returns in one read.
- **Setup** sits under Settings with the nested list showing. The design shows it without the list.
- **Review**: the design's Checks table has a Where and a Time column, and Proven / Not proven per
  criterion, from checks the factory runs itself (spec 51 PR B, not on `main`). On `main` the
  packet's checks and criteria are what the verify run reported (`verifyResultSchema`): so the
  table's column is "Reported by" ("Verify run · <its detail>", or GitHub for CI), and each
  criterion is Met or Not met with the run's evidence. The verdict's "Checks n of m"
  counts CI on the head SHA when the packet carries CI, as before. Send back takes its note in the
  decision panel instead of a dialog; it is the same `review.sendBack` through `decide()`.
- **Inbox**: Running and "shipped this week" left the Inbox page. The status bar shows what's
  running. The design's "Runner updated itself" notice has no event on `main`, so it isn't there.
- **New work**: the design's "What happens next" choices (backlog, triage, plan, release) need spec
  50. Here, Send to the factory is `workItem.create` as before, with the optional title it accepts.
- **`/work/<id>/review`** redirects to the Review tab, so old links still land.
- **Planning questions** show each open question's options inline, the recommended one (the
  question's default values, else its recommendation) selected and badged, with the reason under
  them. The primary button reads "Accept recommended" while the form holds it, else "Answer"; both
  are `question.answer`. The design's Skip has no operation on `main`, so it isn't there.
- **The real window**: a dev build started with `SF_VIEW_URL` (a local URL; canary and stable
  ignore it) loads the harness's fixture view, so the title bar, traffic lights, drag region and
  zoom can be shot with `screencapture` without an account. Shots are in
  `docs/screenshots/desktop-shell/window/`. The traffic-light offset is `{ x: 5, y: 6 }`:
  Electrobun adds its own inset, and `{ 14, 16 }` put the lights 10px low and 9px right.
- **Double-click on the title bar**: the view reports a double-click on the drag region's empty
  space (`lib/title-bar.ts`), and the main process reads `AppleActionOnDoubleClick` and zooms,
  minimises or does nothing (`bun/title-bar.ts`). Electrobun's preload only handles the drag.
- **Buttons in a Radix trigger**: the desktop look matched buttons by `data-slot="button"`, which a
  trigger with `asChild` renames, so Open terminal fell back to shadcn's taller, filled outline.
  Buttons now carry `data-button`, and the look keys on that.

## As built (slice 2, part 1: Backlog and Ready)
*Amended 2026-11-12.* Built on spec 50's operations (`workItem.board`, `create`, `update`, `move`,
`release`, `link`, `unlink`, `cancel`). Screenshots, light and dark at the default window
(1200×800) and a narrow one (960×720, `-narrow`), are in
[`docs/screenshots/desktop-work/`](../screenshots/desktop-work/), the designs in `design/`
(`node apps/desktop/screenshots/shoot.mjs --out desktop-work --size 1200x800 …`).
- **The Work list** has Backlog, Planning (only while something is shaping), Ready, In the
  factory, Done and Stopped, then the projects. Its counts are `workItem.board`'s per project and
  state across each org, so they are no longer capped at the 100 most recent items. A project's
  count is its open work (everything not done or stopped). Queued work counts as in the factory.
- **The project switcher** is a project picker on Backlog, Ready and Planning (`?project=`). A
  project's row opens **its page** (`WorkProject`): counts by state, what is in the factory and who
  it waits on, its workflow (from `config.get`), repositories and approvers, and Board. The design's
  budget, "Brings in work", "Context for agents" and Edit project have no operation: left out.
- **Backlog**: quick add (one item per line, straight to the backlog of the chosen project), the
  list in pull order (priority, then rank), and a selection's actions: Mark ready, Set priority,
  Release, Cancel. The design's Run triage, Plan, Move to project and Import from GitHub issues,
  and its Readiness and Source filters, need server work (a triage pass before release, moving an
  item between projects, issue import) and are left out. Delete is **Cancel**: the item stops and
  shows under Stopped, nothing is deleted.
- **Ready**: Release per row and **Release in priority order** (every item nothing stops). An item
  that waits for another is released all the same (outline button) and waits in Queued. Why an item
  can't be released shows in place of its button (no repository, invalid config), mirroring core's
  `releaseRefusal`; the server's refusal is shown if it still refuses. The design's "Review is full"
  banner is `inbox.list`'s `wipHolds`. The Spec column needs a shaping read per item: left out.
- **Priorities** are written P0–P3, the stored 0 urgent … 3 low, so normal is P2 (the design's
  default). The design's P4 doesn't exist.
- **An item before release** (`ItemBacklog`): the strip shows Backlog, Ready, Queued (and Planning
  while shaping) then the workflow's stages; tabs are Overview, Plan and Activity. Next step: Mark
  ready and Release (backlog), Release and Back to the backlog (ready), Take it back to ready
  (queued). Details show priority, size, repository, what it waits for and what waits on it, with
  **Edit** (title, description, priority, size, repository, waits-for links; only the priority once
  shaped). The design's triage notes and draft acceptance criteria need server work
  (`workItem.get` doesn't return the item's draft criteria; there is no triage before release).
  Plan this item (`workItem.shape`) is the next slice's, as spec 50 part C says.
- **New work** (`WorkNew`) goes to the backlog by default; "Release it straight away" is create and
  release, with the routing preview. Priority and one "waits for" item can be set. The workflow is
  shown, set by the project. The design's Triage it now and Plan it now need the same server work as
  above.
- **The title bar**: every toolbar control (back, forward, sidebar, tabs, new tab, search, New
  item) is 28px with the 7px radius. Double-clicking its empty space zooms and unzooms the window;
  checked in the dev build's real window (`window/titlebar-before.png`, `titlebar-zoomed.png`).
