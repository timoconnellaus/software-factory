# ADR 0282: Specs carry provenance and coverage, and a critic reviews them before the gate

Status: accepted, 2026-11-11 (planning interview; prior art: AWS AI-DLC, GitHub Spec Kit `/clarify`, Jules' planning critic).

## Context
An approver at the spec gate cannot see which statements were decided by a person, which were read
from the repo, and which the agent guessed. They also cannot see what the spec never considered.
Research on underspecified tasks (Ambig-SWE, "Ask or Assume?") shows that agents rarely ask unless
something makes them, and that the costly failures are gaps nobody noticed.

## Decision
- **Provenance:** every statement in the living spec carries a source tag:
  - `[Qn]`: a question's answer;
  - `[request]`: the work item's text;
  - `[repo]`: read from the code or docs;
  - `[parent]`: the parent work item's record;
  - `[assumption]`: guessed.

  The tags are always visible in the app as small chips, and assumptions are highlighted. They stay
  in the committed spec. An assumption never becomes fact: the approver accepts it as an
  assumption, or overturns it into a question.
- **Coverage:** the planning agent keeps a coverage checklist in the spec, marking each category
  clear, partial (with the question that covers it) or not applicable:
  - scope;
  - data & permissions;
  - UX;
  - edge cases;
  - non-functional;
  - terminology;
  - plus project categories from `.factory/`.

  A spec with a category still marked partial can be approved, but the gate shows it.
- **Critic:** before the spec gate opens, a separate run (model role `review`, light pool) reads the
  spec and the repo and leaves notes: untestable criteria, contradictions, missing fixtures, and
  gaps the coverage list skipped. Its notes are shown at the gate and passed to the planning agent,
  which may answer or revise. The critic cannot open, skip or decide the gate (ADR 0005).

## Consequences
- Amends [ADR 0028](0028-planning-built-in.md). The spec format (Goal / Scope / Out of scope /
  Acceptance criteria) gains **Assumptions**, **Coverage** and **Clarifications** (a dated Q → A log)
  sections.
- Provenance and coverage are built in [spec 20](../specs/20-planning-loop.md); the critic in
  [spec 23](../specs/23-triage-questions-and-critic.md).
