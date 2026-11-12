# Factory UI design

The approved design for the desktop app (`apps/desktop`), as one static HTML file per screen. Open a
file in a browser to see it; `Main.html` is the app map and links to every screen. These are
pictures, not code to copy: build the screens with `packages/ui` and the desktop app's own
components.

Almost all the data is illustrative. Work items #1, #4 and #8, their pull requests and the three
checks that came from incidents are real.

## The model
- An org has projects. A project runs on one workflow. A workflow uses repositories when a stage
  needs code. A project is not a repository.
- One object runs through the app, the **work item**: org → project → work item → run.
- A work item goes Backlog → Planning (optional) → Ready → (release) Queued → the workflow's stages
  → Done. Planning before release is proposed and awaits the owner (spec 50, part C). A work item
  always uses its project's workflow.

## Sections
| Section | What it is for |
| --- | --- |
| Inbox | Decisions that wait on you, and nothing else: merge gates, plan approvals, questions |
| Chat | Ask and tell. A chat can add to the backlog, release work and draft a policy change. It cannot approve, merge or loosen policy |
| Work | Backlog, Ready, In the factory, Done, and one board per project |
| Factory | Overview, Workflows, Agents, Autopilots, Checks and incidents, Runners, Policy |
| Settings | Repositories, Members, Connections, Devices and notifications |

## Layout
A desktop window, not a web page.
- **Toolbar**, 44px: window controls, back and forward, sidebar toggle, tabs, search (⌘K), New item.
- **Org rail**, 52px: one 32px square per org, an "All" view at the top, an amber dot when an org
  has something waiting on you.
- **Sidebar**, 196px: Inbox (with a count), Chat, Work, Factory, Pinned, and Settings at the bottom.
- **Content panel**: white, rounded (12px), on the grey window. Inside it, a **nested list** (212px)
  for the section, then the page.
- **Status bar**, 28px: runner online, heavy and light slots, running, waiting on you, budget, sync
  state, update ready.

## Look
| Token | Value |
| --- | --- |
| Window background, board lanes | `#f1f1ef` |
| Panel | `#ffffff`, radius 12, `box-shadow: 0 0 0 1px #e3e3e0, 0 1px 2px rgba(0,0,0,.04)` |
| Ink / muted / line | `#1c1c1e` / `#6e6e73` / `#e3e3e0` |
| Type | Geist 13px; Geist Mono for ids, SHAs and counts |
| Chips | amber `#fdecc8` on `#7a4a00`, blue `#e3edfd` on `#1d4ed8`, green `#e4f4e8` on `#17603a` |
| A card that needs you | `box-shadow: 0 0 0 1.5px #f0b541` |
| Board lanes | 212px wide; an empty lane collapses to a 40px strip with a vertical label |

Map these onto the design system's tokens rather than hard-coding them, and support dark mode the
way the app already does.

## Screens
| File | Screen | Size |
| --- | --- | --- |
| [Main.html](Main.html) | App map | 1440 × 1500 |
| [SignIn.html](SignIn.html) | Sign in | 1440 × 900 |
| [Setup.html](Setup.html) | Setup | 1440 × 900 |
| [AllOrgs.html](AllOrgs.html) | All orgs | 1440 × 900 |
| [InboxMerge.html](InboxMerge.html) | Inbox: a merge | 1440 × 980 |
| [InboxQuestion.html](InboxQuestion.html) | Inbox: a question | 1440 × 980 |
| [PhoneReview.html](PhoneReview.html) | Merge gate on a phone | 390 × 844 |
| [Chat.html](Chat.html) | Chat | 1440 × 980 |
| [ChatNew.html](ChatNew.html) | Chat: new | 1440 × 900 |
| [WorkBacklog.html](WorkBacklog.html) | Work: backlog | 1440 × 1040 |
| [WorkReady.html](WorkReady.html) | Work: ready | 1440 × 980 |
| [WorkActiveAll.html](WorkActiveAll.html) | Work: in the factory | 1440 × 1060 |
| [WorkActive.html](WorkActive.html) | Work: software | 1440 × 1060 |
| [WorkActiveMarketing.html](WorkActiveMarketing.html) | Work: marketing | 1440 × 1060 |
| [WorkDone.html](WorkDone.html) | Work: done | 1440 × 900 |
| [WorkNew.html](WorkNew.html) | Work: new item | 1440 × 980 |
| [WorkProject.html](WorkProject.html) | Work: a project | 1440 × 980 |
| [ItemBacklog.html](ItemBacklog.html) | Work item: in the backlog | 1440 × 980 |
| [ItemOverview.html](ItemOverview.html) | Work item: overview | 1440 × 1000 |
| [ItemPlan.html](ItemPlan.html) | Work item: plan, docked (questions and the plan; chat collapsed; Focus opens the full window) | 1440 × 900 |
| [PlanFocus.html](PlanFocus.html) | Planning: focus mode (the whole window: questions, plan, chat, the gate bar) | 1440 × 900 |
| [PlanFocusMockup.html](PlanFocusMockup.html) | Planning: comparing mockups for a question, with a pinned comment | 1440 × 900 |
| [ItemRuns.html](ItemRuns.html) | Work item: runs | 1440 × 1040 |
| [ItemRunLive.html](ItemRunLive.html) | Work item: a live run | 1440 × 1040 |
| [ItemReview.html](ItemReview.html) | Work item: review | 1440 × 1400 |
| [ItemActivity.html](ItemActivity.html) | Work item: activity | 1440 × 1000 |
| [FactoryOverview.html](FactoryOverview.html) | Factory: overview | 1440 × 980 |
| [FactoryWorkflow.html](FactoryWorkflow.html) | Factory: workflows | 1440 × 1040 |
| [FactoryAgents.html](FactoryAgents.html) | Factory: agents | 1440 × 1040 |
| [FactoryAutopilots.html](FactoryAutopilots.html) | Factory: autopilots | 1440 × 900 |
| [FactoryIncidents.html](FactoryIncidents.html) | Factory: checks and incidents | 1440 × 1040 |
| [FactoryRunners.html](FactoryRunners.html) | Factory: runners | 1440 × 900 |
| [FactoryPolicy.html](FactoryPolicy.html) | Factory: policy | 1440 × 1040 |
| [SettingsProjects.html](SettingsProjects.html) | Settings: repositories | 1440 × 900 |
| [SettingsMembers.html](SettingsMembers.html) | Settings: members | 1440 × 900 |
| [SettingsConnections.html](SettingsConnections.html) | Settings: connections | 1440 × 900 |
| [SettingsDevices.html](SettingsDevices.html) | Settings: devices and notifications | 1440 × 900 |

The phone screen (`PhoneReview.html`) predates the approved look and has not been restyled.

## Planning
Planning follows kim: questions with a recommended answer already picked, a living plan, chat, and
mockups. The three planning screens show the ways a person steers the planner:
- answer a question, accept the recommended ones in bulk, or let the planner finish alone;
- edit a line of the plan directly (the planner keeps the wording and updates the answers to match);
- chat, delivered after the planner's current step, or as an interrupt;
- pin a comment to a mockup; choose between option cards; ask for another option;
- stop or pause the planner, and open its terminal.

Docked, the Plan tab shows questions and the plan with chat collapsed. **Focus** (F, Esc to leave)
gives planning the whole window: the org rail, sidebar and nested list go, the toolbar becomes the
session bar, and the status bar stays.
