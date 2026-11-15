// An org's members, from the sign-in tables (core_member, core_user): who a status can name as its
// owner, and who an item's people are.

export interface Member {
  userId: string;
  name: string;
  /** The GitHub login, when they signed in with GitHub. */
  login: string | null;
}

/** The most members `listMembers` returns. */
export const MEMBER_LIMIT = 200;

/** The org's members by name: core_member's unique (organization_id, user_id), then core_user by key. */
export async function listMembers(d1: D1Database, orgId: string): Promise<Member[]> {
  const { results } = await d1
    .prepare(
      `SELECT u.id, u.name, u.github_login FROM core_member AS m
        JOIN core_user AS u ON u.id = m.user_id
        WHERE m.organization_id = ? ORDER BY u.name, u.id LIMIT ${MEMBER_LIMIT}`,
    )
    .bind(orgId)
    .all<{ id: string; name: string; github_login: string | null }>();
  return results.map((r) => ({ userId: r.id, name: r.name, login: r.github_login }));
}
