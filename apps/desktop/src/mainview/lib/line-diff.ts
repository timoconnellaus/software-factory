// A line diff for the gate's write-back list (review of #130): what approving the plan writes,
// against the pulled base, with the added and removed lines marked. Plain text only.

export interface DiffLine {
  /** `+` added, `-` removed, ` ` the same. */
  mark: "+" | "-" | " ";
  text: string;
}

/** Past this many line pairs the diff isn't worked out: the old text is shown removed, the new added. */
const MAX_CELLS = 4_000_000;

const linesOf = (text: string) => {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** The lines of `after` against `before` (null: a new file, every line added). */
export function lineDiff(before: string | null, after: string): DiffLine[] {
  const b = linesOf(after);
  if (before === null) return b.map((text) => ({ mark: "+", text }));
  const a = linesOf(before);
  // Common head and tail first: most edits touch a few lines in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ mark: " ", text }));
  if ((am.length + 1) * (bm.length + 1) > MAX_CELLS) {
    for (const text of am) out.push({ mark: "-", text });
    for (const text of bm) out.push({ mark: "+", text });
  } else {
    // Longest common subsequence, from the end.
    const w = bm.length + 1;
    const lcs = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          am[i] === bm[j]
            ? (lcs[(i + 1) * w + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        out.push({ mark: " ", text: am[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
        out.push({ mark: "-", text: am[i++] as string });
      } else {
        out.push({ mark: "+", text: bm[j++] as string });
      }
    }
    while (i < am.length) out.push({ mark: "-", text: am[i++] as string });
    while (j < bm.length) out.push({ mark: "+", text: bm[j++] as string });
  }
  for (const text of a.slice(a.length - tail)) out.push({ mark: " ", text });
  return out;
}
