// Links that leave the app (a PR, a GitHub page, the website): the webview can't open them, so the
// main process opens them in the default browser (https only).
import type { ReactNode } from "react";
import { bun } from "../bridge.ts";

export function openExternal(url: string): void {
  void bun.openExternal({ url });
}

export function ExternalLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
