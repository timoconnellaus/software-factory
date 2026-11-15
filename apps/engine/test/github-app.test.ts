import { describe, expect, it } from "vitest";
import { appFor } from "../src/deps.ts";
import { githubApp, importPrivateKey, JOB_TOKEN_PERMISSIONS } from "../src/github/app.ts";

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
      appSlug: "software-factory-zerobsai",
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

  it("reads a branch's head with a cached read-only token for that one repository", async () => {
    const { pkcs8Pem } = await keyPair();
    let minted = 0;
    const app = githubApp({
      appId: "1",
      appSlug: "test-app",
      privateKey: pkcs8Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/access_tokens")) {
          minted++;
          expect(await request.json()).toEqual({
            repositories: ["r"],
            permissions: { contents: "read" },
          });
          return Response.json(
            { token: "ghs_read", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 },
          );
        }
        expect(request.headers.get("authorization")).toBe("token ghs_read");
        if (request.url.endsWith("/git/ref/heads/factory/flow-app-1")) {
          return Response.json({ object: { sha: "a".repeat(40) } });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
    const repo = { installationId: "1", owner: "o", repo: "r" };
    expect(await app.getBranchSha(repo, "factory/flow-app-1")).toBe("a".repeat(40));
    expect(await app.getBranchSha(repo, "factory/flow-app-2")).toBeNull();
    expect(minted).toBe(1);
  });
});

describe("installations and their repositories (ADR 0055)", () => {
  async function appWith(respond: (request: Request) => Promise<Response> | Response) {
    const { pkcs1Pem } = await keyPair();
    const seen: Request[] = [];
    const app = githubApp({
      appId: "5705909",
      appSlug: "software-factory-zerobsai",
      privateKey: pkcs1Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(request.clone());
        return respond(request);
      },
    });
    return { app, seen };
  }
  const repoJson = (id: number, name: string) => ({
    id,
    name,
    owner: { login: "timoconnellaus" },
    private: false,
    default_branch: "main",
  });

  it("reads an installation as the App; one GitHub doesn't know is null (a forged id)", async () => {
    const { app, seen } = await appWith((r) =>
      r.url.endsWith("/app/installations/7")
        ? Response.json({
            id: 7,
            account: { login: "acme", type: "Organization" },
            repository_selection: "selected",
            suspended_at: "2026-11-11T00:00:00Z",
          })
        : Response.json({ message: "Not Found" }, { status: 404 }),
    );
    expect(await app.getInstallation("7")).toEqual({
      installationId: "7",
      account: { login: "acme", type: "Organization" },
      repositorySelection: "selected",
      suspended: true,
    });
    expect(await app.getInstallation("8")).toBeNull();
    expect(seen[0]?.headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("lists repositories with a metadata-only installation token, paged", async () => {
    const { app } = await appWith(async (r) => {
      if (r.url.endsWith("/access_tokens")) {
        expect(await r.json()).toEqual({ permissions: { metadata: "read" } });
        return Response.json({
          token: "ghs_meta",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      expect(r.headers.get("authorization")).toBe("token ghs_meta");
      const page = new URL(r.url).searchParams.get("page");
      return Response.json({
        total_count: 2,
        repositories: page === "1" ? [repoJson(1, "a")] : [repoJson(2, "b")],
      });
    });
    expect((await app.listInstallationRepos("7")).map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("lists a person's installations with their own token, only to check access", async () => {
    const { app, seen } = await appWith(() =>
      Response.json({ total_count: 2, installations: [{ id: 7 }, { id: 9 }] }),
    );
    expect(await app.userInstallationIds("ghu_person")).toEqual(["7", "9"]);
    expect(seen[0]?.url).toBe("https://api.github.com/user/installations?per_page=100&page=1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer ghu_person");
  });
});

describe("the App client kept for the isolate (AGENTS.md, Cloudflare cost, rule 10)", () => {
  const repo = { installationId: "42", owner: "o", repo: "r" };

  it("reuses its JWT until a minute before it expires", async () => {
    const { pkcs1Pem } = await keyPair();
    let at = Date.parse("2026-11-12T00:00:00Z");
    const app = githubApp({
      appId: "1",
      appSlug: "s",
      privateKey: pkcs1Pem,
      now: () => new Date(at),
    });
    const first = await app.appJwt();
    at += 6 * 60_000;
    expect(await app.appJwt()).toBe(first);
    at += 2 * 60_000; // 8 of its 9 minutes gone: a minute or less left
    expect(await app.appJwt()).not.toBe(first);
  });

  it("drops a token GitHub answers 401 for and retries once with a fresh one", async () => {
    const { pkcs1Pem } = await keyPair();
    let minted = 0;
    const used: string[] = [];
    const app = githubApp({
      appId: "1",
      appSlug: "s",
      privateKey: pkcs1Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/access_tokens")) {
          minted++;
          return Response.json({
            token: `ghs_${minted}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        const auth = request.headers.get("authorization") ?? "";
        used.push(auth);
        // The first token is revoked after its first use.
        if (auth === "token ghs_1" && used.length > 1) return new Response("", { status: 401 });
        return Response.json({ object: { sha: "a".repeat(40) } });
      },
    });
    expect(await app.getBranchSha(repo, "main")).toBe("a".repeat(40));
    expect(await app.getBranchSha(repo, "main")).toBe("a".repeat(40)); // cached, then 401, then fresh
    expect(await app.getBranchSha(repo, "main")).toBe("a".repeat(40)); // the fresh one, cached
    expect(minted).toBe(2);
    expect(used).toEqual(["token ghs_1", "token ghs_1", "token ghs_2", "token ghs_2"]);
  });

  it("is built once per App configuration", async () => {
    const { pkcs1Pem } = await keyPair();
    const a = appFor("1", "s", pkcs1Pem);
    expect(appFor("1", "s", pkcs1Pem)).toBe(a);
    expect(appFor("2", "s", pkcs1Pem)).not.toBe(a);
  });
});
