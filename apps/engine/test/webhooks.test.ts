// The GitHub App's webhook (ADR 0010, 0055): only authenticated deliveries are read, the App's
// installation events keep the org's installation record current, and everything else is ignored.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { installationCall, verifySignature } from "../src/webhooks.ts";
import { first, world } from "./helpers.ts";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function deliver(event: string, payload: unknown, secret = "test-webhook-secret") {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request("https://sf-engine.example/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": await sign(secret, body),
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": event,
        "content-type": "application/json",
      },
      body,
    }),
    env,
  );
}

describe("the GitHub webhook", () => {
  it("refuses a delivery whose signature doesn't match", async () => {
    expect((await deliver("ping", {}, "another-secret")).status).toBe(401);
    expect(await verifySignature("s", "body", "sha256=00")).toBe(false);
  });

  it("keeps the installation record current, and ignores everything else", async () => {
    const w = await world();
    const status = async () =>
      first<{ status: string; repository_selection: string }>(
        "SELECT status, repository_selection FROM core_github_installations WHERE id = ?",
        w.installationRecordId,
      );
    const installation = { id: Number(w.installationId), account: { login: "timoconnellaus" } };
    const suspended = await deliver("installation", { action: "suspend", installation });
    expect(suspended.status).toBe(200);
    expect((await status())?.status).toBe("suspended");
    await deliver("installation", { action: "unsuspend", installation });
    expect((await status())?.status).toBe("active");
    await deliver("installation_repositories", {
      action: "added",
      installation,
      repository_selection: "all",
      repositories_added: [{ name: "app", id: 7 }],
    });
    expect(await status()).toEqual({ status: "active", repository_selection: "all" });

    const ignored = await deliver("pull_request", { action: "opened" });
    expect(await ignored.json()).toMatchObject({ ok: true, ignored: true });
    expect(installationCall("check_run", {})).toBeNull();
  });
});
