// Drawing helpers: every design is drawn to a static SVG by this package's own code (ADR 0472's
// thinking for designs: no design text is executed). Text is escaped, nothing links outside the
// file, and no script or event attribute is ever written, so the app can show it as an image.

/** Escapes text for an SVG text node or attribute. */
export const esc = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A rough width of text at a font size (the preview uses a system sans; good enough to lay out). */
export function textWidth(text: string, size: number, mono = false): number {
  if (mono) return text.length * size * 0.62;
  let w = 0;
  for (const ch of text) w += /[mwMW@]/.test(ch) ? 0.85 : /[ilIjt.,:;'|!]/.test(ch) ? 0.3 : 0.56;
  return w * size;
}

export const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The palette (light, neutral): the app tints changes on top, so the drawing stays plain. */
export const INK = {
  ink: "#0e0f11",
  muted: "#676c74",
  line: "#d3d7dd",
  panel: "#f6f6f7",
  card: "#ffffff",
  head: "#eef0f3",
  accent: "#1f6bff",
};

/** Rounds for compact output. */
export const r1 = (n: number) => Math.round(n * 10) / 10;

export function text(
  x: number,
  y: number,
  value: string,
  opts: { size?: number; weight?: number; fill?: string; anchor?: string; mono?: boolean } = {},
): string {
  const size = opts.size ?? 13;
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}" font-family="${opts.mono ? MONO : FONT}"${opts.weight ? ` font-weight="${opts.weight}"` : ""} fill="${opts.fill ?? INK.ink}"${opts.anchor ? ` text-anchor="${opts.anchor}"` : ""}>${esc(value)}</text>`;
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { fill?: string; stroke?: string; radius?: number } = {},
): string {
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${opts.radius ?? 6}" fill="${opts.fill ?? INK.card}" stroke="${opts.stroke ?? INK.line}"/>`;
}

export function path(points: { x: number; y: number }[], opts: { dashed?: boolean } = {}): string {
  if (points.length < 2) return "";
  const d = points.map((p, i) => `${i ? "L" : "M"}${r1(p.x)} ${r1(p.y)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${INK.muted}" stroke-width="1.4"${opts.dashed ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#arrow)"/>`;
}

/** A label on a line, on a patch of the background so the line doesn't strike through it. */
export function lineLabel(x: number, y: number, value: string, size = 12): string {
  const w = textWidth(value, size) + 8;
  return `<rect x="${r1(x - w / 2)}" y="${r1(y - size)}" width="${r1(w)}" height="${r1(size + 6)}" rx="3" fill="${INK.panel}"/>${text(x, y, value, { size, anchor: "middle", fill: INK.muted })}`;
}

/** A whole SVG document of the given size around `body`. */
export function svgDocument(width: number, height: number, body: string): string {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${INK.muted}"/></marker></defs><rect width="${w}" height="${h}" fill="${INK.panel}"/>${body}</svg>`;
}
