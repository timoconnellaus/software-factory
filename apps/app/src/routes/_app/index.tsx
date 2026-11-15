// The website's home: the person is signed in, and the work happens in the desktop app. After
// connecting the GitHub App (/integrations/github/setup) it also says how that went.
import { Card } from "@software-factory/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";

interface HomeSearch {
  github?: string;
  account?: string;
  github_error?: string;
}

const text = (v: unknown) => (typeof v === "string" && v.length <= 500 ? v : undefined);

export const Route = createFileRoute("/_app/")({
  validateSearch: (s: Record<string, unknown>): HomeSearch => {
    const out: HomeSearch = {};
    const github = text(s.github);
    const account = text(s.account);
    const error = text(s.github_error);
    if (github) out.github = github;
    if (account) out.account = account;
    if (error) out.github_error = error;
    return out;
  },
  component: Home,
});

const GITHUB_OUTCOME: Record<string, string> = {
  connected: "GitHub is connected",
  updated: "GitHub's repositories were updated",
  requested: "The GitHub App was requested: an owner of the account must approve it",
};

function Home() {
  const { github, account, github_error } = Route.useSearch();
  const outcome = github ? GITHUB_OUTCOME[github] : undefined;
  return (
    <main className="mx-auto grid w-full max-w-[560px] gap-4 p-4 md:p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Signed in</h1>
      {github_error ? (
        <Card className="px-5 py-4 text-sm" data-testid="github-error">
          GitHub wasn't connected: {github_error}
        </Card>
      ) : outcome ? (
        <Card className="px-5 py-4 text-sm" data-testid="github-outcome">
          {outcome}
          {account ? ` (${account})` : ""}.
        </Card>
      ) : null}
      <p className="text-muted-foreground text-sm">
        Use the Software Factory desktop app. This website only signs you in and approves the
        sign-ins of the desktop app, the CLI, runners and phones.
      </p>
    </main>
  );
}
