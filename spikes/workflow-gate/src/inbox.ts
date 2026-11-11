// The inbox: pending gates with Approve/Reject, work items, the preset and the kill switch.
// Plain server-rendered HTML for the spike; the real one is TanStack Start + shadcn (docs/ui-plan.md).
import { readSettings } from "./ops/invoke";

interface PendingRow {
  id: string;
  operation: string;
  risk: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
  work_item_id: string | null;
  title: string | null;
}

interface WorkItemRow {
  id: string;
  title: string;
  source: string;
  size: string | null;
  stage: string;
  status: string;
  updated_at: string;
}

export async function listPending(db: D1Database): Promise<PendingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.operation, p.risk, p.actor_type, p.actor_id, p.created_at, p.work_item_id, w.title
       FROM pending_actions p LEFT JOIN work_items w ON w.id = p.work_item_id
       WHERE p.status = 'pending' AND (w.status IS NULL OR w.status = 'running')
       ORDER BY p.created_at`,
    )
    .all<PendingRow>();
  return results;
}

export async function renderInbox(db: D1Database, flash?: string): Promise<string> {
  const [pending, items, settings] = await Promise.all([
    listPending(db),
    db
      .prepare(
        `SELECT id, title, source, size, stage, status, updated_at FROM work_items ORDER BY created_at DESC LIMIT 50`,
      )
      .all<WorkItemRow>()
      .then((r) => r.results),
    readSettings(db),
  ]);

  const gateLabel = (op: string) =>
    op === "spec.accept" ? "Spec" : op === "pr.merge" ? "Merge" : op;

  const pendingHtml =
    pending.length === 0
      ? `<p class="muted">Nothing needs you.</p>`
      : pending
          .map(
            (p) => `
      <div class="card ring">
        <div class="row"><span class="dot waiting"></span><strong>${esc(gateLabel(p.operation))} gate</strong>
          <span class="badge">${esc(p.risk)}</span><span class="muted">${esc(p.created_at)}</span></div>
        <div>${esc(p.title ?? "(no work item)")}</div>
        <div class="muted small">${esc(p.operation)} requested by ${esc(p.actor_type)}:${esc(p.actor_id)} · ${esc(p.id)}</div>
        <form method="post" action="/approvals/${esc(p.id)}" class="row">
          <input name="note" placeholder="Note (optional)">
          <button name="decision" value="approved" class="primary">Approve</button>
          <button name="decision" value="rejected">Reject</button>
        </form>
      </div>`,
          )
          .join("");

  const itemsHtml = items
    .map(
      (w) => `<tr><td><span class="dot ${statusDot(w.status)}"></span>${esc(w.status)}</td>
        <td>${esc(w.title)}</td><td>${esc(w.stage)}</td><td>${esc(w.size ?? "–")}</td>
        <td class="muted">${esc(w.source)}</td><td class="muted">${esc(w.updated_at)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory inbox</title>
<style>
  :root { --bg:#fff; --fg:#09090b; --muted:#71717a; --border:#e4e4e7; --card:#fff; --ring:#18181b;
    --waiting:#f59e0b; --running:#3b82f6; --done:#22c55e; --failed:#ef4444; --idle:#a1a1aa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#09090b; --fg:#fafafa; --muted:#a1a1aa;
    --border:#27272a; --card:#18181b; --ring:#fafafa; } }
  body { background:var(--bg); color:var(--fg); font:14px/1.5 Geist, ui-sans-serif, system-ui, sans-serif;
    max-width:880px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:20px; } h2 { font-size:15px; margin-top:28px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin:8px 0; }
  .ring { box-shadow:0 0 0 1px var(--ring); }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .muted { color:var(--muted); } .small { font-size:12px; }
  .badge { border:1px solid var(--border); border-radius:999px; padding:0 8px; font-size:12px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:var(--idle); }
  .dot.waiting { background:var(--waiting); } .dot.running { background:var(--running); }
  .dot.done { background:var(--done); } .dot.failed { background:var(--failed); }
  button, input, select { font:inherit; color:inherit; background:var(--card); border:1px solid var(--border);
    border-radius:6px; padding:4px 10px; }
  button.primary { background:var(--fg); color:var(--bg); border-color:var(--fg); }
  table { width:100%; border-collapse:collapse; } td { border-top:1px solid var(--border); padding:6px 4px; }
  .flash { border-left:3px solid var(--waiting); padding-left:8px; }
</style></head>
<body>
  <h1>Inbox</h1>
  ${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
  <div class="row muted small">
    <form method="post" action="/preset" class="row">Preset
      <select name="preset">${["cautious", "balanced", "autonomous"]
        .map((p) => `<option${p === settings.preset ? " selected" : ""}>${p}</option>`)
        .join("")}</select><button>Set</button></form>
    <form method="post" action="/kill-switch" class="row">Kill switch: <strong>${settings.killSwitch ? "ON" : "off"}</strong>
      <button name="on" value="${settings.killSwitch ? "0" : "1"}">${settings.killSwitch ? "Turn off" : "Stop everything"}</button></form>
  </div>
  <h2>Needs you (${pending.length})</h2>
  ${pendingHtml}
  <h2>New work</h2>
  <form method="post" action="/intake" class="card row">
    <input name="title" placeholder="Title" required style="flex:1">
    <select name="size"><option value="large">needs a spec</option><option value="small">small</option></select>
    <button class="primary">Add</button>
  </form>
  <h2>Work items</h2>
  <table>${itemsHtml || `<tr><td class="muted">None yet.</td></tr>`}</table>
</body></html>`;
}

function statusDot(status: string) {
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed" || status === "rejected") return "failed";
  return "idle";
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
