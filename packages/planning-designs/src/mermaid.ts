// Sequence and state designs in Mermaid (spec 22): checked with Mermaid's own parser (as kim does;
// only parsing runs here, nothing is rendered by Mermaid), then read by this package's own small
// reader and drawn here: participants and messages, or states and transitions, each a part.
import type { DesignFinding, DesignPart, DesignType } from "@software-factory/runner-contract";
import { DesignParseError } from "./errors.ts";
import { placeGraph } from "./graph.ts";
import { midBox, readability, sig } from "./layout.ts";
import { INK, lineLabel, path, r1, rect, svgDocument, text, textWidth } from "./svg.ts";
import type { Drawn } from "./types.ts";

const ACCEPTS: Partial<Record<DesignType, { diagrams: string[]; header: string }>> = {
  sequence: { diagrams: ["sequence"], header: "sequenceDiagram" },
  state: { diagrams: ["stateDiagram", "state"], header: "stateDiagram-v2" },
};

/** Parses with Mermaid; throws its error (line in `hash.loc`) or a wrong-diagram DesignParseError. */
export async function checkMermaid(type: DesignType, source: string): Promise<void> {
  // Mermaid sanitises labels with DOMPurify, which needs a DOM: only parsing happens here, so text
  // passes as is (nothing is drawn by Mermaid, and its output is never shown).
  const { default: purify } = await import("dompurify");
  if (!purify.isSupported) {
    purify.addHook = () => undefined;
    purify.sanitize = ((t: string) => t) as typeof purify.sanitize;
  }
  const { default: mermaid } = await import("mermaid");
  const { diagramType } = await mermaid.parse(source);
  const accepted = ACCEPTS[type];
  if (accepted && !accepted.diagrams.includes(diagramType)) {
    throw new DesignParseError("wrong diagram", [
      {
        message: `This is a Mermaid ${diagramType} diagram, but a ${type} design is drawn from \`${accepted.header}\``,
        line: 1,
        column: null,
      },
    ]);
  }
}

/** The lines that say something: comments (`%%`), front matter and blanks dropped, with numbers. */
function statements(source: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let front = false;
  source.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (i === 0 && t === "---") front = true;
    else if (front) {
      if (t === "---") front = false;
    } else if (t && !t.startsWith("%%")) out.push({ n: i + 1, text: t });
  });
  return out;
}

const ARROW = /^(.+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)(.+?)\s*:\s*(.*)$/;

/** A sequence diagram: participants in order, and messages between them. */
export function drawSequence(source: string): Drawn {
  const names = new Map<string, string>();
  const order: string[] = [];
  const add = (id: string, label?: string) => {
    if (!names.has(id)) order.push(id);
    if (label || !names.has(id)) names.set(id, label ?? id);
  };
  const messages: { from: string; to: string; text: string; dashed: boolean }[] = [];
  for (const { text: t } of statements(source).slice(1)) {
    const p = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(t);
    if (p?.[2]) {
      add(p[2].trim(), p[3]?.trim());
      continue;
    }
    const m = ARROW.exec(t);
    if (m?.[1] && m[4] && m[2]) {
      const from = m[1].replace(/[+-]$/, "").trim();
      const to = m[4].trim();
      add(from);
      add(to);
      messages.push({ from, to, text: (m[5] ?? "").trim(), dashed: m[2].startsWith("--") });
    }
  }
  const GAP = 40;
  const colW = order.map((id) => Math.max(120, textWidth(names.get(id) ?? id, 14) + 32));
  const msgW = messages.map((m) => textWidth(m.text, 13) + 40);
  const xs: number[] = [];
  let x = 24;
  order.forEach((_, i) => {
    xs.push(x + (colW[i] ?? 120) / 2);
    const next = order[i + 1];
    const between = next
      ? Math.max(
          0,
          ...messages
            .map((m, k) => ({ m, w: msgW[k] ?? 0 }))
            .filter(
              ({ m }) =>
                (m.from === order[i] && m.to === next) || (m.from === next && m.to === order[i]),
            )
            .map(({ w }) => w),
        )
      : 0;
    x += Math.max((colW[i] ?? 120) + GAP, between + (colW[i] ?? 120) / 2);
  });
  const width = Math.max(x, 200) + 24;
  const top = 24;
  const head = 40;
  const rowH = 44;
  const height = top + head + 24 + messages.length * rowH + 24;
  const parts: DesignPart[] = [];
  let body = "";
  order.forEach((id, i) => {
    const cx = xs[i] ?? 0;
    const w = colW[i] ?? 120;
    body += `<path d="M${r1(cx)} ${top + head} V${height - 16}" stroke="${INK.line}" stroke-dasharray="4 4"/>`;
    body += rect(cx - w / 2, top, w, head, { fill: INK.card });
    body += text(cx, top + 25, names.get(id) ?? id, { size: 14, weight: 600, anchor: "middle" });
    parts.push({
      id: `participant ${id}`,
      kind: "participant",
      label: names.get(id) ?? id,
      sig: sig(names.get(id) ?? id),
      box: { x: cx - w / 2, y: top, w, h: head },
    });
  });
  const pairs = new Map<string, number>();
  messages.forEach((m, k) => {
    const a = xs[order.indexOf(m.from)] ?? 0;
    const b = xs[order.indexOf(m.to)] ?? 0;
    const y = top + head + 24 + k * rowH + 26;
    const route =
      a === b
        ? [
            { x: a, y: y - 8 },
            { x: a + 40, y: y - 8 },
            { x: a + 40, y: y + 8 },
            { x: a + 2, y: y + 8 },
          ]
        : [
            { x: a, y },
            { x: b + (b > a ? -2 : 2), y },
          ];
    body += path(route, { dashed: m.dashed });
    body += text((a + b) / 2 + (a === b ? 48 : 0), y - 8, m.text, {
      size: 13,
      anchor: a === b ? "start" : "middle",
    });
    const pair = `${m.from} -> ${m.to}`;
    const n = (pairs.get(pair) ?? 0) + 1;
    pairs.set(pair, n);
    const w = Math.max(Math.abs(b - a), 60);
    parts.push({
      id: `message ${pair}${n > 1 ? ` #${n}` : ""}`,
      kind: "message",
      label: m.text || pair,
      sig: sig([m.text, m.dashed]),
      box: { x: Math.min(a, b), y: y - 24, w, h: 32 },
    });
  });
  const warnings: DesignFinding[] = [];
  const small = readability({ w: width, h: height }, 13, [
    "Split the flow into one design per scenario (the happy path, then each failure)",
    "Leave out participants this plan doesn't change",
  ]);
  if (small) warnings.push(small);
  return { svg: svgDocument(width, height, body), width, height, parts, warnings };
}

/** A state diagram: states (composites flattened) and transitions, laid out in layers. */
export function drawState(source: string): Drawn {
  const labels = new Map<string, string>();
  const transitions: { from: string; to: string; label: string }[] = [];
  let direction: "TB" | "LR" = "TB";
  const node = (raw: string, side: "from" | "to") =>
    raw === "[*]" ? (side === "from" ? "[*] start" : "[*] end") : raw;
  for (const { text: t } of statements(source).slice(1)) {
    const dir = /^direction\s+(LR|RL|TB|BT)$/.exec(t);
    if (dir) {
      direction = dir[1] === "LR" || dir[1] === "RL" ? "LR" : "TB";
      continue;
    }
    const tr = /^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/.exec(t);
    if (tr?.[1] && tr[2]) {
      const from = node(tr[1], "from");
      const to = node(tr[2], "to");
      for (const s of [from, to]) if (!labels.has(s)) labels.set(s, s.startsWith("[*]") ? "" : s);
      transitions.push({ from, to, label: (tr[3] ?? "").trim() });
      continue;
    }
    const named = /^state\s+"([^"]+)"\s+as\s+([\w.-]+)/.exec(t);
    if (named?.[1] && named[2]) {
      labels.set(named[2], named[1]);
      continue;
    }
    const plain = /^state\s+([\w.-]+)/.exec(t);
    if (plain?.[1] && !labels.has(plain[1])) {
      labels.set(plain[1], plain[1]);
      continue;
    }
    const desc = /^([\w.-]+)\s*:\s*(.+)$/.exec(t);
    if (desc?.[1] && desc[2]) labels.set(desc[1], desc[2].trim());
  }
  const isEnd = (id: string) => id.startsWith("[*]");
  const placed = placeGraph(
    [...labels].map(([id, label]) => ({
      id,
      w: isEnd(id) ? 18 : Math.max(90, textWidth(label, 14) + 32),
      h: isEnd(id) ? 18 : 38,
    })),
    transitions.map((t, i) => ({
      id: `t${i}`,
      from: t.from,
      to: t.to,
      ...(t.label ? { label: { w: textWidth(t.label, 12) + 8, h: 18 } } : {}),
    })),
    { direction },
  );
  const parts: DesignPart[] = [];
  let body = "";
  const pairs = new Map<string, number>();
  let labelsOnTop = "";
  transitions.forEach((t, i) => {
    const e = placed.edges.get(`t${i}`);
    if (!e) return;
    body += path(e.points);
    if (t.label && e.label) {
      labelsOnTop += lineLabel(e.label.x, e.label.y + 4, t.label);
    }
    const pair = `${t.from} -> ${t.to}`;
    const n = (pairs.get(pair) ?? 0) + 1;
    pairs.set(pair, n);
    parts.push({
      id: `transition ${pair}${n > 1 ? ` #${n}` : ""}`,
      kind: "transition",
      label: t.label || pair,
      sig: sig(t.label),
      box: e.label ? { x: e.label.x - 30, y: e.label.y - 10, w: 60, h: 20 } : midBox(e.points),
    });
  });
  for (const [id, label] of labels) {
    const at = placed.nodes.get(id);
    if (!at) continue;
    if (isEnd(id)) {
      const cx = at.x + at.w / 2;
      const cy = at.y + at.h / 2;
      body +=
        id === "[*] start"
          ? `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="8" fill="${INK.ink}"/>`
          : `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="8" fill="none" stroke="${INK.ink}" stroke-width="1.5"/><circle cx="${r1(cx)}" cy="${r1(cy)}" r="4.5" fill="${INK.ink}"/>`;
      continue;
    }
    body += rect(at.x, at.y, at.w, at.h, { radius: 12 });
    body += text(at.x + at.w / 2, at.y + at.h / 2 + 5, label, { size: 14, anchor: "middle" });
    parts.push({ id: `state ${id}`, kind: "state", label, sig: sig(label), box: at });
  }
  body += labelsOnTop;
  const warnings: DesignFinding[] = [];
  const small = readability({ w: placed.width, h: placed.height }, 12, [
    "Split it: one design per composite state, and keep the overview to the top level",
    "Try `direction LR`",
  ]);
  if (small) warnings.push(small);
  return {
    svg: svgDocument(placed.width, placed.height, body),
    width: placed.width,
    height: placed.height,
    parts,
    warnings,
  };
}
