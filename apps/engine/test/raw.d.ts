// Vite's ?raw imports (the source text of a file), used to lock the Workflow's step names.
declare module "*?raw" {
  const content: string;
  export default content;
}
