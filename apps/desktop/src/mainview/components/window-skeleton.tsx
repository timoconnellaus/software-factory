// The window while the app loads (lib/window-shell.ts): the toolbar strip that drags the window,
// the rail, the sidebar and the content panel, as skeletons, filling the window.
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { SHELL } from "../lib/window-shell.ts";

export function WindowSkeleton() {
  return (
    <div className={SHELL.window} aria-busy="true" data-testid="window-skeleton">
      <div className={SHELL.toolbar} data-testid="toolbar-skeleton" />
      <div className={SHELL.body}>
        <div className={SHELL.rail}>
          <Skeleton className="size-8 rounded-full bg-line-strong" />
          <Skeleton className="size-8 rounded-full bg-line-strong" />
        </div>
        <div className={SHELL.sidebar}>
          <Skeleton className="h-5 w-24 bg-line-strong" />
          <Skeleton className="h-4 w-32 bg-line-strong" />
          <Skeleton className="h-4 w-28 bg-line-strong" />
          <Skeleton className="h-4 w-30 bg-line-strong" />
        </div>
        <div className={SHELL.panel}>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      </div>
      <div className={SHELL.status} />
    </div>
  );
}
