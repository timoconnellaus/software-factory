// `ctx`, the host's side: an RpcTarget passed to the plugin's worker with each hook call. Every
// method runs here, in the engine, with the engine's D1 and network; the plugin holds only this
// stub, for as long as its hook runs. A move and an item the plugin creates are applied (with their
// own hooks) after the hook returns, by steps.ts.
import { RpcTarget } from "cloudflare:workers";
import type { Actor } from "@software-factory/flow";
import {
  addCard,
  addComment,
  createItem,
  getProject,
  type Item,
  type Plugin,
  setField,
} from "@software-factory/store";
import { z } from "zod";
import { type GatewayRequest, type GatewayResponse, gatewayFetch } from "./gateway.ts";
import { cardSchema, type PluginHostEnv, type PluginItem, pluginItem } from "./types.ts";

const newItemSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(300),
  body: z.string().max(100_000).default(""),
  fields: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const issues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");

export class PluginCtx extends RpcTarget {
  /** Status ids `ctx.move` asked for, in order. */
  readonly moves: string[] = [];
  /** Items `ctx.createItem` made. */
  readonly created: Item[] = [];
  /** Set once the hook is over: a late call (after a deadline) is refused. */
  closed = false;

  constructor(
    private readonly env: PluginHostEnv,
    private readonly plugin: Plugin,
    private readonly item: Item | null,
    /** The statuses `ctx.move` may name: the item's workflow's. */
    private readonly statusIds: string[] | null,
  ) {
    super();
  }

  private get actor(): Actor {
    return { kind: "plugin", id: this.plugin.name };
  }

  private open(): void {
    if (this.closed) throw new Error("This hook is over; ctx can't be used after it returns.");
  }

  private needItem(what: string): Item {
    this.open();
    if (!this.item)
      throw new Error(`ctx.${what} needs an item; a trigger has none (use ctx.createItem).`);
    return this.item;
  }

  async comment(text: string): Promise<void> {
    const item = this.needItem("comment");
    const said = String(text).trim();
    if (!said) throw new Error("ctx.comment needs some text.");
    await addComment(this.env.DB, item.id, this.actor, said.slice(0, 20_000));
  }

  async card(card: unknown): Promise<void> {
    const item = this.needItem("card");
    const parsed = cardSchema.safeParse(card);
    if (!parsed.success) throw new Error(`ctx.card: ${issues(parsed.error)}`);
    await addCard(this.env.DB, item.id, this.actor, parsed.data);
  }

  async setField(id: string, value: unknown): Promise<void> {
    const item = this.needItem("setField");
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      throw new Error("ctx.setField takes text, a number, or null to clear it.");
    }
    await setField(this.env.DB, item.id, id, value);
    item.fields = { ...item.fields, [id]: value };
  }

  move(statusId: string): void {
    this.needItem("move");
    if (this.statusIds && !this.statusIds.includes(statusId)) {
      throw new Error(
        `ctx.move: "${statusId}" isn't a status in this item's workflow (${this.statusIds.join(", ")}).`,
      );
    }
    this.moves.push(statusId);
  }

  async createItem(input: unknown): Promise<PluginItem> {
    this.open();
    const parsed = newItemSchema.safeParse(input);
    if (!parsed.success) throw new Error(`ctx.createItem: ${issues(parsed.error)}`);
    const project = await getProject(this.env.DB, parsed.data.projectId);
    if (!project || project.orgId !== this.plugin.orgId) {
      throw new Error(`ctx.createItem: there is no project ${parsed.data.projectId} in this org.`);
    }
    // Created for the person who saved the plugin, so their runners serve it.
    const item = await createItem(this.env.DB, {
      orgId: this.plugin.orgId,
      projectId: project.id,
      title: parsed.data.title,
      body: parsed.data.body,
      createdBy: this.plugin.createdBy,
      ...(parsed.data.fields ? { fields: parsed.data.fields } : {}),
      actor: this.actor,
    });
    this.created.push(item);
    return pluginItem(item);
  }

  gatewayFetch(name: string, path: string, init: GatewayRequest): Promise<GatewayResponse> {
    this.open();
    return gatewayFetch(this.env, this.plugin.orgId, name, path, init ?? {});
  }
}
