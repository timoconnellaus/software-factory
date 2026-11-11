# Factory planning, done properly

**Goal:** make planning in the factory work like the interviewer (kim) does today. That means a live, adaptive interview with a model that stays with you, a living spec rewritten as answers arrive, chat, mockups and system designs. On top of that, the factory adds gates, decision domains and async answers.

## Where we are
- **Today's factory planning is one-shot.** The spec run writes JSON with its questions and ends. The Workflow waits for answers, then starts a *fresh* run (at most 2 rounds). There's no chat, no adaptive follow-ups, and no mockups or designs. Triage can't ask anything, and a build can't either.
- **kim already works well:** questions with a default and a recommendation, bulk accept, a plan rewritten every batch, chat (including per-question threads), mockups with option cards and live controls, system designs (D2/DBML/Mermaid/OpenAPI) with pinned comments, `.kim/` pull/keep write-back, and assigning to a guest. One Durable Object (`InterviewHub`) per interview, plus a Stop hook that keeps the agent's session attached.

## Constraints we already hold
- Operations first: questions and specs are factory operations in D1 (ADR 0003, 0042).
- Model credentials stay with the runner's owner (ADR 0023), so the planning model runs on a runner, not in the control plane.
- Gates in code; on timeout a question escalates to the backup owner and is never auto-accepted (ADR 0042).
- Questions are routed by decision domain (ADR 0029).

## Decisions
1. **A factory-native rewrite, with kim as the reference.** No code shared, no kim dependency. Planning lives in the factory's D1, operations, app (TanStack + shadcn) and runner channel. **Copied faithfully from kim** (semantics, not code): the question model (types, default + recommendation, acceptedDefault, revisions), hook delivery, free question management plus the living plan, the design formats with their checks and diagnostics, pinned comments that name the element, and the `.kim/` folder conventions. Live mockup controls are in scope, but their mechanics can be our own.
2. **The planning model is a resumable agent session on a runner.** It wakes per answer batch and holds no slot while waiting (the factory version of kim's Stop hook). **If the runner is offline, the session waits for that same runner.** A person can choose to continue on another runner instead; it's never automatic. **The agent acts through factory operations** over the runner channel: an MCP server the harness projects (`question.ask/update`, `spec.revise`, `artifact.add`, `chat.reply`, `planning.yield`), scoped to the work item and fenced by the lease. **An idle session keeps its slot while the runner has free slots.** It yields only when other work needs the slot, and only after about 5 minutes with nobody present and no new answers. So the scheduler needs a 'please yield' signal to idle planning sessions, and the Stop hook acts on it. An attached session waiting in the Stop hook spends no tokens. **Runner capacity comes in two pools:** heavy slots (build and verify, which run tests and use CPU) and light slots (planning and triage, which mostly read and wait). Each pool has its own limit, set by the runner's owner. An idle planning session holds a light slot only, and the yield rule applies within the light pool. Moving to another runner **starts a fresh session rebuilt from the factory's planning record** (spec, questions, answers, chat, artifacts). The record has to be complete enough to restart from.
   - **Live and async are one mechanism.** The agent manages a *living set* of questions. Whenever it's connected it adds, edits, reorders or deletes them one at a time, and revises the spec or mockups as it goes, each change as an operation the person sees immediately.
   - **Delivery works like kim's hooks.** `harness-claude` projects the same three hooks, pointed at the factory's runner channel:
     - **PostToolUse:** new answers and chat are injected after each tool call (throttled, about 15 s), so the agent sees them mid-task.
     - **UserPromptSubmit:** the same, when someone types to the session.
     - **Stop:** the idle agent waits on the channel and is woken by a pause (about 15 s idle), a chat message, or all questions being answered. After a while with nobody there, it yields its runner slot, and later answers resume the session.
   - "Live" vs "async" is only whether someone is there and how fast answers arrive.
3. **First-build scope (uses):** the owner's planning session, plus triage questions before a spec exists. Delegation to domain owners or guests, and quick decisions raised during build, come later.

4. **Features: everything kim has except phone notifications** (those come with spec 15): questions with a default + recommendation and bulk accept, the living spec, chat with per-question threads, adaptive follow-ups, HTML mockups with option cards and live controls, the design canvas with pinned comments, system designs (D2/DBML/Mermaid/OpenAPI), and `.kim/` pull and keep.
5. **Triage scores readiness** (ready / needs answers / not actionable). A small item that needs answers gets a quick planning round without a full spec, and the logged reason covers it too. An item that isn't actionable is **parked as 'needs info'**: triage's questions go to the requester, answering them re-runs triage, and a parked item takes no WIP slot.
6. **Milestones:**
   - **M1, the loop:** a session on a runner, the hooks, questions, the living spec, chat.
   - **M2, visuals:** mockups, option cards, the canvas, pinned comments, live controls.
   - **M3:** system designs and `.kim/` write-back.
   - **M4:** triage questions.
7. **Approved designs and mockups land in the repo's `.kim/`** (`designs/`, `mockups/`, `plans/`), committed to the work item's branch along with the spec at approval. Drafts and rejected options stay in the factory.
8. **All five ideas from other factories are in:**
   - **Provenance tags** on every spec statement (`[Q3]`, `[request]`, `[repo]`, `[assumption]`), shown at the spec gate.
   - **A coverage checklist** the planning agent keeps in the spec (scope, data, UX, edge cases, non-functional, terminology…), with gaps visible.
   - **A spec critic agent** that reviews the spec before the human gate.
   - **A drift check in verify:** the built code is compared to the approved spec, and the spec is updated to match what was built. This is its own slice with verify.
   - **A cheap readiness check before triage** that bounces items with no testable outcome. Assumed deterministic (no model), the way OpenHands' is, so it costs nothing.
9. **A planning session can end in a split.**
   - The approved parent plan proposes child work items, each with its own spec slice, and they're approved together at the spec gate.
   - Each child runs its own pipeline, and its triage starts from the parent's record.
   - The parent's ADRs and designs land once, with the parent's PR.
   - Splits go at most one level deep: children can't split again.
10. **The planning screen:**
    - **Layout A** (three panes: questions | spec / mockups / system / canvas | chat, with the gate bar at the bottom) as the Planning tab on the work item.
    - **A full-screen toggle** (F / Esc), because it's information-dense.
    - **Provenance chips are always visible**, and assumptions are highlighted.
    - **A split is approved with one button**, "Approve spec + N work items", and the children are listed in the spec.
11. **Planning starts on its own** once triage requires a spec. The agent reads the repo, drafts the spec, adds the first questions, then puts a card in the inbox. When the owner opens the tab, the session is live.

## Assumptions (overturn any)
- Agent-written mockup HTML is rendered on a **separate, sandboxed origin** (as kim's frames are), never on the app's origin with its session cookie.
- Artifacts (mockups, designs, revisions) are stored in the factory (D1 for metadata, R2 for content) and reached through operations.
- Design checks (D2 and DBML layout, Mermaid syntax) run on the runner, as kim's run on the CLI side, so the control plane needs no D2 engine.

## Next
- Write ADRs (amending 0028, 0042, 0013, 0015 and 0100) and specs: M1 the loop, M2 visuals, M3 system designs + `.kim/`, M4 triage questions, plus the verify drift check and the readiness pre-check.
