// The Claude account picker on a runner's row (ADR 0410, spec 32). Accounts live on the runner's
// host and are added there (`sf-runner account add`); the picker only chooses among their names.
// A pick goes to the host on its next heartbeat; new jobs use it, running jobs keep theirs.
// Presentational: Setup's `RunnerAccountPicker` calls `runner.account.use`.
import { OptionSelect } from "#/components/option-select";
import { ago } from "#/lib/format";
import type { OpOutput } from "#/lib/ops";

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

export function RunnerAccountsView({
  accounts,
  busy = false,
  onPick,
}: {
  accounts: RunnerAccounts | null;
  busy?: boolean;
  onPick: (name: string) => void;
}) {
  if (!accounts) return null;
  const shown = accounts.requested ?? accounts.active;
  const note = accountNote(accounts);
  return (
    <div className="grid w-full gap-1 pl-4" data-testid="runner-accounts">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Claude account</span>
        <OptionSelect
          value={shown}
          options={accounts.names.map((name) => ({
            value: name,
            label: accountLabel(accounts, name),
          }))}
          onChange={(name) => {
            if (name !== shown) onPick(name);
          }}
          disabled={busy || accounts.names.length < 2}
          aria-label="Claude account for new jobs"
          data-testid="runner-account-select"
        />
        {accounts.names.length < 2 && (
          <span className="text-muted-foreground">
            add one on the runner:{" "}
            <span className="font-mono">sf-runner account add &lt;name&gt;</span>
          </span>
        )}
      </div>
      {note && (
        <div
          className={
            accounts.requested ? "text-muted-foreground text-xs" : "text-destructive text-xs"
          }
          data-testid="runner-account-note"
        >
          {note}
        </div>
      )}
    </div>
  );
}
