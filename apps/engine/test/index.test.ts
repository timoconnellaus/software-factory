import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

it("answers /health", async () => {
  const res = await worker.fetch(new Request("https://example.com/health"), env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, worker: "sf-engine" });
});
