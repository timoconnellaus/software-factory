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

  it("uses a cached control-plane token for repo calls, and reports a non-fast-forward", async () => {
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

describe("finding the App's installation on a repo (incident 2026-11-11-bootstrap)", () => {
  const repo = ["timoconnellaus", "software-factory"] as const;
  async function appWith(respond: (url: string) => Response) {
    const { pkcs1Pem } = await keyPair();
    const seen: { url: string; auth: string }[] = [];
    const app = githubApp({
      appId: "5705909",
      appSlug: "software-factory-zerobsai",
      privateKey: pkcs1Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push({ url: request.url, auth: request.headers.get("authorization") ?? "" });
        return respond(request.url);
      },
    });
    return { app, seen };
  }

  it("asks as the App (its JWT), not as a user", async () => {
    const { app, seen } = await appWith(() => Response.json({ id: 12345 }));
    expect(await app.findRepoInstallation(...repo)).toEqual({
      installationId: "12345",
      reason: null,
    });
    expect(seen[0]?.url).toBe(
      "https://api.github.com/repos/timoconnellaus/software-factory/installation",
    );
    // A JWT (three base64url parts), never a user's ghu_ token.
    expect(seen[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("says why when there is none, with GitHub's own words", async () => {
    const missing = await appWith(() => Response.json({ message: "Not Found" }, { status: 404 }));
    expect((await missing.app.findRepoInstallation(...repo)).reason).toMatch(
      /software-factory-zerobsai isn't installed on timoconnellaus\/software-factory.*installations\/new/,
    );
    const badKey = await appWith(() =>
      Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 }),
    );
    expect((await badKey.app.findRepoInstallation(...repo)).reason).toMatch(
      /401 A JSON web token could not be decoded.*GH_APP_PRIVATE_KEY/,
    );
    const other = await appWith(() => Response.json({ message: "boom" }, { status: 502 }));
    expect((await other.app.findRepoInstallation(...repo)).reason).toMatch(
      /GitHub answered 502.*boom/,
    );
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

  it("reaches a repo only through a token GitHub limits to it (422: not reachable)", async () => {
    const { app } = await appWith(async (r) => {
      if (r.url.endsWith("/access_tokens")) {
        const body = (await r.json()) as { repository_ids: number[] };
        if (body.repository_ids[0] === 99) {
          return Response.json(
            {
              message:
                "There is at least one repository that does not exist or is not accessible to the parent installation.",
            },
            { status: 422 },
          );
        }
        return Response.json({
          token: "ghs_one",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return Response.json(repoJson(5, "software-factory"));
    });
    expect(await app.getInstallationRepo("7", 5)).toMatchObject({
      id: 5,
      name: "software-factory",
      defaultBranch: "main",
    });
    expect(await app.getInstallationRepo("7", 99)).toBeNull();
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

describe("reading protection (ADR 0280): read-only, always", () => {
  it("reads rulesets, bypass lists and the rules in force with read tokens and GETs only", async () => {
    const { pkcs1Pem } = await keyPair();
    const tokenPermissions: Record<string, string>[] = [];
    const methods: string[] = [];
    const app = githubApp({
      appId: "5705909",
      appSlug: "software-factory-zerobsai",
      privateKey: pkcs1Pem,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/access_tokens")) {
          const body = (await request.json()) as { permissions: Record<string, string> };
          tokenPermissions.push(body.permissions);
          return Response.json({ token: "ghs_x", expires_at: "2099-01-01T00:00:00Z" });
        }
        methods.push(request.method);
        const path = url.pathname.replace("/repos/timoconnellaus/software-factory", "");
        if (path === "/branches/main/protection") return new Response("{}", { status: 404 });
        if (path === "/rulesets") {
          expect(url.searchParams.get("includes_parents")).toBe("true");
          return Response.json([{ id: 11 }, { id: 12 }]);
        }
        if (path === "/rulesets/11") {
          return Response.json({
            id: 11,
            name: "factory: protect the default branch",
            target: "branch",
            enforcement: "active",
            conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
            rules: [{ type: "deletion" }],
            bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
          });
        }
        if (path === "/rulesets/12") {
          // GitHub leaves bypass_actors out for callers it won't show them to.
          return Response.json({
            id: 12,
            name: "org rules",
            target: "branch",
            enforcement: "active",
            conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
            rules: [{ type: "non_fast_forward" }],
          });
        }
        if (path === "/rules/branches/main") {
          return Response.json([
            { type: "deletion", ruleset_id: 11, ruleset_source_type: "Repository" },
            { type: "non_fast_forward", ruleset_id: 12, ruleset_source_type: "Organization" },
          ]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    const guards = await app.repoGuards(
      { installationId: "1", owner: "timoconnellaus", repo: "software-factory" },
      "main",
    );
    expect(guards.protection).toBeNull();
    expect(guards.rulesets.map((r) => [r.id, r.bypassActors])).toEqual([
      [11, [{ actorType: "RepositoryRole", actorId: 5, bypassMode: "always" }]],
      [12, null],
    ]);
    expect(guards.branchRules).toEqual([
      { type: "deletion", rulesetId: 11 },
      { type: "non_fast_forward", rulesetId: 12 },
    ]);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
    for (const p of tokenPermissions) {
      expect(Object.values(p).every((v) => v === "read")).toBe(true);
    }
  });
});
