// Plugins and Gateways (.kim/mockups/plugins.html, gateways.html). A plugin is built by an agent in
// Chat from what the person asked for; here it is a plain list: its name, the request in the
// person's words, an on/off switch, and the last error in plain words. Opened, its code shows
// read-only, with Delete. A gateway is the org's connection to one outside system: its base URL,
// which auth it uses, and whether its secret is set. A secret is write-only: never shown again.

import { when } from "@software-factory/client/flow";
import type { FlowGateway, FlowGatewayAuth, FlowPlugin } from "@software-factory/client/flow-edit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@software-factory/ui/components/alert-dialog";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { Switch } from "@software-factory/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { CableIcon, PlusIcon, PuzzleIcon, SparklesIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  flowGatewaysQuery,
  flowPluginQuery,
  flowPluginsQuery,
} from "../../lib/flow-edit-queries.ts";
import { useFlowRefresh } from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { PageHeader, Pill } from "./parts.tsx";

export type PluginsTab = "plugins" | "gateways";

const failed = (e: unknown, fallback: string) =>
  e instanceof OpError || e instanceof Error ? e.message : fallback;

export function PluginsPage({
  orgId,
  tab,
  pluginId,
  onChoose,
}: {
  orgId: string;
  tab: PluginsTab;
  pluginId: string | undefined;
  onChoose: (next: { tab?: PluginsTab; plugin?: string }) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  return (
    <main className="relative flex min-w-0 flex-1 flex-col" data-testid="plugins-page">
      <PageHeader
        title="Plugins"
        tabs={["Plugins", "Gateways"]}
        tab={tab === "gateways" ? "Gateways" : "Plugins"}
        onTab={(t) => onChoose({ tab: t === "Gateways" ? "gateways" : "plugins" })}
      >
        <span className="flex-1" />
        {tab === "gateways" && (
          <Button size="md" onClick={() => setConnecting(true)} data-testid="connect-system">
            <PlusIcon />
            Connect a system
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto bg-board px-5 py-5">
        {tab === "gateways" ? (
          <Gateways orgId={orgId} connecting={connecting} onConnecting={setConnecting} />
        ) : (
          <Plugins orgId={orgId} chosen={pluginId} onOpen={(id) => onChoose({ plugin: id })} />
        )}
      </div>
      {tab === "plugins" && pluginId && (
        <PluginPanel orgId={orgId} pluginId={pluginId} onClose={() => onChoose({})} />
      )}
    </main>
  );
}

// ---- Plugins ------------------------------------------------------------------------------------

function Plugins({
  orgId,
  chosen,
  onOpen,
}: {
  orgId: string;
  chosen: string | undefined;
  onOpen: (pluginId: string) => void;
}) {
  const plugins = useQuery(flowPluginsQuery(orgId));
  const list = plugins.data?.plugins ?? [];
  return (
    <div className="grid max-w-[860px] gap-3.5">
      <div
        className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3.5 py-2.5"
        data-testid="plugin-ask"
      >
        <SparklesIcon className="size-4 flex-none text-ink-faint" />
        <Input
          disabled
          placeholder="Say what you want the app to do…"
          aria-label="Say what you want the app to do"
          className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 disabled:opacity-100 dark:bg-transparent"
        />
        <Button size="md" disabled>
          Ask
        </Button>
      </div>
      <p className="-mt-1.5 px-1 text-[12.5px] text-ink-muted">
        Plugins are built in Chat: say what you want there, and an agent builds it.
      </p>
      {plugins.error ? (
        <p className="text-bad">Couldn't load the plugins. {plugins.error.message}</p>
      ) : !plugins.data ? (
        <Skeleton className="h-20 w-full" />
      ) : list.length === 0 ? (
        <p className="text-ink-muted" data-testid="plugins-empty">
          No plugins yet.
        </p>
      ) : (
        list.map((p) => (
          <PluginRow
            key={p.id}
            orgId={orgId}
            plugin={p}
            chosen={p.id === chosen}
            onOpen={() => onOpen(p.id)}
          />
        ))
      )}
    </div>
  );
}

function PluginRow({
  orgId,
  plugin,
  chosen,
  onOpen,
}: {
  orgId: string;
  plugin: FlowPlugin;
  chosen: boolean;
  onOpen: () => void;
}) {
  const refresh = useFlowRefresh(orgId);
  const [busy, setBusy] = useState(false);
  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await op(
        "flow.plugin.setEnabled",
        { orgId, pluginId: plugin.id, enabled },
        { idempotencyKey: submitKey() },
      );
    } catch (error) {
      toast.error(failed(error, "Couldn't change the plugin"));
    } finally {
      await refresh();
      setBusy(false);
    }
  }
  return (
    <section
      className={
        chosen
          ? "rounded-xl border border-work bg-panel px-4 py-3.5 shadow-[0_0_0_2px_var(--work-soft)]"
          : "rounded-xl border border-line bg-panel px-4 py-3.5"
      }
      data-testid="plugin-row"
      data-enabled={plugin.enabled ? "true" : "false"}
    >
      <div className="flex items-center gap-2.5">
        <PuzzleIcon className="size-4 flex-none text-ink-muted" />
        <button
          type="button"
          className="truncate font-semibold text-[14px] hover:underline"
          onClick={onOpen}
          data-testid="open-plugin"
        >
          {plugin.name}
        </button>
        {!plugin.enabled && <Pill>Off</Pill>}
        <span className="flex-1" />
        <span className="text-[12px] text-ink-faint">Changed {when(plugin.updatedAt)}</span>
        <Switch
          checked={plugin.enabled}
          disabled={busy}
          onCheckedChange={(on) => void toggle(on)}
          aria-label={`${plugin.name} on`}
          data-testid="plugin-switch"
        />
      </div>
      <p className="mt-1.5 text-ink-2 italic" data-testid="plugin-request">
        “{plugin.request}”
      </p>
      {plugin.lastError && (
        <p className="mt-1.5 text-[12.5px] text-bad" data-testid="plugin-error">
          {plugin.lastError}
        </p>
      )}
    </section>
  );
}

function PluginPanel({
  orgId,
  pluginId,
  onClose,
}: {
  orgId: string;
  pluginId: string;
  onClose: () => void;
}) {
  const plugin = useQuery(flowPluginQuery(orgId, pluginId));
  const refresh = useFlowRefresh(orgId);
  const [confirming, setConfirming] = useState(false);
  const p = plugin.data?.plugin;
  async function remove() {
    try {
      await op("flow.plugin.delete", { orgId, pluginId }, { idempotencyKey: submitKey() });
      onClose();
      await refresh();
      toast.success("Plugin deleted");
    } catch (error) {
      toast.error(failed(error, "Couldn't delete the plugin"));
    }
  }
  return (
    <aside
      className="absolute top-2 right-2 bottom-2 z-10 flex w-[560px] max-w-[calc(100%-16px)] flex-col rounded-xl border border-line bg-panel shadow-[0_12px_40px_rgba(20,20,20,0.12)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
      data-testid="plugin-panel"
    >
      <header className="flex items-center gap-2 border-line-soft border-b px-3.5 py-2">
        <PuzzleIcon className="size-4 text-ink-muted" />
        <span className="truncate font-semibold">{p?.name ?? ""}</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="md"
          className="text-bad hover:text-bad"
          disabled={!p}
          onClick={() => setConfirming(true)}
          data-testid="delete-plugin"
        >
          <Trash2Icon />
          Delete
        </Button>
        <Button variant="ghost" size="icon-md" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        {plugin.error ? (
          <p className="text-bad">Couldn't load the plugin. {plugin.error.message}</p>
        ) : !p ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <p className="mb-3 text-ink-2 italic">“{p.request}”</p>
            {p.lastError && <p className="mb-3 text-[12.5px] text-bad">{p.lastError}</p>}
            <div className="mb-1.5 font-semibold text-[12px] text-ink-muted">Code</div>
            <pre
              className="overflow-auto whitespace-pre rounded-lg border border-line-soft bg-board px-3 py-2.5 font-mono text-[12px] leading-[1.55]"
              data-testid="plugin-code"
            >
              {p.code}
            </pre>
          </>
        )}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {p?.name ?? "this plugin"}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops everywhere in the org straight away. Ask in Chat to build it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()} data-testid="confirm-delete-plugin">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

// ---- Gateways -----------------------------------------------------------------------------------

const AUTH_LABEL: Record<FlowGatewayAuth["kind"], string> = {
  none: "No auth",
  bearer: "Bearer token",
  header: "A named header",
};

function authText(auth: FlowGatewayAuth): string {
  if (auth.kind === "header") return auth.header ? `Header ${auth.header}` : AUTH_LABEL.header;
  return AUTH_LABEL[auth.kind];
}

/** Connected when it needs no secret or has one. */
const connected = (g: FlowGateway) => g.auth.kind === "none" || g.hasSecret;

function Gateways({
  orgId,
  connecting,
  onConnecting,
}: {
  orgId: string;
  connecting: boolean;
  onConnecting: (open: boolean) => void;
}) {
  const gateways = useQuery(flowGatewaysQuery(orgId));
  const refresh = useFlowRefresh(orgId);
  const [editing, setEditing] = useState<FlowGateway | null>(null);
  const [removing, setRemoving] = useState<FlowGateway | null>(null);
  const list = gateways.data?.gateways ?? [];

  async function remove(g: FlowGateway) {
    try {
      await op("flow.gateway.delete", { orgId, gatewayId: g.id }, { idempotencyKey: submitKey() });
      await refresh();
    } catch (error) {
      toast.error(failed(error, "Couldn't remove the connection"));
    }
  }

  return (
    <div className="max-w-[860px]">
      <div className="mb-2 font-semibold text-[12px] text-ink-muted">Connected systems</div>
      {gateways.error ? (
        <p className="text-bad">Couldn't load the gateways. {gateways.error.message}</p>
      ) : !gateways.data ? (
        <Skeleton className="h-16 w-full" />
      ) : list.length === 0 ? (
        <p className="text-ink-muted" data-testid="gateways-empty">
          No systems connected yet.
        </p>
      ) : (
        <ul
          className="overflow-hidden rounded-xl border border-line bg-panel"
          data-testid="gateway-list"
        >
          {list.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-3 border-line-soft border-b px-3.5 py-2.5 last:border-b-0"
              data-testid="gateway-row"
            >
              <CableIcon className="size-4 flex-none text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{g.name}</span>
                <span className="block truncate text-[12px] text-ink-muted">{g.baseUrl}</span>
              </span>
              <span className="text-[12px] text-ink-muted">{authText(g.auth)}</span>
              {connected(g) ? (
                <Pill className="border-ok/40 text-ok" data-testid="gateway-connected">
                  Connected
                </Pill>
              ) : (
                <Pill className="border-need-line text-need" data-testid="gateway-needs-secret">
                  Needs a secret
                </Pill>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setEditing(g)}
                data-testid="edit-gateway"
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-bad hover:text-bad"
                onClick={() => setRemoving(g)}
                data-testid="remove-gateway"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[12.5px] text-ink-muted">
        A gateway is your org's connection to one outside system. You set it up once; plugins and
        agents use it by name.
      </p>
      <GatewayDialog
        key={editing?.id ?? (connecting ? "new" : "closed")}
        orgId={orgId}
        gateway={editing}
        open={connecting || !!editing}
        onOpenChange={(open) => {
          if (open) return;
          onConnecting(false);
          setEditing(null);
        }}
      />
      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Plugins and agents that use it can't reach {removing?.name} until it is connected
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && void remove(removing)}
              data-testid="confirm-remove-gateway"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Connect a system, or change one. The secret field starts empty every time it opens. */
function GatewayDialog({
  orgId,
  gateway,
  open,
  onOpenChange,
}: {
  orgId: string;
  gateway: FlowGateway | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const refresh = useFlowRefresh(orgId);
  const [name, setName] = useState(gateway?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(gateway?.baseUrl ?? "");
  const [kind, setKind] = useState<FlowGatewayAuth["kind"]>(gateway?.auth.kind ?? "bearer");
  const [header, setHeader] = useState(gateway?.auth.header ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = name.trim() && baseUrl.trim() && (kind !== "header" || header.trim());

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    const auth: FlowGatewayAuth = kind === "header" ? { kind, header: header.trim() } : { kind };
    try {
      await op(
        "flow.gateway.save",
        {
          orgId,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          auth,
          ...(kind !== "none" && secret ? { secret } : {}),
        },
        { idempotencyKey: submitKey() },
      );
      setSecret("");
      await refresh();
      onOpenChange(false);
    } catch (err) {
      setError(failed(err, "Couldn't save the connection"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="grid gap-4" data-testid="gateway-form">
          <DialogHeader>
            <DialogTitle>{gateway ? `Change ${gateway.name}` : "Connect a system"}</DialogTitle>
            <DialogDescription>
              Plugins and agents reach it by its name. The secret is kept by the server and never
              shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="gateway-name">Name</Label>
            <Input
              id="gateway-name"
              value={name}
              autoFocus={!gateway}
              disabled={!!gateway}
              maxLength={80}
              placeholder="GitHub"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gateway-url">Base URL</Label>
            <Input
              id="gateway-url"
              value={baseUrl}
              placeholder="https://api.example.com"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Auth</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as FlowGatewayAuth["kind"])}>
              <SelectTrigger className="w-full" data-testid="gateway-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="header">A named header</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "header" && (
            <div className="grid gap-1.5">
              <Label htmlFor="gateway-header">Header name</Label>
              <Input
                id="gateway-header"
                value={header}
                placeholder="X-Api-Key"
                onChange={(e) => setHeader(e.target.value)}
              />
            </div>
          )}
          {kind !== "none" && (
            <div className="grid gap-1.5">
              <Label htmlFor="gateway-secret">Secret</Label>
              <Input
                id="gateway-secret"
                type="password"
                autoComplete="off"
                value={secret}
                placeholder={
                  gateway?.hasSecret ? "Saved. Type a new one to replace it." : "Paste the secret"
                }
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-bad">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving || !ready} data-testid="save-gateway">
              {gateway ? "Save" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
