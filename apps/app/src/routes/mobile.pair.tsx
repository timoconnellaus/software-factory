// A pairing QR code's App Link (ADR 0541): `/mobile/pair?offer=…#secret=…`. Scanned in the app, or
// by the phone's camera with the app installed, it opens the app. This page shows only when it
// didn't: it bounces to the app. The secret stays in the fragment, which no server sees.
import { createFileRoute } from "@tanstack/react-router";
import { OpenInApp } from "./mobile.callback.tsx";

export const Route = createFileRoute("/mobile/pair")({ component: OpenInApp });
