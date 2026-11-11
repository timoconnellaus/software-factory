# ADR 0265: Planning artifacts are stored in the factory and kept in `.kim/`; mockups render on a sandboxed origin

Status: accepted, 2026-11-11 (planning interview).

## Context
Planning now makes mockups and system designs ([ADR 0260](0260-planning-is-a-live-session-on-a-runner.md)).
They need a home while planning runs, a place in the repo once approved, and a safe way to show
agent-written HTML.

## Decision
- **While planning runs**, artifacts are stored in the factory: metadata and revisions in D1,
  content in R2. They are reached only through operations (`artifact.add`, `artifact.update`,
  `artifact.keep`).
- **At spec approval**, kept artifacts are committed to the work item's branch along with the spec,
  in kim's `.kim/` conventions:
  - `.kim/designs/` for D2, DBML, Mermaid and OpenAPI;
  - `.kim/mockups/` for HTML;
  - `.kim/design-system/`;
  - `.kim/plans/` for the session's plan.

  Drafts and rejected options stay in the factory only. A planning session may **pull** existing
  `.kim/` files from the default branch, and the app shows the change against them.
- **Mockup HTML is untrusted.** It renders only on a separate, sandboxed origin, never on
  `sf-app`'s origin with its session cookie. It has no access to the parent frame beyond a
  `postMessage` protocol for pinned comments and live controls.
- **Design checks run on the runner**, as kim's run in its CLI: D2 and DBML layout checks, and
  Mermaid syntax. The control plane stores the results and needs no D2 engine.

## Consequences
- The `.kim/` folder becomes part of every project template's repo practice ([ADR 0026](0026-repo-practice-via-presets.md)).
- A diff touching `.kim/` is ordinary content, not self-modify; `.factory/` is still self-modify.
- Built in [spec 21](../specs/21-planning-visuals.md) (mockups, origin) and
  [spec 22](../specs/22-planning-system-designs.md) (designs, `.kim/` write-back).
