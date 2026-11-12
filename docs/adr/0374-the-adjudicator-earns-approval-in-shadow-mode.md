# ADR 0374: The adjudicator earns gate approvals in shadow mode

Status: accepted, 2026-11-12 (interview; idea 6 in [`docs/research/ideas-from-crm-and-cloudflare-os.md`](../research/ideas-from-crm-and-cloudflare-os.md)).
Spec [09](../specs/09-factory-config-in-the-app.md) M4. Amends [ADR 0007](0007-human-gates-are-pending-actions.md)
and [ADR 0008](0008-autonomy-presets-and-floor.md).

## Context
Self-improvement (ADR 0373) reduces how often work goes wrong. It doesn't reduce how often a person
is asked. Most gate decisions on a mature project are approvals made without changes.

## Decision
1. **The adjudicator** is an agent (model role `review`) that, for each pending gate of a kind it is
   enabled for, records the decision it would make and its reason. It judges the diff and the
   evidence, not the agent's explanation.
2. **It starts in shadow mode.** Its verdicts are recorded next to the person's decisions, and the
   app shows its agreement rate per gate kind and project.
3. **It goes active per gate kind** once it has at least 20 decisions with at least 95% precision
   on approvals. A person switches it on; it is never automatic.
   - Active, it may **approve** a gate. It never rejects: a "no" still goes to the person.
   - It **never** decides merge, deploy or self-modify.
   - If its precision drops below the bar over the last 20 decisions, it falls back to shadow mode.
4. Its approvals are journaled with actor `self-improve` and its reason, and show in the digest.

## Consequences
- Spec gates and person `gate` steps are the gate kinds it can take. The merge gate is not
  (`ALWAYS_REVIEW`).
- It is a policy setting, so enabling it is a human change (ADR 0373).
