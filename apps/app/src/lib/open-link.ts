// The trampoline's mapping (ADR 0392): `/open/<path>` on the website → `sf://<path>` in the desktop
// app. Only paths the app routes pass; anything else is refused rather than passed through.
const ALLOWED = /^(work\/[A-Za-z0-9_-]{1,80}(\/review)?|attach|inbox|setup)$/;

export function appLink(splat: string, search: string): string | null {
  const path = splat.replace(/^\/+|\/+$/g, "");
  if (!ALLOWED.test(path)) return null;
  return `sf://${path}${search}`;
}
