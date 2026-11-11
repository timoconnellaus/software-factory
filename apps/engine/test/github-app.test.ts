import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_PERMISSIONS,
  githubApp,
  importPrivateKey,
  JOB_TOKEN_PERMISSIONS,
} from "../src/github/app.ts";

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const pem = (label: string, der: Uint8Array) =>
    `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
  // A 2048-bit PKCS#8 key is a 26-byte header around the PKCS#1 key GitHub hands out.
  return {
    pair,
    pkcs8Pem: pem("PRIVATE KEY", pkcs8),
    pkcs1Pem: pem("RSA PRIVATE KEY", pkcs8.slice(26)),
  };
}

function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

describe("GitHub App token minting", () => {
  it("imports GitHub's PKCS#1 key and PKCS#8 alike", async () => {
    const { pkcs1Pem, pkcs8Pem } = await keyPair();
    expect((await importPrivateKey(pkcs1Pem)).type).toBe("private");
    expect((await importPrivateKey(pkcs8Pem)).type).toBe("private");
    // Secrets pasted with literal \n still work.
    expect((await importPrivateKey(pkcs1Pem.replace(/\n/g, "\\n"))).type).toBe("private");
  });

  it("mints a job token for one repository with contents: write only, signed by the App", async () => {
    const { pair, pkcs1Pem } = await keyPair();
    const calls: { url: string; auth: string; body: unknown }[] = [];
    const app = githubApp({
      appId: "5705909",
      privateKey: pkcs1Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          auth: request.headers.get("authorization") ?? "",
          body: await request.json(),
        });
        return Response.json(
          { token: "ghs_job", expires_at: "2026-11-11T02:00:00Z" },
          { status: 201 },
        );
      },
    });
    const minted = await app.mintRepoToken({
      installationId: "99",
      owner: "timoconnellaus",
      repo: "software-factory",
    });
    expect(minted).toEqual({ token: "ghs_job", expiresAt: "2026-11-11T02:00:00Z" });
    const [call] = calls;
    expect(call?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(call?.body).toEqual({
      repositories: ["software-factory"],
      permissions: JOB_TOKEN_PERMISSIONS,
    });
    expect(JOB_TOKEN_PERMISSIONS).toEqual({ contents: "write" });

    const jwt = (call?.auth ?? "").replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      b64urlDecode(signature ?? ""),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload ?? "")));
    expect(claims.iss).toBe("5705909");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("uses a cached control-plane token for repo calls, and reports a non-fast-forward", async () => {
    const { pkcs8Pem } = await keyPair();
    let minted = 0;
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/access_tokens")) {
          minted++;
          expect(await request.json()).toMatchObject({ permissions: CONTROL_PLANE_PERMISSIONS });
          return Response.json(
            { token: "ghs_cp", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 },
          );
        }
        expect(request.headers.get("authorization")).toBe("token ghs_cp");
        if (request.method === "GET") return Response.json({ object: { sha: "a".repeat(40) } });
        return Response.json({ message: "Update is not a fast forward" }, { status: 422 });
      },
    });
    const repo = { installationId: "1", owner: "o", repo: "r" };
    expect(await app.getBranchSha(repo, "factory/1-x")).toBe("a".repeat(40));
    expect(await app.fastForward(repo, "factory/1-x", "b".repeat(40))).toMatchObject({ ok: false });
    expect(minted).toBe(1);
  });
});
