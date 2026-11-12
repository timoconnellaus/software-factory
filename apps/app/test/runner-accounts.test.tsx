// The Claude account picker on Setup's runner rows (ADR 0410, spec 32): names only, a pending pick
// says it's on its way, and a usage limit shows next to the account that hit it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  accountLabel,
  accountNote,
  type RunnerAccounts,
  RunnerAccountsView,
} from "#/components/runner-accounts";

const base: RunnerAccounts = {
  names: ["default", "work"],
  active: "default",
  requested: null,
  limits: [],
};

const render = (accounts: RunnerAccounts | null) =>
  renderToStaticMarkup(<RunnerAccountsView accounts={accounts} onPick={() => {}} />);

describe("runner account picker", () => {
  it("shows nothing for a runner that hasn't reported accounts", () => {
    expect(render(null)).toBe("");
  });

  it("shows the active account, and the pick while it's on its way to the host", () => {
    const html = render(base);
    expect(html).toContain('data-testid="runner-account-select"');
    expect(html).toContain("default");
    expect(accountNote(base)).toBeNull();
    const pending = { ...base, requested: "work" };
    expect(accountNote(pending)).toBe(
      "switching to work on the runner's next heartbeat; running jobs keep default",
    );
    expect(render(pending)).toContain("switching to work");
  });

  it("says how to add an account when the host has only default", () => {
    expect(render({ ...base, names: ["default"] })).toContain("sf-runner account add");
  });

  it("surfaces a usage limit on the active account; the owner switches by hand", () => {
    const limited: RunnerAccounts = {
      ...base,
      limits: [{ name: "default", at: new Date().toISOString(), message: "usage limit reached" }],
    };
    expect(accountNote(limited)).toMatch(/^default hit its usage limit .*: usage limit reached$/);
    expect(accountLabel(limited, "default")).toBe("default (hit its limit)");
    expect(accountLabel(limited, "work")).toBe("work");
    expect(render(limited)).toContain('data-testid="runner-account-note"');
  });
});
