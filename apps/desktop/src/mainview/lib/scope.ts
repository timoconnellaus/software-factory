// The org strip's squares.

/** An org's square: its initial. */
export const orgInitial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
