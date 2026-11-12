// The words for a runner's Claude accounts (ADR 0410, spec 32): the account picker's note and
// labels. Names only: accounts and their credentials live on the runner's host. Shared by sf-app
// and the desktop app.
import { ago } from "./format.ts";
import type { OpOutput } from "./ops.ts";

export type RunnerAccounts = NonNullable<OpOutput<"runner.list">["runners"][number]["accounts"]>;

/** The line under the picker: a pick on its way to the host, or the active account's usage limit. */
export function accountNote(accounts: RunnerAccounts): string | null {
  if (accounts.requested && accounts.requested !== accounts.active) {
    return `switching to ${accounts.requested} on the runner's next heartbeat; running jobs keep ${accounts.active}`;
  }
  const limit = accounts.limits.find((l) => l.name === accounts.active);
  if (limit) return `${accounts.active} hit its usage limit ${ago(limit.at)}: ${limit.message}`;
  return null;
}

/** An account's label in the list: its name, and a usage limit if it hit one. */
export function accountLabel(accounts: RunnerAccounts, name: string): string {
  return accounts.limits.some((l) => l.name === name) ? `${name} (hit its limit)` : name;
}
