// TanStack Query options for the desktop's reads outside the new core's (flow-queries.ts has
// those), through `read()` (one `batch` on the client door per tick).
import { queryOptions } from "@tanstack/react-query";
import { read } from "./op.ts";

export interface Me {
  user: { id: string; name: string; githubLogin: string | null };
  orgs: { id: string; name: string; kind: string; role: string }[];
  /** The Personal org (every user has one). */
  personalOrgId: string | null;
}

/** Who is signed in and their orgs (`org.list`), the desktop's stand-in for sf-app's session. */
export const meQuery = (login: string | null) =>
  queryOptions({
    queryKey: ["me", login],
    queryFn: async (): Promise<Me> => {
      const { orgs, userId } = await read("org.list", {});
      return {
        user: { id: userId, name: login ?? "you", githubLogin: login },
        orgs,
        personalOrgId: orgs.find((o) => o.kind === "personal")?.id ?? null,
      };
    },
    staleTime: 5 * 60_000,
  });

/** Your runners, each with its health (online, busy, rate-limited, offline) and whether it can take work. */
export const runnersQuery = () =>
  queryOptions({
    queryKey: ["runners"],
    queryFn: () => read("runner.list", {}),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
