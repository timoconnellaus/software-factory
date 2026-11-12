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

/** The website (sf-app): device approvals and GitHub's install flow stay there (ADR 0382). */
export const WEBSITE_URL = "https://software-factory.zerobsai.com";

/** Saves text or bytes to ~/Downloads through the main process (the webview can't download). */
export async function saveFile(filename: string, content: string | Uint8Array): Promise<boolean> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const res = await bun.saveDownload({ filename, base64: btoa(binary) });
  return res.ok;
}
