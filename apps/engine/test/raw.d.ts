// Vite's ?raw imports (the source text of a file), used to lock the Workflow's step names.
declare module "*?raw" {
  const content: string;
  export default content;
}

/** Vite's `import.meta.glob`, for tests that read source files (vite/client isn't a dependency). */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { query?: string; import?: string; eager: true },
  ): Record<string, T>;
}
