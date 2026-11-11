# AGENTS.md

A software factory: work comes in from anywhere, agents take it through triage, spec, build and
verify, and people step in only at gates. Cloud control plane on Cloudflare, pluggable runners.
Start with [`docs/architecture.md`](docs/architecture.md) and the product plan
([`.kim/plans/2026-11-10-personal-software-factory-design.md`](.kim/plans/2026-11-10-personal-software-factory-design.md)),
use the vocabulary in [`CONTEXT.md`](CONTEXT.md), and respect the decisions in [`docs/adr/`](docs/adr/).
Fresh session? Read [`docs/handoff.md`](docs/handoff.md), then [`docs/parallel-work.md`](docs/parallel-work.md).

## Working in a stage

- You will be pointed at a spec in `docs/specs/`. Build what it says. Its acceptance criteria
  are the definition of done.
- If the spec turns out to be wrong or ambiguous, don't silently diverge. Stop and ask, or record the
  deviation and why in the PR description.
- A new significant decision gets an ADR (`docs/adr/NNNN-title.md`, from the block you claimed in
  `docs/parallel-work.md`). If a decision changes, amend the old ADR with a dated note. Never delete one.
- Keep `docs/architecture.md` and `CONTEXT.md` true when you change what they describe.

## Rules that hold everywhere

- **Operations first.** Every factory verb (`workItem.create`, `spec.approve`, `run.start`,
  `pr.merge`) is an operation in the registry (`packages/core`) with zod schemas, a model-facing
  description, a permission and a risk class. The dashboard, MCP and the runner channel call
  operations. Nothing writes to D1 directly. (ADR 0003, 0004)
- **No ambient authority.** Agents and runners never hold standing tokens. Outside access goes
  through connectors; repo access goes through the org's GitHub App, as a per-job token scoped to
  one repo. The harness runs without its owner's git or cloud credentials. A run gets only what its
  work item allows. (ADR 0010, 0025, 0033)
- **Policy is enforced in code and is not AI-configurable.** Gates live in the Workflow state
  machine, never in a prompt. The foreman picks a route only within them. Loosening an autonomy policy
  or the floor is a human-only change, and merge, deploy and self-modify always go to a human. Policy
  is read from the default branch only; a diff to `.factory/` is self-modify. A malformed policy
  fails closed. (ADR 0005, 0008, 0036)
- **Code asks for a model role, never a model id.** (ADR 0018)
- **Runners are adapters.** The core knows only the runner contract and capabilities. It never
  imports Orca or any other runner. Runner-specific features are optional capabilities the adapter
  declares. (ADR 0014)
- **Nothing reaches main except through `factory/verify` and the merge gate.** Local sessions can do
  anything locally, but every PR, whatever its source, needs the `factory/verify` check from the
  org's App on its head SHA, with no admin bypass. (ADR 0020, 0021, 0037)
- **Model credentials stay with the runner's owner.** The factory never stores provider keys or
  subscriptions; repo access is the per-job token, nothing else. (ADR 0023, 0033)

## Tooling

- pnpm + Turborepo, Node 24 (`.nvmrc`). Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before
  pushing.
- Biome formats and lints. Don't add ESLint or Prettier.
- Tests run in workerd via `@cloudflare/vitest-plugin`, except Node packages (`local/*`, `presets`,
  `evals`). Prefer integration tests against real bindings over mocks.
- TypeScript strict. No `any` without a comment saying why.
- Generate Worker `Env` types with `wrangler types`. Don't hand-write them.
- `spikes/` is outside the workspace and Biome. Spikes are throwaway; promote code out of them deliberately.

## Git

- Work on a branch, open a PR against `main`, and keep commits focused. Merge commits only, no rebase
  or force-push.
- The repo is public. Don't commit account IDs, secrets or `.dev.vars`.
