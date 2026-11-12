// The Claude account picker on a runner's row (ADR 0410, spec 32). Accounts live on the runner's
// host and are added there (`sf-runner account add`); the picker only chooses among their names.
// A pick goes to the host on its next heartbeat; new jobs use it, running jobs keep theirs.
// Presentational: Setup's `RunnerAccountPicker` calls `runner.account.use`.
import {
  accountLabel,
  accountNote,
  type RunnerAccounts,
} from "@software-factory/client/runner-accounts";
import { OptionSelect } from "#/components/option-select";

export type { RunnerAccounts };

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
