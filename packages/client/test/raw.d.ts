// Vite reads a file as text with `?raw` (tests that check a source file).
declare module "*?raw" {
  const text: string;
  export default text;
}
