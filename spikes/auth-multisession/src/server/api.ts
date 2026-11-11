// The spike's own API, under /api/factory/*. Cross-account reads merge per-account results;
// every write names its account and runs under that account's session only.
import { AccountNotSignedInError, accountSession, listDeviceAccounts } from "./accounts.ts";
import { type Auth, ensurePersonalOrg } from "./auth.ts";

export const API_BASE_PATH = "/api/factory";

/** What the "All factories" view gets: each org tagged with the account it came from. */
export interface AccountView {
  account: { userId: string; email: string; name: string; image: string | null; active: boolean };
  orgs: OrgView[];
}

export interface OrgView {
  /** The account this org was read under. Every action on it must name this account. */
  accountUserId: string;
  id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  role: string;
  /** This account session's own active org (Better Auth keeps one per session). */
  active: boolean;
  factories: { id: string; name: string; projects: { id: string; name: string }[] }[];
}

function json(body: unknown, status = 200, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: h });
}

function errorStatus(error: unknown): number {
  if (error instanceof AccountNotSignedInError) return 401;
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" ? status : 500;
}

export async function listAllOrgs(auth: Auth, db: D1Database, request: Request) {
  const accounts = await listDeviceAccounts(auth, request);
  return Promise.all(
    accounts.map(async (account): Promise<AccountView> => {
      // Self-heal: the Personal org is written after the user row, outside its transaction.
      await ensurePersonalOrg(db, account.userId);
      // Better Auth scopes this to the account's own memberships.
      const orgs = await auth.api.listOrganizations({ headers: account.headers });
      const session = await auth.api.getSession({
        headers: account.headers,
        query: { disableCookieCache: true },
      });
      const ids = orgs.map((o) => o.id);
      const roles = new Map<string, string>();
      const factories = new Map<string, OrgView["factories"]>();
      if (ids.length > 0) {
        const marks = ids.map(() => "?").join(",");
        const memberRows = await db
          .prepare(
            `SELECT organizationId, role FROM member WHERE userId = ? AND organizationId IN (${marks})`,
          )
          .bind(account.userId, ...ids)
          .all<{ organizationId: string; role: string }>();
        for (const r of memberRows.results) roles.set(r.organizationId, r.role);
        const rows = await db
          .prepare(
            `SELECT f.id, f.name, f.organizationId, p.id AS projectId, p.name AS projectName
             FROM factory f LEFT JOIN project p ON p.factoryId = f.id
             WHERE f.organizationId IN (${marks}) ORDER BY f.createdAt, p.createdAt`,
          )
          .bind(...ids)
          .all<{
            id: string;
            name: string;
            organizationId: string;
            projectId: string | null;
            projectName: string | null;
          }>();
        for (const r of rows.results) {
          const list = factories.get(r.organizationId) ?? [];
          let f = list.find((x) => x.id === r.id);
          if (!f) {
            f = { id: r.id, name: r.name, projects: [] };
            list.push(f);
          }
          if (r.projectId && r.projectName)
            f.projects.push({ id: r.projectId, name: r.projectName });
          factories.set(r.organizationId, list);
        }
      }
      return {
        account: {
          userId: account.userId,
          email: account.email,
          name: account.name,
          image: account.image,
          active: account.active,
        },
        orgs: orgs
          .map((o) => ({
            accountUserId: account.userId,
            id: o.id,
            name: o.name,
            slug: o.slug,
            kind: ((o as { kind?: string }).kind === "personal"
              ? "personal"
              : "team") as OrgView["kind"],
            role: roles.get(o.id) ?? "member",
            active: session?.session.activeOrganizationId === o.id,
            factories: factories.get(o.id) ?? [],
          }))
          // Personal first, then by name.
          .sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1,
          ),
      };
    }),
  );
}

/** Creates a factory in `organizationId`, acting as `accountUserId` and no one else. */
export async function createFactory(
  auth: Auth,
  db: D1Database,
  request: Request,
  input: { accountUserId: string; organizationId: string; name: string },
): Promise<{ id: string; organizationId: string; name: string }> {
  const account = await accountSession(auth, request, input.accountUserId);
  // Better Auth checks membership + role for *this* session's user. It answers a non-member with
  // 401 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION; the session itself is already verified above,
  // so any refusal here is a 403.
  const allowed = await auth.api
    .hasPermission({
      headers: account.headers,
      body: { organizationId: input.organizationId, permissions: { factory: ["create"] } },
    })
    .then((r) => r.success)
    .catch(() => false);
  if (!allowed) {
    throw Object.assign(new Error("Not allowed to create factories in this org"), {
      statusCode: 403,
    });
  }
  const id = `fac_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO factory (id, organizationId, name, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.organizationId, input.name, account.userId, Date.now())
    .run();
  return { id, organizationId: input.organizationId, name: input.name };
}

/** Routes /api/factory/*. Returns null for anything else. */
export async function handleApi(
  auth: Auth,
  db: D1Database,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${API_BASE_PATH}/`)) return null;
  const route = `${request.method} ${url.pathname.slice(API_BASE_PATH.length)}`;
  try {
    switch (route) {
      case "GET /orgs":
        return json(await listAllOrgs(auth, db, request));

      case "POST /factories": {
        const body = (await request.json()) as {
          accountUserId?: string;
          organizationId?: string;
          name?: string;
        };
        if (!body.accountUserId || !body.organizationId || !body.name?.trim()) {
          return json({ error: "accountUserId, organizationId and name are required" }, 400);
        }
        const factory = await createFactory(auth, db, request, {
          accountUserId: body.accountUserId,
          organizationId: body.organizationId,
          name: body.name.trim(),
        });
        return json(factory, 201);
      }

      case "POST /orgs": {
        // Create a team org as the named account (the Better Auth client would use the active one).
        const body = (await request.json()) as { accountUserId?: string; name?: string };
        if (!body.accountUserId || !body.name?.trim()) {
          return json({ error: "accountUserId and name are required" }, 400);
        }
        const account = await accountSession(auth, request, body.accountUserId);
        const name = body.name.trim();
        const slug = `${name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 6)}`;
        const org = await auth.api.createOrganization({
          headers: account.headers,
          body: { name, slug, keepCurrentActiveOrganization: true },
        });
        return json(org, 201);
      }

      case "POST /switch": {
        // Make an account the active one. Only touches the browser's active-session cookie.
        const body = (await request.json()) as { accountUserId?: string };
        if (!body.accountUserId) return json({ error: "accountUserId is required" }, 400);
        const account = await accountSession(auth, request, body.accountUserId);
        const result = await auth.api.setActiveSession({
          headers: request.headers,
          body: { sessionToken: account.sessionToken },
          returnHeaders: true,
        });
        return json({ ok: true, userId: result.response.user.id }, 200, result.headers);
      }

      case "POST /sign-out-account": {
        // Sign one account out of this device; the others stay signed in.
        const body = (await request.json()) as { accountUserId?: string };
        if (!body.accountUserId) return json({ error: "accountUserId is required" }, 400);
        const account = await accountSession(auth, request, body.accountUserId);
        const result = await auth.api.revokeDeviceSession({
          headers: request.headers,
          body: { sessionToken: account.sessionToken },
          returnHeaders: true,
        });
        return json({ ok: true }, 200, result.headers);
      }

      default:
        return json({ error: "Not found" }, 404);
    }
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : "Error";
    return json({ error: message }, status === 500 ? 500 : status);
  }
}
