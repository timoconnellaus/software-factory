// Where the window loads the view from (spec 41). Always the bundled view, except in a dev build
// started with SF_VIEW_URL: then the window loads that URL, such as the screenshot harness's view
// with its fixture door (`vite --config screenshots/vite.config.ts`), so the real window (traffic
// lights, drag region, zoom) can be checked without an account. Canary and stable builds ignore it.
export const BUNDLED_VIEW = "views://mainview/index.html";

export function viewUrl(channel: string, override: string | undefined): string {
  if (channel !== "dev" || !override) return BUNDLED_VIEW;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(override) ? override : BUNDLED_VIEW;
}
