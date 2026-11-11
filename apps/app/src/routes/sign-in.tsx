import { Button } from "@software-factory/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@software-factory/ui/components/card";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "#/lib/auth-client";
import { safeRedirect } from "#/lib/session";
import { getSession } from "#/server/fns";

interface SignInSearch {
  redirect?: string;
  error?: string;
}

const ERRORS: Record<string, string> = {
  unable_to_create_user: "This factory is private: your GitHub account is not on its allowlist.",
  forbidden: "This factory is private: your GitHub account is not on its allowlist.",
};

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    ...(typeof search.redirect === "string" ? { redirect: search.redirect } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  beforeLoad: async ({ search }) => {
    if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: target, error } = Route.useSearch();
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function signIn() {
    setPending(true);
    await authClient.signIn.social({
      provider: "github",
      callbackURL: safeRedirect(target),
      errorCallbackURL: "/sign-in",
    });
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-8 place-items-center rounded-md bg-primary font-semibold text-primary-foreground text-sm">
            SF
          </div>
          <CardTitle className="text-lg">Sign in to Software Factory</CardTitle>
          <CardDescription>
            Work comes in, agents take it through triage, spec, build and verify, and you decide at
            the gates.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {ERRORS[error.toLowerCase()] ?? `Sign-in failed (${error}).`}
            </p>
          )}
          <Button disabled={!hydrated || pending} onClick={signIn} data-testid="sign-in-github">
            <GitHubMark />
            {pending ? "Redirecting to GitHub…" : "Continue with GitHub"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
