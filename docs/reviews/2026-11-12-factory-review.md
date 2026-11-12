# Factory review, 2026-11-12: the factory against the open-source field

The control plane is ahead of most open-source factories, but the production line it controls is thinner than theirs and is barely running. Three of 49 PRs came from the factory (#23, #38, and #43 still open). The rest were hand sessions, most merged with `factory/verify` red.

## How the other factories work

Across the ~70 repos, the ones with real usage converge on the same mechanisms:

- **Code owns the sequence and the verdict.** Agents run as bounded steps that return typed results. Projects that left sequencing to prompts measured the drift: great_cto found 11% of dispatches left the graph, and Cole Medin's LLM dispatcher hallucinated runs.
- **The factory re-runs verification itself.** The agent's report is never the decision. Exit codes are stored against the exact commit or tree hash, and they lapse when the code moves (HAR, ESF, Machinist, Fusion).
- **The judge is protected from the builder.** Test weakening, added suppressions and edits to gate files are detected in code (OpenFactory, SWE-AF, disler, ESF).
- **Review is independent and bounded.** A fresh-context reviewer, often from another vendor, reviews before the merge. Repair loops stop at two or three rounds, then go to a person.
- **Build is a loop.** Work is split into tasks, each checked as it lands. A failed check re-prompts the same live session with the exact failure.
- **Humans hold two gates:** plan approval and merge. Auto-merge exists only as a narrow class written in code.
- **Mostly absent everywhere:** scoped credentials, hard budget caps, holdout tests, and anything after merge.

## Where the factory stands

| Area | The factory today | Against the field |
|---|---|---|
| Credentials and governance | Per-job repo tokens, fenced leases, SHA-bound `factory/verify`, browser-only gates | Top tier; most run on ambient logins |
| Planning | Live session, questions with defaults, provenance | Richer than almost all |
| Merge queue, attached PRs | Built | Rare |
| Build | One agent run, cold retry with a note, limit 2 | Behind: no task split, no in-session repair |
| Verify | One reviewer run self-reports checks and criteria; CI on the head | Behind: evidence is a claim, nothing guards the tests |
| Behavioural evidence | None; `browser` capability is dropped with Orca | Behind the better ones |
| Intake | New work, CLI, attach a PR | Behind: no issues, alerts or schedules |
| After merge | Nothing; done means merged | Same as most; a few do deploy and rollback |
| Cost and usage | Not captured on main | Behind the ones that report cost per run |
| Learning | Incident loop built; `evals/regressions/` is empty | Unproven; the nine bootstrap incidents were fixed by hand |
| Harness | Claude Code's TUI typed into a terminal | Most run headless with structured output |

## What I'd change

**Change how it works**

1. **Run the project's checks in code.** The runner host should run the declared check commands on the head and record exit codes against the SHA. Failures should go back into the same build session. A criterion with no executed check behind it should show as "not proven" in the review packet.
2. **Guard the tests.** Detect deleted or skipped tests and new suppressions in the diff, and force those to a person.
3. **Make headless the default session mode.** Typing into a TUI caused incidents #6 and #8 (the launcher overriding the permission mode, and prompts cut to their tail), and the tmux replacement keeps the trust-dialog regex. Stream-json gives completion, usage and resume for free; a person can still take over by resuming the session in tmux.
4. **Reconsider one replayed Workflow per item.** The file has five version branches, and config M2 adds a sixth. Incident #7 (an item waiting for CI that never came) is the lost-event failure that pushed Optio to a reconciler: a pure function from a state snapshot to the next action, run on a tick. That shape also suits workflows-as-config better. I have not measured the pain beyond reading the file, so treat this as a judgement call.

**Add**

5. **Tasks inside build, and admission by size.** Genie's data: merged-within-8-hours fell from 100% for the smallest plans to 30% for the largest. Spec 24 (splits) covers part of this.
6. **A behavioural check in verify.** Start the app and drive it in a browser on the runner. This replaces what Orca's browser gave.
7. **A deploy step.** `DEPLOYED_SHA` already exists, so read it back, run a health check and open an incident on failure. Migration 0120 broke deploys and the factory had no way to see it.
8. **Issue intake with trusted-author filtering,** plus scheduled work such as a weekly regression run.
9. **Usage per run, a per-item budget, and a cap on items awaiting your review.**
10. **Risk-proportional checking.** Build the spec critic (spec 23) and add reviewers only on risky paths. If you build holdouts, cap them: Cole Medin's grew from 9 to 44 in ten days and stalled merging.

**Defer**

11. **The improver and adjudicator (config M3, M4).** Promotion on 3–20 items is noise at current volume. ESF removed its self-improvement engine for lack of evidence, and shipmill retired its prompt evals. If M3 lands anyway, gate instruction changes, since it can currently rewrite the build agent's prompt unapproved.
12. **Desktop M3–M5.** The shell and runner supervision make sense as Orca's replacement. Shrinking the website removes the phone path for gates, which was one of your original pains.

## The three sessions

- **No-orca** should land first, because main keeps deepening the Orca dependency (self-update now imports `runner-orca`). It is 34 commits behind, conflicts, and has no planning-session support. That last part is a redesign, since it ends a session on `Stop`.
- **Desktop M1** has two defects: `presence.redeem` does not check key storage, so a software-key device can decide gates without Touch ID, and the merge proof is not bound to a head SHA. The bundled runner also conflicts with runner self-update.
- **Config M1 and M2** are sound. The loosening check matches the best in the field.
- **Number collisions:** desktop and config both claim ADRs 0370–0374 and migration 0140. No-orca and desktop both use spec 30. No-orca's ADR 0350 clashes with the one on main.

## Order

1. Unblock dogfooding: land #47 (PR #47's description says verify fails every PR because the tests can't run in its sandbox), renumber, land no-orca, and attach every PR from here on. Track the factory's share of merged PRs as the headline number.
2. Items 1–3.
3. Items 5–7.
4. Intake and budgets.
5. Config M2 and the desktop shell.

## Caveats

- The research agents read READMEs and design docs and ran nothing. Star counts and throughput figures are the projects' own.
- I read the factory's docs and the Workflow but did not run it.
- `alimeramiovens/claude-software-factory` in the list looks like a malware lure. Nothing was downloaded from it.
- The Work panel list was not kept: `work` needs `ORCA_WORKSPACE_ID`, which this session does not have.

## Since this was written
By the end of 2026-11-12 `runner-local` (no Orca), config M1–M4 (including run usage), the desktop app through M3 and watch-and-steer had merged. Headless sessions are the hosts plan's stream-json piece. Items 1 and 2 are spec 51; the backlog and projects model is spec 50.
