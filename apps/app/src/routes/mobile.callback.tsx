// The phone sign-in's App Link (ADR 0541): `/mobile/callback?code=…&state=…`. On a phone with the
// app, Android opens the app instead of this page (verified by /.well-known/assetlinks.json). This
// page only shows when that didn't happen: it bounces to the app with an Android intent link, and
// never sends the code anywhere else.
import { Card } from "@software-factory/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MOBILE_PACKAGE } from "#/lib/mobile";

export const Route = createFileRoute("/mobile/callback")({ component: OpenInApp });

/**
 * `intent://` for this page's own URL, so Android hands it to our package. An intent URL ends in
 * `#Intent;…`, so a fragment's values (the pairing secret) move into the query: the intent is
 * handled on the phone and never reaches a server. The app reads them from either place.
 */
export function intentUrl(href: string): string {
  const u = new URL(href);
  const query = new URLSearchParams(u.search);
  for (const [k, v] of new URLSearchParams(u.hash.slice(1))) query.set(k, v);
  const search = query.size > 0 ? `?${query}` : "";
  return `intent://${u.host}${u.pathname}${search}#Intent;scheme=https;package=${MOBILE_PACKAGE};end`;
}

export function OpenInApp() {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => setHref(intentUrl(window.location.href)), []);
  return (
    <main className="mx-auto grid w-full max-w-[480px] gap-4 p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Open the phone app</h1>
      <Card className="gap-2 px-5 py-4 text-sm" data-testid="open-in-app">
        <p>This link finishes in the Software Factory app on your phone.</p>
        {href && (
          <a href={href} className="font-medium underline">
            Open Software Factory
          </a>
        )}
        <p className="text-muted-foreground text-xs">
          On a computer, there's nothing to do here: go back to your phone.
        </p>
      </Card>
    </main>
  );
}
