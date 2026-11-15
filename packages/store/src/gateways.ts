// An org's gateways (spec 70 milestone 2): its connection to one outside system, by name, with a
// base URL and how to authenticate. The secret is sealed with AES-GCM under a key from the
// engine's FLOW_GATEWAY_KEY secret and never returned by a read, except `gatewayForHost`.
import { flowDb, iso, newId, StoreError } from "./db.ts";
import type { FlowGatewaysTable } from "./schema.ts";

export type GatewayAuth =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "header"; header: string };

/** A gateway as every read sees it: no secret, only whether it has one. */
export interface Gateway {
  id: string;
  orgId: string;
  name: string;
  baseUrl: string;
  auth: GatewayAuth;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

function toGateway(row: FlowGatewaysTable): Gateway {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    baseUrl: row.base_url,
    auth: JSON.parse(row.auth) as GatewayAuth,
    hasSecret: row.secret !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The AES-GCM key: SHA-256 of the engine secret, so any string of enough entropy will do. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seals `plain`, bound to the gateway's org and name (the AES-GCM additional data). */
async function seal(key: string, aad: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await aesKey(key),
    new TextEncoder().encode(plain),
  );
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`;
}

async function open(key: string, aad: string, sealed: string): Promise<string> {
  const [version, iv, ct] = sealed.split(":");
  if (version !== "v1" || !iv || !ct) throw new StoreError("invalid", "The secret can't be read.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(aad) },
    await aesKey(key),
    unb64(ct),
  );
  return new TextDecoder().decode(plain);
}

const NO_KEY =
  "Gateway secrets can't be stored: the engine's FLOW_GATEWAY_KEY secret isn't set (docs/deploying.md). A gateway with auth { kind: \"none\" } still works.";

/**
 * Creates the org's gateway `name`, or replaces its base URL and auth. `secret` replaces the
 * secret, null removes it, and leaving it out keeps the one it has. Storing a secret without
 * `key` (the engine's FLOW_GATEWAY_KEY) is refused.
 */
export async function saveGateway(
  d1: D1Database,
  key: string | undefined,
  input: {
    orgId: string;
    name: string;
    baseUrl: string;
    auth: GatewayAuth;
    secret?: string | null;
  },
): Promise<Gateway> {
  let sealed: string | null | undefined;
  if (typeof input.secret === "string") {
    if (!key) throw new StoreError("unavailable", NO_KEY);
    sealed = await seal(key, `${input.orgId}:${input.name}`, input.secret);
  } else {
    sealed = input.secret;
  }
  const now = iso();
  const row = await flowDb(d1)
    .insertInto("flow_gateways")
    .values({
      id: newId("fgw_"),
      org_id: input.orgId,
      name: input.name,
      base_url: input.baseUrl,
      auth: JSON.stringify(input.auth),
      secret: sealed ?? null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["org_id", "name"]).doUpdateSet((eb) => ({
        base_url: eb.ref("excluded.base_url"),
        auth: eb.ref("excluded.auth"),
        updated_at: eb.ref("excluded.updated_at"),
        ...(sealed !== undefined ? { secret: eb.ref("excluded.secret") } : {}),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toGateway(row);
}

/** The org's gateways by name, without secrets. A handful per org: no cap. */
export async function listGateways(d1: D1Database, orgId: string): Promise<Gateway[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_gateways")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("name")
    .execute();
  return rows.map(toGateway);
}

export async function getGateway(
  d1: D1Database,
  orgId: string,
  name: string,
): Promise<Gateway | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_gateways")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? toGateway(row) : null;
}

export async function deleteGateway(d1: D1Database, orgId: string, name: string): Promise<void> {
  const result = await flowDb(d1)
    .deleteFrom("flow_gateways")
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .executeTakeFirst();
  if (!result.numDeletedRows) throw new StoreError("not_found", `No gateway "${name}".`);
}

/**
 * The plugin host's read: the gateway with its secret opened. Only packages/plugins calls this,
 * to make a plugin's request; nothing returns the secret to a caller.
 */
export async function gatewayForHost(
  d1: D1Database,
  key: string | undefined,
  orgId: string,
  name: string,
): Promise<(Gateway & { secret: string | null }) | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_gateways")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .executeTakeFirst();
  if (!row) return null;
  if (row.secret === null) return { ...toGateway(row), secret: null };
  if (!key) throw new StoreError("unavailable", NO_KEY);
  return { ...toGateway(row), secret: await open(key, `${orgId}:${name}`, row.secret) };
}
