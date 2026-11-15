// What plugins write to an item besides kernel events (spec 70 milestone 2): a card on its
// timeline, one of its fields, and a stop when a plugin failed.

import { toStatement } from "@software-factory/db";
import type { Actor } from "@software-factory/flow";
import { sql } from "kysely";
import { flowDb, iso, StoreError, writeBatch } from "./db.ts";
import { appendEntry } from "./items.ts";
import { type Item, loadItem, timelineRow, toItem } from "./step.ts";

/** A field id: letters, digits, `_` and `-`, so it is safe in a JSON path. */
export const FIELD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Adds a card (a plugin's rich timeline entry) to the item. The shape is the caller's to check. */
export function addCard(
  d1: D1Database,
  itemId: string,
  actor: Actor,
  card: unknown,
): Promise<void> {
  return appendEntry(d1, itemId, "card", actor, card);
}

/**
 * Sets one of the item's fields (null removes it). Leaves `updated_at` alone, so a field set by a
 * plugin never makes a concurrent step of the same item a conflict.
 */
export async function setField(
  d1: D1Database,
  itemId: string,
  fieldId: string,
  value: string | number | null,
): Promise<void> {
  if (!FIELD_ID.test(fieldId)) {
    throw new StoreError("invalid", `"${fieldId}" isn't a field id (letters, digits, _ and -).`);
  }
  const path = `$."${fieldId}"`;
  const fields =
    value === null
      ? sql<string>`json_remove(fields, ${path})`
      : sql<string>`json_set(fields, ${path}, json(${JSON.stringify(value)}))`;
  const result = await flowDb(d1)
    .updateTable("flow_items")
    .set({ fields })
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw new StoreError("not_found", `No item ${itemId}.`);
}

/**
 * Stops the item where it is, as a failed run does: its error is set, it waits on nothing, the
 * stay's open run is cancelled, and a `stopped` entry goes on its timeline. `retried` then runs
 * the status again. Used when a plugin fails.
 */
export async function stopItem(
  d1: D1Database,
  itemId: string,
  error: string,
  actor: Actor = { kind: "system" },
): Promise<Item> {
  const db = flowDb(d1);
  const { item, row, lastSeq } = await loadItem(d1, itemId);
  const now = iso();
  await writeBatch(d1, [
    toStatement(
      d1,
      db
        .updateTable("flow_items")
        .set({ error, waiting_on: "nothing", waiting_ref: null, updated_at: now })
        .where("id", "=", itemId),
    ),
    toStatement(
      d1,
      db
        .updateTable("flow_runs")
        .set({ status: "cancelled", finished_at: now })
        .where("item_id", "=", itemId)
        .where("stay", "=", item.stay)
        .where("status", "in", ["queued", "claimed"]),
    ),
    timelineRow(d1, db, {
      org_id: item.orgId,
      item_id: itemId,
      seq: lastSeq + 1,
      kind: "effect",
      actor,
      data: { type: "stopped", statusId: item.statusId, error },
      created_at: now,
    }),
  ]);
  return toItem({ ...row, error, waiting_on: "nothing", waiting_ref: null, updated_at: now });
}
