// Showing a design's preview (spec 22 part B). The SVG was drawn on the runner by the factory's own
// code from untrusted design text; the app shows it only as an image (`<img>` with a data URL), so
// no script in it runs and nothing outside it loads, whatever it holds (ADR 0472's isolation).

/** The SVG as an image source. */
export const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
