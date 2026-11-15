// Plumbing shared by the store's modules: a typed Kysely over D1, ids, times, errors, and running a
// guarded batch (D1 has no interactive transactions; a batch is the only atomic write).
import { clearGuards, D1Dialect, failedGuard } from "@software-factory/db";
import { Kysely } from "kysely";
import type { FlowDatabase } from "./schema.ts";

export type FlowDb = Kysely<FlowDatabase>;

export function flowDb(d1: D1Database): FlowDb {
  return new Kysely<FlowDatabase>({ dialect: new D1Dialect(d1) });
}

/** Why the store refused a call. Nothing was written. */
export class StoreError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "stale_run" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export function newId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function iso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

/**
 * Runs `statements` as one D1 batch, ending with the guard cleanup. A failed batch guard, or two
 * writers taking the same item number or timeline seq, is a conflict: someone else changed it first.
 */
export async function writeBatch(d1: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await d1.batch([...statements, clearGuards(d1)]);
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error);
    if (failedGuard(error) || /UNIQUE constraint failed: flow_(events|items)\./.test(text)) {
      throw new StoreError("conflict", "Someone else changed this item first. Try again.");
    }
    throw error;
  }
}
