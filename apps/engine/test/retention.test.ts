// Retention of the platform's expiring tables (AGENTS.md "Cloudflare cost", rule 3): device codes
// and GitHub connect states go a day past their expiry, a bounded batch a round.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pruneExpired } from "../src/retention.ts";
import { all, uid, world } from "./helpers.ts";

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("pruneExpired", () => {
  it("deletes only rows a day past their expiry", async () => {
    const w = await world();
    const tag = uid("");
    await env.DB.batch([
      ...[2, 0.5].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_runner_device_codes (id, device_code_hash, user_code, status, created_at, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        ).bind(`rdc_${tag}${i}`, `h-${tag}-${i}`, `U-${tag}-${i}`, iso(3 * DAY), iso(days * DAY)),
      ),
      ...[2, 0.5].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_cli_device_codes (id, device_code_hash, user_code, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(`cdc_${tag}${i}`, `h-${tag}-${i}`, `C-${tag}-${i}`, iso(3 * DAY), iso(days * DAY)),
      ),
      ...[2, 0.5].map((days, i) =>
        env.DB.prepare(
          `INSERT INTO core_github_connect_states (state_hash, org_id, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(`s-${tag}-${i}`, w.orgId, w.userId, iso(3 * DAY), iso(days * DAY)),
      ),
    ]);
    await pruneExpired(env.DB);
    const left = async (sql: string, ...p: unknown[]) => (await all(sql, ...p)).length;
    expect(
      await left("SELECT 1 FROM core_runner_device_codes WHERE id LIKE ?", `rdc_${tag}%`),
    ).toBe(1);
    expect(await left("SELECT 1 FROM core_cli_device_codes WHERE id LIKE ?", `cdc_${tag}%`)).toBe(
      1,
    );
    expect(
      await left("SELECT 1 FROM core_github_connect_states WHERE state_hash LIKE ?", `s-${tag}-%`),
    ).toBe(1);
  });

  it("goes round again while a table fills its batch, up to the rounds a tick allows", async () => {
    const w = await world();
    const tag = uid("");
    await env.DB.batch(
      Array.from({ length: 7 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO core_github_connect_states (state_hash, org_id, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(`r-${tag}-${i}`, w.orgId, w.userId, iso(3 * DAY), iso(2 * DAY)),
      ),
    );
    const left = async () =>
      (await all("SELECT 1 FROM core_github_connect_states WHERE state_hash LIKE ?", `r-${tag}-%`))
        .length;
    // Batches of 2, two rounds: 4 go this tick, then the rest.
    const handled = await pruneExpired(env.DB, new Date(), 2, 2);
    expect(handled.core_github_connect_states).toBe(4);
    expect(await left()).toBe(3);
    await pruneExpired(env.DB, new Date(), 2, 10);
    expect(await left()).toBe(0);
  });
});
