// How long the supervisor waits before restarting the runner: doubling from 1 s to 30 s, and back
// to 1 s once a run lasted a minute.
export const HEALTHY_MS = 60_000;
export const MAX_DELAY_MS = 30_000;

export function nextRestart(
  restarts: number,
  ranForMs: number,
): { restarts: number; delayMs: number } {
  const n = ranForMs >= HEALTHY_MS ? 1 : restarts + 1;
  return { restarts: n, delayMs: Math.min(MAX_DELAY_MS, 1000 * 2 ** (n - 1)) };
}
