# ADR 0532: Runners back off claiming under load, heavy first, and say why

Status: accepted, 2026-11-12. Spec [43](../specs/43-runners-under-load.md). Amends
[0301](0301-runner-capacity-has-heavy-and-light-pools.md).

## Context
The M5 runs up to eight factory sessions next to the owner's own agents. In incident #11, its load
went from 17 to 25, and tmux took minutes to answer. The runner kept claiming, because its only
limits were slot counts. A slot count can't tell a quiet machine from one that's drowning.

## Decision
- **Thresholds on the 1-minute load average**, as a multiple of the CPU count
  (`os.loadavg()[0] / availableParallelism()`, on macOS and Linux alike):
  - heavy jobs (build, verify) stop above **1.5×**;
  - light jobs (triage, spec, planning) stop too above **2.0×**;
  - each pool resumes below its stop × **0.8** (hysteresis), so a load hovering at the line doesn't
    flap.
  - Running jobs are never touched.
- **Why these numbers.** At the incident, tmux stopped answering at loads of 17–25, about 1.7× to 2.5× (assuming
  the M5 has 10 cores; its owner should confirm).
  - Stopping heavy work at 1.5× leaves headroom before that point. A build or verify is what adds
    the most load: installs, tests, more agents.
  - Light work is cheap and interactive, and planning sessions are people waiting, so it gets until
    2.0×. That's still before the point where everything broke.
  - The 1-minute average lags, so 0.8× keeps a pool closed until the load has really dropped.
- **Configurable, on by default**, in `runner.json`:
  `load: { enabled, heavyStop, lightStop, resumeFactor }` (`lightStop ≥ heavyStop`).
- **Said on the wire.** The capacity on every heartbeat and claim carries
  `paused: { reason: "load" | "tmux", pools, load1?, cores?, detail? }`. With both pools paused,
  `accepting` is false too. `tmux` is the adapter's pause when its tmux doesn't answer (ADR 0530).
  - The scheduler's free-pool check gives a paused pool nothing.
  - The engine stores the pause (`core_runners.paused`, migration 0300).
  - The inbox's runner health line reads "runner busy: load 19.3 on 10 cores, no new heavy jobs".

## Consequences
- A busy machine finishes what it has before it takes more. The factory's work waits in the queue,
  or goes to another runner, instead of making the machine worse.
- A machine that is always busy for other reasons never takes heavy work until its owner raises the
  thresholds or turns the gate off. The health line says why.
- An older engine ignores `paused`. zod strips unknown keys, and runners update to the deployed
  commit (ADR 0360), so the two ship together.
