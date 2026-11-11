import { describe, expect, it } from "vitest";
import { PACKAGE, readDelivery, sign, verifySignature } from "../src/index.ts";

const SECRET = "It's a Secret to Everybody";

const delivery = (body: string, headers: Record<string, string>, method = "POST") =>
  new Request("https://example.com/webhooks/github", {
    method,
    body: method === "POST" ? body : null,
    headers,
  });

describe("webhook signatures", () => {
  it("exports its package name", () => {
    expect(PACKAGE).toBe("@software-factory/connector-webhook");
  });

  it("matches GitHub's documented test vector", async () => {
    // https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await sign(SECRET, "Hello, World!")).toBe(header);
    expect(await verifySignature(SECRET, "Hello, World!", header)).toBe(true);
  });

  it("rejects a wrong secret, a tampered body and malformed headers", async () => {
    const header = await sign(SECRET, "payload");
    expect(await verifySignature("other", "payload", header)).toBe(false);
    expect(await verifySignature(SECRET, "payload!", header)).toBe(false);
    expect(await verifySignature(SECRET, "payload", header.replace("sha256=", "sha1="))).toBe(
      false,
    );
    expect(await verifySignature(SECRET, "payload", "sha256=zz")).toBe(false);
    expect(await verifySignature(SECRET, "payload", "sha256=abcd")).toBe(false);
  });

  it("reads a signed delivery with its id and event", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const got = await readDelivery(
      delivery(body, {
        "x-hub-signature-256": await sign(SECRET, body),
        "x-github-delivery": "d-1",
        "x-github-event": "ping",
      }),
      SECRET,
    );
    expect(got).toEqual({ ok: true, deliveryId: "d-1", event: "ping", body });
  });

  it("refuses unsigned, badly signed, unnamed, non-POST deliveries, and everything when no secret is set", async () => {
    const body = "{}";
    const named = { "x-github-delivery": "d", "x-github-event": "push" };
    expect(await readDelivery(delivery(body, named), SECRET)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      await readDelivery(
        delivery(body, { ...named, "x-hub-signature-256": await sign("x", body) }),
        SECRET,
      ),
    ).toMatchObject({ ok: false, status: 401, error: "bad signature" });
    expect(
      await readDelivery(
        delivery(body, { "x-hub-signature-256": await sign(SECRET, body) }),
        SECRET,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await readDelivery(delivery(body, named, "GET"), SECRET)).toMatchObject({ status: 405 });
    expect(
      await readDelivery(
        delivery(body, { ...named, "x-hub-signature-256": await sign(SECRET, body) }),
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 503 });
  });
});
