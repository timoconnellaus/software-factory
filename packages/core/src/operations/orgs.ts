// The orgs a person belongs to (Better Auth's organization plugin keeps them).
import { z } from "zod";
import { defineOperation } from "../operation.ts";

export const orgList = defineOperation({
  name: "org.list",
  description:
    "The orgs you belong to, your Personal org first, with your role in each, and your own user id: what the CLI and the desktop app use to find your orgs.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({
    orgs: z.array(
      z.object({ id: z.string(), name: z.string(), kind: z.string(), role: z.string() }),
    ),
    userId: z.string(),
  }),
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_member as m")
      .innerJoin("core_organization as o", "o.id", "m.organization_id")
      .select(["o.id", "o.name", "o.kind", "m.role", "o.created_at"])
      .where("m.user_id", "=", ctx.actor.id)
      .execute();
    rows.sort(
      (a, b) =>
        Number(b.kind === "personal") - Number(a.kind === "personal") ||
        String(a.created_at).localeCompare(String(b.created_at)),
    );
    return {
      orgs: rows.map((r) => ({ id: r.id, name: r.name, kind: String(r.kind), role: r.role })),
      userId: ctx.actor.id,
    };
  },
});
