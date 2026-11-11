# Stage specs

Each stage is one buildable slice. Format (borrowed from Relationship OS): **Read first / Goal /
Scope / Out of scope / Acceptance criteria**. The acceptance criteria are the definition of done,
and the factory's own planning stage writes specs in this same format.

| # | Stage | Depends on |
| --- | --- | --- |
| [00](00-scaffold.md) | Scaffold (this repo's skeleton) | — |
| [01](01-operations-and-store.md) | Operations, invoke pipeline, work-item store, audit journal, outbox | 00 |
| [02](02-work-item-workflow.md) | CLI/chat intake, the work-item Workflow, triage, spec gate | 01 |
| [03](03-runner-contract-and-orca.md) | Runner contract, signed channel, runner host, `runner-orca`, `harness-claude`, scheduler | 01; the `spikes/` runner work |
| [04](04-verify-and-pr.md) | Verify, review packet, PR through the GitHub App gatekeeper, `factory/verify` check | 02, 03 |
| [10](10-r1-sign-in-and-org-switcher.md) | R1: sign-in and the org & account switcher | 01 |
| [11](11-r1-new-work.md) | R1: New work | 02, 10 |
| [12](12-r1-inbox.md) | R1: Inbox | 02, 10 |
| [13](13-r1-work-item-detail.md) | R1: Work item detail | 02, 10 |
| [14](14-r1-review-packet.md) | R1: Review packet | 04, 13 |

Stages 01–04 together are the **MVP backend slice**: CLI/chat intake → triage → implement (Claude
Code via `runner-orca`) → verify (review packet) → PR in one repo. Stages 10–14 are UI release
**R1** ([`docs/ui-plan.md`](../ui-plan.md)). The MVP's "simple web inbox" is stage 12.

Mockups for every R1 screen are in [`.kim/mockups/`](../../.kim/mockups/); the design system is in
[`.kim/design-system/`](../../.kim/design-system/).
