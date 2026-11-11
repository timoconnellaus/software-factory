// e2e driver (test only, never deployed). See wrangler.jsonc.
interface Env {
  DB: D1Database;
  ENGINE: Fetcher;
  API: {
    invoke(
      name: string,
      input: unknown,
      options: { actor: { type: string; id: string }; origin: { surface: string } },
    ): Promise<{ ok: boolean; result?: { status: string; output?: unknown }; error?: unknown }>;
  };
}
interface FakeState {
  refs: Record<string, string>;
  parents: Record<string, string | null>;
  touched?: Record<string, string[]>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function invoke(env: Env, op: string, input: unknown, actorId: string) {
  const r = await env.API.invoke(op, input, {
    actor: { type: "human", id: actorId },
    origin: { surface: "e2e" },
  });
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.result?.output as Record<string, unknown>;
}

async function fake(env: Env, repo: string): Promise<FakeState | null> {
  const row = await env.DB.prepare("SELECT state FROM fake_github_repos WHERE repo = ?")
    .bind(repo)
    .first<{ state: string }>()
    .catch(() => null);
  return row ? (JSON.parse(row.state) as FakeState) : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/runner/v1/") || url.pathname === "/health") {
      return env.ENGINE.fetch(request);
    }
    // biome-ignore lint/suspicious/noExplicitAny: the driver's request bodies are test input, unchecked on purpose
    const body = (request.method === "POST" ? await request.json() : {}) as Record<string, any>;
    try {
      if (url.pathname === "/seed") {
        const id = `${Date.now().toString(36)}`;
        const userId = `usr_e2e${id}`;
        const orgId = `org_e2e${id}`;
        const now = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'E2E', ?, ?, ?, ?)",
          ).bind(userId, `${userId}@example.invalid`, `e2e-${id}`, now, now),
          env.DB.prepare(
            "INSERT INTO core_organization (id, name, slug, kind, github_installation_id, created_at) VALUES (?, 'Personal', ?, 'personal', '42', ?)",
          ).bind(orgId, orgId, now),
          env.DB.prepare(
            "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
          ).bind(`mem_e2e${id}`, orgId, userId, now),
        ]);
        const project = await invoke(
          env,
          "project.create",
          { orgId, name: "E2E scratch", repoOwner: body.owner, repoName: body.name },
          userId,
        );
        await invoke(
          env,
          "policy.sync",
          {
            projectId: project.id,
            ref: "refs/heads/main",
            sha: `${"0".repeat(39)}1`,
            content: JSON.stringify(body.policy),
          },
          userId,
        );
        const runner = await invoke(env, "runner.register", { name: "M5 e2e" }, userId);
        return json({ userId, orgId, projectId: project.id, ...runner });
      }
      if (url.pathname === "/invoke") {
        return json(await invoke(env, body.op, body.input, body.actorId));
      }
      if (url.pathname === "/sql") {
        const r = await env.DB.prepare(body.sql)
          .bind(...(body.params ?? []))
          .all();
        return json(r.results);
      }
      if (url.pathname === "/fake/ref") {
        const state = await fake(env, body.repo);
        return json({ sha: state?.refs[body.branch] ?? null });
      }
      if (url.pathname === "/fake/mirror") {
        // A real push of `sha` to `branch`: record it in the fake as a child of `parentBranch`'s head.
        const state = await fake(env, body.repo);
        if (!state) return json({ error: "no fake repo" }, 404);
        const parent = state.refs[body.parentBranch] ?? null;
        if (body.realParent && parent && body.realParent !== parent) {
          // Alias the real parent onto the fake one so fast-forward checks hold.
          state.parents[body.realParent] = parent;
        }
        state.parents[body.sha] = body.realParent ?? parent;
        state.refs[body.branch] = body.sha;
        state.touched = { ...(state.touched ?? {}), [body.sha]: body.files ?? [] };
        await env.DB.prepare("UPDATE fake_github_repos SET state = ? WHERE repo = ?")
          .bind(JSON.stringify(state), body.repo)
          .run();
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};
