import { env } from "cloudflare:workers";
import type { Actor } from "../src/ops/define";
import { invoke } from "../src/ops/invoke";
import "../src/ops/operations";

export const HUMAN: Actor = { type: "human", id: "tester" };
export const AGENT: Actor = { type: "agent", id: "foreman" };
export const INTAKE: Actor = { type: "intake", id: "test" };

export const call = (
  op: string,
  input: unknown,
  actor: Actor,
  extra: { approvalId?: string } = {},
) => invoke(env, op, input, { actor, origin: { surface: "test" }, ...extra });

export async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await call("policy.setPreset", { preset }, HUMAN);
}

export async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return results;
}
