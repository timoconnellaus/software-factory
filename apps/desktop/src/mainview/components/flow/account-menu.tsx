// The account button at the foot of the org strip: who is signed in on this Mac, and Sign out.
import { Avatar, AvatarFallback } from "@software-factory/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@software-factory/ui/components/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { LogOutIcon } from "lucide-react";
import { bun } from "../../bridge.ts";
import { useSession } from "../../lib/session.ts";

export function AccountMenu() {
  const session = useSession();
  const client = useQueryClient();
  const name = session.user.githubLogin ?? "you";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Your account"
          className="flex size-7 items-center justify-center rounded-full"
          data-testid="user-menu"
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-line-strong text-[11px] text-ink-3">
              {name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="font-medium">@{name}</div>
          <div className="text-muted-foreground text-xs">Signed in on this Mac</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => client.setQueryData(["session"], await bun.signOut({}))}
          data-testid="sign-out"
        >
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
