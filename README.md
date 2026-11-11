# Software Factory

A software factory: work comes in from anywhere (GitHub, Linear, Slack, chat, local Claude sessions), agents take it through triage → planning/spec → build → verify, and people step in only at gates. It has a cloud control plane on Cloudflare and pluggable runners (Orca first).

Status: scaffolded; building the MVP slice. Start at [`AGENTS.md`](AGENTS.md) and [`docs/handoff.md`](docs/handoff.md).

```sh
pnpm i && pnpm lint && pnpm typecheck && pnpm test
```

- Architecture overview: [`docs/architecture.md`](docs/architecture.md) · Glossary: [`CONTEXT.md`](CONTEXT.md)
- Decisions: [`docs/adr/`](docs/adr/) · Specs: [`docs/specs/`](docs/specs/)
- Product plan: [`.kim/plans/2026-11-10-personal-software-factory-design.md`](.kim/plans/2026-11-10-personal-software-factory-design.md)
- Architecture: [`.kim/designs/v1-architecture.d2`](.kim/designs/v1-architecture.d2)
- UI plan (in progress): [`docs/ui-plan.md`](docs/ui-plan.md)
- Mockups: [`.kim/mockups/`](.kim/mockups/) · Design system: [`.kim/design-system/`](.kim/design-system/)
- Prior art: [`docs/research/ideas-from-crm-and-cloudflare-os.md`](docs/research/ideas-from-crm-and-cloudflare-os.md)
