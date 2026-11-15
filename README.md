# Software Factory

A small workflow app. An org defines workflows as lists of statuses, each owned by an agent, a
person or nobody; items move through them on a board; agents run on the owner's own machines; and
plugins, built by an agent from plain words, add what the base can't do. The cloud half runs on
Cloudflare, and the daily app is a macOS desktop app.

Start at [`AGENTS.md`](AGENTS.md), then [`docs/architecture.md`](docs/architecture.md) and
[`docs/handoff.md`](docs/handoff.md).

```sh
pnpm i && pnpm lint && pnpm typecheck && pnpm test --concurrency=2
```

- Words: [`CONTEXT.md`](CONTEXT.md)
- The base and plugins in plain words: [`docs/design/base-and-plugins.md`](docs/design/base-and-plugins.md)
- Decisions: [`docs/adr/`](docs/adr/) (from 0660) · Specs: [`docs/specs/`](docs/specs/) (from 70)
- Deploying: [`docs/deploying.md`](docs/deploying.md)
- Mockups: [`.kim/mockups/`](.kim/mockups/) · Design system: [`.kim/design-system/`](.kim/design-system/)
