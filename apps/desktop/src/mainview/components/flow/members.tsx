// The org's members (`flow.member.list`), read-only: Team's People tab and Settings' Members tab.
// Until the server lists them, the signed-in person alone, with a line saying so.
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { flowMembersQuery } from "../../lib/flow-queries.ts";
import { useSession } from "../../lib/session.ts";
import { OwnerMark } from "./parts.tsx";

export function MembersList({ orgId }: { orgId: string }) {
  const session = useSession();
  const members = useQuery(flowMembersQuery(orgId));
  if (!members.data) return <Skeleton className="h-24 w-full max-w-xl" />;
  const listed = members.data.members;
  const rows = listed.length
    ? listed
    : [{ userId: session.user.id, name: session.user.name, login: session.user.githubLogin }];
  return (
    <div className="grid max-w-xl gap-2" data-testid="members">
      <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
        {rows.map((m) => (
          <div
            key={m.userId}
            className="flex items-center gap-2.5 border-line-soft border-b px-3.5 py-2.5 last:border-b-0"
            data-testid="member"
          >
            <OwnerMark name={m.name} kind="person" />
            <span className="font-medium">{m.name}</span>
            {m.login && m.login !== m.name && (
              <span className="text-ink-muted text-[12px]">@{m.login}</span>
            )}
            {m.userId === session.user.id && (
              <span className="ml-auto text-[12px] text-ink-faint">You</span>
            )}
          </div>
        ))}
      </div>
      {listed.length === 0 && (
        <p className="text-[12px] text-ink-muted" data-testid="members-pending">
          The rest of the org shows here once the server lists members.
        </p>
      )}
    </div>
  );
}
