// The plugin contract's shapes on the host's side: what the engine gives the host, the hooks, the
// payloads, a card, and the ways a dispatch can end.
import type { Item } from "@software-factory/store";
import { z } from "zod";

/** What the host needs from the engine's Env. */
export interface PluginHostEnv {
  DB: D1Database;
  /** The Worker Loader binding. Without it a plugin that has hooks fails when they run. */
  LOADER?: WorkerLoader;
  /** The engine secret gateway secrets are sealed with (docs/deploying.md). */
  FLOW_GATEWAY_KEY?: string;
}

export const HOOKS = ["entered", "leaving", "runEnded", "trigger"] as const;
export type HookName = (typeof HOOKS)[number];

/** The item as a plugin sees it: plain data. */
export interface PluginItem {
  id: string;
  number: number;
  title: string;
  body: string;
  statusId: string;
  fields: Record<string, unknown>;
}

export function pluginItem(item: Item): PluginItem {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    statusId: item.statusId,
    fields: item.fields,
  };
}

/** A run as `runEnded` sees it. A failed run's outcome is "failed" and its summary the error. */
export interface PluginRun {
  id: string;
  agentId: string;
  statusId: string;
  outcome: "done" | "rejected" | "failed";
  summary: string;
}

export type HookPayload =
  | { hook: "entered" | "leaving"; item: PluginItem; from: string | null; to: string }
  | { hook: "runEnded"; item: PluginItem; run: PluginRun }
  | { hook: "trigger"; name: string; payload: unknown };

/** A rich timeline card, the one generic shape the app draws. */
export const cardSchema = z.object({
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(1_000).optional(),
  rows: z
    .array(z.object({ label: z.string().max(200), value: z.string().max(2_000) }))
    .max(50)
    .optional(),
  checks: z
    .array(z.object({ label: z.string().max(200), ok: z.boolean() }))
    .max(50)
    .optional(),
  bars: z
    .array(z.object({ label: z.string().max(200), value: z.number(), max: z.number() }))
    .max(50)
    .optional(),
  link: z.object({ label: z.string().max(200), url: z.string().url() }).optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const fieldSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "date"]),
});

/** What a module declares, read when it is saved. */
export const declarationSchema = z.object({
  fields: z.array(fieldSchema).max(50),
  hooks: z.array(z.enum(HOOKS)),
});
export type Declaration = z.infer<typeof declarationSchema>;

/** A plugin's `leaving` said no. For a person's or agent's move, the caller sees the reason. */
export class PluginRefusal extends Error {
  constructor(
    readonly plugin: string,
    readonly reason: string,
  ) {
    super(`Plugin "${plugin}" refused: ${reason}`);
    this.name = "PluginRefusal";
  }
}

/** How long one hook call into a plugin may take. */
export const HOOK_DEADLINE_MS = 10_000;

/** How many plugin moves (`ctx.move`) may follow one another before the item is stopped. */
export const MOVE_CHAIN_LIMIT = 10;
