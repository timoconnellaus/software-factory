# ADR 0281: Runner capacity has heavy and light pools

Status: accepted, 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)).

## Context
A runner reports one capacity number (`maxConcurrent`, default 2), shared by every job. A
planning session ([ADR 0280](0280-planning-is-a-live-session-on-a-runner.md)) is a Claude process
that mostly reads and waits in its Stop hook: little memory, no CPU, no tokens while idle. A build or
verify run executes the project's test suite. If both counted the same, a few idle planning
sessions would block every build, and the other way round.

## Decision
- A runner's capacity has two pools:
  - **heavy** (build, verify);
  - **light** (planning, triage).

  Each pool has its own limit, set by the runner's owner. The defaults are 2 heavy and 6 light.
- The scheduler places a job in the pool its stage belongs to. An idle planning session holds one
  light slot.
- When the light pool is full and a job is waiting, the scheduler asks the oldest idle planning
  session (nobody present for at least 5 minutes, no new answers) to **yield**. Its Stop hook acts
  on the request, and the session is resumed later on the same runner.
- The capacity wire schema gains `light: { max, inUse }` next to the existing fields, which stay the
  heavy pool. Older runners that report no light pool take no planning jobs.

## Consequences
- Amends [ADR 0015](0015-scheduler-runtime-pool-and-capabilities.md) and [ADR 0100](0100-runner-contract.md) (capacity in the heartbeat).
- `sf-runner` config gains `maxLight`, and the runner health line shows both pools.
- Built in [spec 20](../specs/20-planning-loop.md).
