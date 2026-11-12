// The trampoline (ADR 0382, spec 40 M1): links from outside the app (the factory/verify check, PR
// comments, notifications, a phone) point at `/open/<path>`, which hands them to the desktop app as
// `sf://<path>`. If the app isn't installed, the page says so and offers the website. No sign-in
// needed: it only builds a link.
import { Card } from "@software-factory/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { appLink } from "#/lib/open-link";

export const Route = createFileRoute("/open/$")({
  component: OpenInApp,
});

function OpenInApp() {
  const { _splat } = Route.useParams();
  const search = typeof window === "undefined" ? "" : window.location.search;
  const link = appLink(_splat ?? "", search);
  useEffect(() => {
    if (link) window.location.href = link;
  }, [link]);
  return (
    <main className="mx-auto grid w-full max-w-[560px] gap-4 p-4 md:p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Opening Software Factory…</h1>
      {link ? (
        <Card className="gap-2 px-5 py-4 text-sm" data-testid="open-in-app">
          <div>
            If the app didn't open,{" "}
            <a href={link} className="underline" data-testid="open-in-app-link">
              open it here
            </a>
            .
          </div>
          <div className="text-muted-foreground">
            Don't have it yet? Get the desktop app for macOS, then sign in. You can also{" "}
            <a href="/sign-in" className="underline">
              sign in on the website
            </a>
            .
          </div>
        </Card>
      ) : (
        <Card className="px-5 py-4 text-sm" data-testid="open-unknown">
          That link doesn't point at anything the app can open.
        </Card>
      )}
    </main>
  );
}
