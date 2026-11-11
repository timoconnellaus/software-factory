import { createFileRoute } from "@tanstack/react-router";
import { ChevronsUpDown, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { authClient } from "#/lib/auth-client.ts";
import type { AccountView, OrgView } from "#/server/api.ts";

export const Route = createFileRoute("/")({ component: Home });

type Scope = { kind: "all" } | { kind: "org"; accountUserId: string; orgId: string };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/factory${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function Home() {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAccounts(await api<AccountView[]>("/orgs"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (accounts === null) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (accounts.length === 0 || adding) {
    return (
      <SignIn
        adding={accounts.length > 0}
        onDone={async () => {
          setAdding(false);
          await reload();
        }}
        onCancel={accounts.length > 0 ? () => setAdding(false) : undefined}
      />
    );
  }

  const orgs = accounts.flatMap((a) => a.orgs);
  const visible =
    scope.kind === "all"
      ? orgs
      : orgs.filter((o) => o.id === scope.orgId && o.accountUserId === scope.accountUserId);
  const current = scope.kind === "org" ? visible[0] : undefined;

  return (
    <div className="grid min-h-svh md:grid-cols-[260px_1fr]">
      <aside className="hidden flex-col gap-1 border-r bg-sidebar p-3 md:flex">
        <Switcher
          accounts={accounts}
          scope={scope}
          onScope={setScope}
          onAdd={() => setAdding(true)}
          run={run}
        />
      </aside>
      <main className="min-w-0 p-6">
        <div className="mb-4 md:hidden">
          <Switcher
            accounts={accounts}
            scope={scope}
            onScope={setScope}
            onAdd={() => setAdding(true)}
            run={run}
          />
        </div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">
          {current ? current.name : "All factories"}
        </h1>
        <p className="mb-6 text-muted-foreground">
          {current
            ? `As ${accounts.find((a) => a.account.userId === current.accountUserId)?.account.email}`
            : `${orgs.length} orgs across ${accounts.length} signed-in accounts. Each action runs as the account shown.`}
        </p>
        {error && <p className="mb-4 text-destructive">{error}</p>}
        <div className="grid gap-4">
          {visible.map((org) => (
            <OrgCard
              key={`${org.accountUserId}:${org.id}`}
              org={org}
              accountEmail={
                accounts.find((a) => a.account.userId === org.accountUserId)?.account.email ?? ""
              }
              run={run}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-secondary text-[11px] font-semibold">
      {label}
    </span>
  );
}

function Switcher(props: {
  accounts: AccountView[];
  scope: Scope;
  onScope: (s: Scope) => void;
  onAdd: () => void;
  run: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const { accounts, scope, onScope, onAdd, run } = props;
  const [open, setOpen] = useState(false);
  const orgCount = accounts.reduce((n, a) => n + a.orgs.length, 0);
  const current =
    scope.kind === "org"
      ? accounts.flatMap((a) => a.orgs).find((o) => o.id === scope.orgId)
      : undefined;
  const pick = (s: Scope) => {
    onScope(s);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border bg-background px-2 py-1.5 text-left"
        >
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            ⚙
          </span>
          <span className="grid leading-tight">
            <span className="font-semibold">{current?.name ?? "All factories"}</span>
            <span className="text-xs text-muted-foreground">
              {orgCount} orgs · {accounts.length} accounts
            </span>
          </span>
          <ChevronsUpDown className="ml-auto size-4 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-1.5">
        <button
          type="button"
          onClick={() => pick({ kind: "all" })}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent ${scope.kind === "all" ? "bg-accent" : ""}`}
        >
          <Avatar label="∗" />
          All factories
        </button>
        <Separator className="my-1.5" />
        {accounts.map(({ account, orgs }) => (
          <div key={account.userId}>
            <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs text-muted-foreground">
              <span
                className={`size-1.5 rounded-full ${account.active ? "bg-status-done" : "bg-status-idle"}`}
              />
              <span className="truncate">{account.email}</span>
              {account.active ? (
                <span className="ml-auto">active</span>
              ) : (
                <button
                  type="button"
                  className="ml-auto underline-offset-2 hover:underline"
                  onClick={run(() => api("/switch", { accountUserId: account.userId }))}
                >
                  make active
                </button>
              )}
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={run(() => api("/sign-out-account", { accountUserId: account.userId }))}
              >
                sign out
              </button>
            </div>
            {orgs.map((org) => (
              <div key={org.id}>
                <button
                  type="button"
                  onClick={() =>
                    pick({ kind: "org", accountUserId: org.accountUserId, orgId: org.id })
                  }
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent ${scope.kind === "org" && scope.orgId === org.id && scope.accountUserId === org.accountUserId ? "bg-accent" : ""}`}
                >
                  <Avatar label={org.name.slice(0, 1).toUpperCase()} />
                  {org.name}
                  {org.factories.length > 0 && (
                    <Badge variant="secondary" className="ml-auto">
                      {org.factories.length}
                    </Badge>
                  )}
                </button>
                {org.factories.length > 0 && (
                  <div className="pl-[38px] text-xs text-muted-foreground">
                    {org.factories.map((f) => `factory: ${f.name}`).join(" · ")}
                  </div>
                )}
              </div>
            ))}
            <CreateOrg accountUserId={account.userId} run={run} />
          </div>
        ))}
        <Separator className="my-1.5" />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onAdd();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
        >
          <Plus className="size-4" /> Add another account
        </button>
        <button
          type="button"
          onClick={run(async () => {
            const res = await authClient.passkey.addPasskey();
            if (res?.error) throw new Error(res.error.message ?? "Passkey failed");
          })}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent"
        >
          <Plus className="size-4" /> Add a passkey to the active account
        </button>
      </PopoverContent>
    </Popover>
  );
}

function CreateOrg(props: {
  accountUserId: string;
  run: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void props.run(async () => {
      await api("/orgs", { accountUserId: props.accountUserId, name });
      setName("");
    })();
  };
  return (
    <form onSubmit={submit} className="flex gap-1 px-2 py-1">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="＋ Create organisation"
        className="h-7 text-xs"
      />
    </form>
  );
}

function OrgCard(props: {
  org: OrgView;
  accountEmail: string;
  run: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const { org, accountEmail, run } = props;
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      // The org's own account, never the active one.
      await api("/factories", {
        accountUserId: org.accountUserId,
        organizationId: org.id,
        name,
      });
      setName("");
    })();
  };
  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Avatar label={org.name.slice(0, 1).toUpperCase()} />
        <h2 className="text-[15px] font-semibold">{org.name}</h2>
        <Badge variant="outline">{org.role}</Badge>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{accountEmail}</span>
      </div>
      <ul className="mt-3 grid gap-1">
        {org.factories.length === 0 && <li className="text-muted-foreground">No factories yet.</li>}
        {org.factories.map((f) => (
          <li key={f.id} className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-status-idle" />
            factory: <span className="font-medium">{f.name}</span>
            <span className="text-xs text-muted-foreground">
              {f.projects.length} project{f.projects.length === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New factory name"
          className="h-8 max-w-60"
        />
        <Button size="sm" variant="outline" type="submit">
          Create as {accountEmail}
        </Button>
      </form>
    </section>
  );
}

function SignIn(props: {
  adding: boolean;
  onDone: () => Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const emailAuth = async (mode: "in" | "up") => {
    setError(null);
    const res =
      mode === "in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: email.split("@")[0] ?? email });
    if (res.error) return setError(res.error.message ?? "Sign-in failed");
    await props.onDone();
  };

  return (
    <div className="grid min-h-svh place-items-center bg-muted p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">
          {props.adding ? "Add another account" : "Sign in"}
        </h1>
        <p className="mb-4 text-muted-foreground">
          {props.adding
            ? "You stay signed in to your other accounts."
            : "Personal and work accounts can be signed in at once."}
        </p>
        <div className="grid gap-2">
          <Button
            onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/" })}
          >
            Continue with GitHub
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              const res = await authClient.signIn.passkey();
              if (res?.error) return setError(res.error.message ?? "Passkey failed");
              await props.onDone();
            }}
          >
            Sign in with a passkey
          </Button>
        </div>
        <Separator className="my-4" />
        <p className="mb-2 text-xs text-muted-foreground">Local dev only: email + password</p>
        <div className="grid gap-2">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password (8+ chars)"
          />
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => emailAuth("in")}>
              Sign in
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => emailAuth("up")}>
              Sign up
            </Button>
          </div>
          {error && <p className="text-destructive">{error}</p>}
          {props.onCancel && (
            <Button variant="ghost" onClick={props.onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
