# ADR 0026: Repo practice, installed via presets

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Factory agents depend on repo files to orient themselves. Relationship OS shows the set that works.

## Decision
- The repo practice is: `AGENTS.md` (with `CLAUDE.md` = `@AGENTS.md`), a `CONTEXT.md` glossary
  with *Avoid:* synonyms, ADRs amended rather than deleted, stage specs with acceptance criteria,
  `docs/parallel-work.md`, `docs/handoff.md` and `evals/`.
- Used in the factory repo, and installed into every project by presets, from `minimal` to `product`.
- The spec stage writes stage specs in this exact format; the verifier checks their acceptance criteria.

## Consequences
- Open question: the exact contents of each preset tier between `minimal` and `product`.
