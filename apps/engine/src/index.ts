// sf-engine: one Workflow per work item, the signed runner channel, the GitHub App webhook, outbox
// delivery, the minute cron and the runner host's web terminal socket (ADR 0440). sf-app calls operations through the `EngineApi` RPC entrypoint (service binding).

import { GITHUB_INTAKE } from "@software-factory/connector-github";
import {
  BABYSITTER,
  FOREMAN,
  invoke,
  isOperationError,
  PROTECTION_RECHECK_MS,
  parseProjectPolicy,
  REVERT_AFTER_MS,
  r2AttachmentBlobs,
  sweepStrayAttachmentBlobs,
} from "@software-factory/core";
import { parseTerminalPath } from "@software-factory/runner-contract";
import { archiveAudit } from "./audit-archive.ts";
import { CHANNEL_PREFIX, handleChannel, pruneChannelStore } from "./channel.ts";
import { CLI_PREFIX, CLIENT_PREFIX, handleCli } from "./cli.ts";
import { deliverDue } from "./deliver/deliverer.ts";
import { invokeDeps } from "./deps.ts";
import { retryOutbox } from "./outbox.ts";
import { pullQueuedWork } from "./pull.ts";
import { pruneReconcileShadow, shadowPass } from "./reconcile-shadow.ts";
import { archiveRunEvents, archiveStatus, pruneExpired, sampleArchive } from "./retention.ts";
import { terminalRelay } from "./terminal-relay.ts";
import { handleGitHubWebhook, WEBHOOK_PATH } from "./webhooks.ts";

export { ClientHub } from "./client-hub.ts";
export { EngineApi } from "./rpc.ts";
export { TerminalRelay } from "./terminal-relay.ts";
export { WorkItemWorkflow } from "./workflow/work-item.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "sf-engine" });
    }
    if (url.pathname.startsWith(CHANNEL_PREFIX)) return handleChannel(request, env);
    // The runner host's web terminal socket (ADR 0440), with the one-use ticket the channel's held
    // `terminal` call gave it. Viewers' sockets are only reachable through EngineApi (the binding).
    const terminal = parseTerminalPath(url.pathname);
    // The job line (spec 44 part B, ADR 0592) is the host's too, with a ticket from the `line` call.
    if (terminal?.role === "host" || terminal?.role === "line") {
      return terminalRelay(env, terminal.jobId).fetch(request);
    }
    if (url.pathname.startsWith(CLI_PREFIX) || url.pathname.startsWith(CLIENT_PREFIX)) {
      return handleCli(request, env);
    }
    if (url.pathname === WEBHOOK_PATH) return handleGitHubWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    await retryOutbox(env, now);
    await expireQuietRuns(env, now);
    await pruneChannelStore(env.DB, now);
    await recheckProtection(env, now);
    await pullQueuedWork(env);
    // The babysitter's deliverer, for queues due a look without an event (spec 53).
    await deliverDue(env, now);
    await runAdjudicator(env);
    // Once an hour: the improver (ADR 0373) decides running trials and starts the next one.
    if (now.getUTCMinutes() === 23) await runImprover(env, now);
    // Every five minutes: the shadow reconciler reads the items that ended since its cursor (spec 52
    // PR (c)), off the Workflow's path; a failure here only delays the next pass.
    if (now.getUTCMinutes() % 5 === 0) {
      try {
        await shadowPass(env, now);
      } catch (error) {
        console.error("shadow pass failed", error);
      }
    }
    // Once an hour: the shadow reconciler's old verdicts (spec 52 PR (c)), a bounded batch, on a
    // minute of its own so it doesn't add to retention's tick.
    if (now.getUTCMinutes() === 47) await pruneReconcileShadow(env, now);
    // Retention (AGENTS.md "Cloudflare cost", rule 3): every minute, a budgeted slice of the
    // oldest ended runs' events goes to R2; once an hour, expired rows go in bounded batches.
    await archiveRunEvents(env, now);
    // Every five minutes (offset from the shadow pass): machine audit rows older than 90 days go
    // to R2 as a hash chain, a day at a time (ADR 0590, 0591); a failure only delays the next tick.
    if (now.getUTCMinutes() % 5 === 2) {
      try {
        await archiveAudit(env, now);
      } catch (error) {
        console.error("audit archive failed", error);
      }
    }
    // Once a day: the archive's expected drain time, and a few archived objects checked with a
    // HEAD, so a lost one opens its incident without waiting for someone to look.
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 43) {
      await archiveStatus(env.DB, now);
      await sampleArchive(env, now);
    }
    if (now.getUTCMinutes() === 41) {
      await pruneExpired(env.DB, now);
      // And check results of items that ended more than 30 days ago (ADR 0501).
      await pruneCheckResults(env.DB, now);
      // And the babysitter's reruns and known flakes older than 30 days (spec 53 §4).
      await pruneBabysit(env.DB, now);
    }
    // Every minute: `factory/verify` held while main was red, on a head whose repository is green
    // again or whose item ended, is evaluated again (decision 7; heals a lost verify.recheck).
    await releaseHeldChecks(env);
    // And a red main's repair: the engine's revert of a proven or person-named culprit once the
    // episode is 30 minutes old, then the reland item once a revert has merged (spec 53 §5).
    await repairRedMain(env, now);
    // Once an hour: attachment blobs whose upload never got its row (ADR 0310).
    if (now.getUTCMinutes() === 17) {
      await sweepStrayAttachmentBlobs(env.DB, r2AttachmentBlobs(env.ATTACHMENTS), now);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Decision 7's release sweep: up to `limit` held `factory/verify` checks (core_verify_checks_held_idx,
 * partial: only held rows) whose repository is no longer red or whose item has ended, each
 * evaluated again with verify.refresh. Idempotent: one that stays held stays held.
 */
export async function releaseHeldChecks(env: Env, limit = 20, now = new Date()): Promise<number> {
  const t = now.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT v.project_id, v.head_sha, v.pr_number, v.release_attempts, r.owner, r.name
     FROM core_verify_checks v
     JOIN core_work_items w ON w.id = v.work_item_id
     JOIN core_repositories r ON r.id = w.repository_id
     LEFT JOIN core_main_health h ON h.repository_id = r.id
     WHERE v.held_at IS NOT NULL AND (v.release_after IS NULL OR v.release_after <= ?1)
       AND (h.red_since IS NULL OR w.status NOT IN ('running', 'waiting', 'paused'))
     ORDER BY v.release_after
     LIMIT ?2`,
  )
    .bind(t, limit)
    .all<{
      project_id: string;
      head_sha: string;
      pr_number: number | null;
      release_attempts: number;
      owner: string;
      name: string;
    }>();
  for (const r of results) {
    try {
      await invoke(
        invokeDeps(env),
        "verify.refresh",
        {
          repo: { owner: r.owner, name: r.name },
          headSha: r.head_sha,
          prNumber: r.pr_number,
          trigger: "rerequested",
        },
        { actor: BABYSITTER, origin: { surface: "cron", step: "release held" } },
      );
    } catch (error) {
      console.error(`release held ${r.head_sha} failed`, error);
    }
    // Still held (verify.refresh threw, or left it held): back off, 2^n minutes up to an hour, so
    // one that keeps failing goes to the back and never starves the rest. A released row (held_at
    // null) isn't touched.
    const wait = Math.min(60, 2 ** Math.min(r.release_attempts + 1, 6)) * 60_000;
    await env.DB.prepare(
      `UPDATE core_verify_checks SET release_attempts = release_attempts + 1, release_after = ?
       WHERE project_id = ? AND head_sha = ? AND held_at IS NOT NULL`,
    )
      .bind(new Date(now.getTime() + wait).toISOString(), r.project_id, r.head_sha)
      .run();
  }
  return results.length;
}

/**
 * Spec 53 §5, decisions 2 and 5, from the minute cron. Reads core_main_health (one row per
 * repository) for episodes 30 minutes old whose culprit is proven or named by a person and not yet
 * reverted, and core_reverts_reland_idx (partial: reverts with no reland) for merged reverts; each
 * at most 10, each acted on through its operation as the babysitter (which re-checks everything).
 */
export async function repairRedMain(env: Env, now = new Date(), limit = 10): Promise<number> {
  const due = new Date(now.getTime() - REVERT_AFTER_MS).toISOString();
  const [culprits, merged, ended] = await env.DB.batch([
    env.DB.prepare(
      `SELECT h.culprit_work_item_id AS id FROM core_main_health h
       WHERE h.red_since IS NOT NULL AND h.red_since <= ?1
         AND h.culprit_work_item_id IS NOT NULL AND h.attributed_by IN ('proven', 'person')
         AND NOT EXISTS (SELECT 1 FROM core_reverts r
           WHERE r.original_work_item_id = h.culprit_work_item_id AND r.red_since = h.red_since
             AND (r.status NOT IN ('claimed', 'calling') OR r.lease_until > ?3))
       LIMIT ?2`,
    ).bind(due, limit, now.toISOString()),
    env.DB.prepare(
      `SELECT r.revert_work_item_id AS id FROM core_reverts r
       CROSS JOIN core_work_items w ON w.id = r.revert_work_item_id
       WHERE r.status = 'opened' AND w.status = 'done'
       ORDER BY r.created_at LIMIT ?1`,
    ).bind(limit),
    // A revert whose item ended without merging: closed on GitHub, then it leaves the open index.
    env.DB.prepare(
      `SELECT r.revert_work_item_id AS id FROM core_reverts r
       CROSS JOIN core_work_items w ON w.id = r.revert_work_item_id
       WHERE r.status = 'opened' AND w.status IN ('cancelled', 'failed', 'rejected')
       ORDER BY r.created_at LIMIT ?1`,
    ).bind(limit),
  ]);
  const act = async (op: string, id: string, extra: Record<string, unknown> = {}) => {
    try {
      const r = await invoke(
        invokeDeps(env),
        op,
        { workItemId: id, ...extra },
        {
          actor: BABYSITTER,
          origin: { surface: "cron", step: op },
        },
      );
      return r.status === "ok" ? (r.output as { status?: string; attempt?: number | null }) : null;
    } catch (error) {
      if (!isOperationError(error)) console.error(`${op} ${id} failed`, error);
      return null;
    }
  };
  const c = (culprits?.results ?? []) as { id: string }[];
  const m = (merged?.results ?? []) as { id: string }[];
  const e = (ended?.results ?? []) as { id: string }[];
  for (const r of c) {
    // Claim, take the lease, then ask GitHub with it: each committed before the next.
    let step = await act("mainRed.revert", r.id);
    if (step?.status === "claimed") step = await act("mainRed.revert", r.id);
    // With the lease: GitHub's answer is committed first, then the item is made from it.
    for (let k = 0; k < 2 && step?.status === "calling" && step.attempt; k++) {
      step = await act("mainRed.revert", r.id, { attempt: step.attempt });
    }
  }
  for (const r of m) await act("mainRed.reland", r.id);
  for (const r of e) await act("mainRed.closeRevert", r.id);
  return c.length + m.length + e.length;
}

/** How long the babysitter keeps its reruns and known flakes (spec 53, decision 3's 14 days, with room). */
export const BABYSIT_KEEP_DAYS = 30;

/**
 * Hourly: the babysitter's flake reruns and known flakes older than BABYSIT_KEEP_DAYS, oldest first,
 * at most `limit` of each (core_ci_reruns_asked_idx and core_flakes_seen_idx, migration 0390).
 */
export async function pruneBabysit(db: D1Database, now: Date, limit = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - BABYSIT_KEEP_DAYS * 86_400_000).toISOString();
  const [reruns, flakes, resolutions] = await db.batch([
    db
      .prepare(
        `DELETE FROM core_ci_reruns WHERE rowid IN
           (SELECT rowid FROM core_ci_reruns WHERE asked_at < ? ORDER BY asked_at LIMIT ?)`,
      )
      .bind(cutoff, limit),
    db
      .prepare(
        `DELETE FROM core_flakes WHERE id IN
           (SELECT id FROM core_flakes WHERE seen_at < ? ORDER BY seen_at LIMIT ?)`,
      )
      .bind(cutoff, limit),
    // A resolution is kept while its item is open (the gate shows it), then goes. One row per
    // item that had one: a handful, read through the primary key's join.
    db
      .prepare(
        `DELETE FROM core_babysit_resolutions WHERE work_item_id IN
           (SELECT r.work_item_id FROM core_babysit_resolutions r
            CROSS JOIN core_work_items w ON w.id = r.work_item_id
            WHERE w.status NOT IN ('running', 'waiting', 'paused', 'queued', 'shaping', 'ready', 'backlog')
            LIMIT ?)`,
      )
      .bind(limit),
  ]);
  return (
    (reruns?.meta.changes ?? 0) + (flakes?.meta.changes ?? 0) + (resolutions?.meta.changes ?? 0)
  );
}

/** How long the factory's check results outlive their item (ADR 0501, fourth review). */
export const CHECK_RESULTS_KEEP_DAYS = 30;

/** Where the check results prune got to: `<created_at> <rowid>` of the last row it read. */
const CHECK_PRUNE_CURSOR = "check_results_prune_after";

/**
 * The factory's check results are evidence for the merge gate (ADR 0501): kept while their item is
 * open, and for CHECK_RESULTS_KEEP_DAYS after it ends (done, failed, rejected, cancelled). Hourly
 * (fifth review: rows read bounded by `limit`, never by how many items have finished):
 *   1. the next `limit` rows older than the cutoff, by `created_at` then rowid, after the cursor in
 *      core_meta (`core_check_results_created_idx`, migration 0272; LIMIT);
 *   2. their items, as primary-key lookups in one batch (`json_each`);
 *   3. delete the rows whose item ended before the cutoff (rowid lookups);
 *   4. move the cursor past the rows read, or back to the start once it reached the end, so old rows
 *      of items still open are passed over, not read again every hour.
 * Returns how many went.
 */
export async function pruneCheckResults(db: D1Database, now: Date, limit = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - CHECK_RESULTS_KEEP_DAYS * 86_400_000).toISOString();
  const cursor = await db
    .prepare("SELECT value FROM core_meta WHERE key = ?")
    .bind(CHECK_PRUNE_CURSOR)
    .first<{ value: string }>();
  const [afterAt = "", afterRow = "0"] = (cursor?.value ?? "").split(" ");
  const { results: rows } = await db
    .prepare(
      `SELECT rowid AS id, work_item_id, created_at FROM core_check_results
       WHERE created_at < ?1 AND (created_at, rowid) > (?2, ?3)
       ORDER BY created_at, rowid
       LIMIT ?4`,
    )
    .bind(cutoff, afterAt, Number(afterRow), limit)
    .all<{ id: number; work_item_id: string; created_at: string }>();
  const last = rows.at(-1);
  // The end of the old rows: start from the oldest again next time.
  const next = rows.length < limit || !last ? "" : `${last.created_at} ${last.id}`;
  const statements: D1PreparedStatement[] = [];
  let deleted = 0;
  if (rows.length > 0) {
    const ids = [...new Set(rows.map((r) => r.work_item_id))];
    const { results: ended } = await db
      .prepare(
        // CROSS JOIN keeps the order: a primary-key lookup per id, never core_work_items_status_idx
        // (every finished item).
        `SELECT w.id FROM json_each(?1) j CROSS JOIN core_work_items w ON w.id = j.value
         WHERE w.status IN ('done', 'failed', 'rejected', 'cancelled') AND w.updated_at < ?2`,
      )
      .bind(JSON.stringify(ids), cutoff)
      .all<{ id: string }>();
    const gone = new Set(ended.map((e) => e.id));
    const doomed = rows.filter((r) => gone.has(r.work_item_id)).map((r) => r.id);
    deleted = doomed.length;
    if (doomed.length > 0) {
      statements.push(
        db
          .prepare("DELETE FROM core_check_results WHERE rowid IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(doomed)),
      );
    }
  }
  if (next !== (cursor?.value ?? "")) {
    statements.push(
      db
        .prepare(
          "INSERT INTO core_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2",
        )
        .bind(CHECK_PRUNE_CURSOR, next),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return deleted;
}

/**
 * Runs whose lease expired (the runner stopped heartbeating) are failed through `run.expire`, which
 * bumps the fencing token and wakes the Workflow (ADR 0035).
 */
export async function expireQuietRuns(env: Env, now: Date): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT r.job_id FROM core_runs r JOIN core_leases l ON l.work_item_id = r.work_item_id AND l.holder_id = r.id
     WHERE r.status IN ('claimed', 'preparing', 'running', 'collecting') AND l.expires_at < ? LIMIT 50`,
  )
    .bind(now.toISOString())
    .all<{ job_id: string }>();
  for (const { job_id } of results) {
    try {
      await invoke(
        invokeDeps(env),
        "run.expire",
        { jobId: job_id, reason: "lease expired: no heartbeat" },
        {
          actor: FOREMAN,
          origin: { surface: "cron" },
        },
      );
    } catch (error) {
      if (!isOperationError(error)) throw error;
      console.warn(`expire ${job_id}: ${error.code} ${error.message}`);
    }
  }
  return results.length;
}

/**
 * The daily re-check of each project's default-branch protection (ADR 0280), a few projects a
 * minute: drift the webhooks missed (an org ruleset, an event the App isn't subscribed to) still
 * turns Setup red. Runs as the GitHub intake, like a webhook would.
 */
export async function recheckProtection(env: Env, now: Date, limit = 5): Promise<number> {
  const before = new Date(now.getTime() - PROTECTION_RECHECK_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT r.owner AS repo_owner, r.name AS repo_name FROM core_projects p
     JOIN core_repositories r ON r.id = (
       SELECT id FROM core_repositories WHERE project_id = p.id ORDER BY created_at, id LIMIT 1)
     LEFT JOIN core_project_protection x ON x.project_id = p.id
     WHERE r.installation_record_id IS NOT NULL AND (x.checked_at IS NULL OR x.checked_at < ?)
     ORDER BY x.checked_at LIMIT ?`,
  )
    .bind(before, limit)
    .all<{ repo_owner: string; repo_name: string }>();
  for (const p of results) {
    try {
      await invoke(
        invokeDeps(env),
        "protection.observe",
        { repo: { owner: p.repo_owner, name: p.repo_name }, event: "daily", action: "recheck" },
        { actor: GITHUB_INTAKE, origin: { surface: "cron" } },
      );
    } catch (error) {
      if (!isOperationError(error)) throw error;
      console.warn(`protection ${p.repo_owner}/${p.repo_name}: ${error.code} ${error.message}`);
    }
  }
  return results.length;
}

/** The improver's actor (ADR 0373): a practice change is its own, never a person's. */
export const IMPROVER = { type: "self-improve" as const, id: "improver" };

/**
 * One improver pass (ADR 0373, spec 09 M3) over projects with self-improvement on: resolve each
 * running trial (promote, disable or keep waiting), then start the drafted practice change, if
 * any. A step the gate holds for review becomes an inbox approval for a person.
 */
export async function runImprover(env: Env, _now?: Date): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, pp.raw FROM core_projects p
     JOIN core_project_policies pp ON pp.project_id = p.id AND pp.sha = p.policy_sha
     WHERE pp.valid = 1 AND pp.raw LIKE '%"improve"%'`,
  ).all<{ id: string; raw: string }>();
  const deps = invokeDeps(env);
  const opts = { actor: IMPROVER, origin: { surface: "cron" as const } };
  let acted = 0;
  for (const p of results) {
    const parsed = parseProjectPolicy(p.raw);
    if (!parsed.ok || !parsed.policy.improve.enabled) continue;
    try {
      const scan = (await invoke(deps, "improve.scan", { projectId: p.id }, opts)) as {
        status: string;
        output?: {
          running: { id: string }[];
          candidate: { kind: string; summary: string; evidence: unknown; policy: unknown } | null;
          baseVersion: number;
        };
      };
      for (const t of scan.output?.running ?? []) {
        await invoke(deps, "config.trial.resolve", { projectId: p.id, trialId: t.id }, opts);
        acted++;
      }
      const c = scan.output?.candidate;
      if (c && scan.output) {
        await invoke(
          deps,
          "config.trial.start",
          {
            projectId: p.id,
            baseVersion: scan.output.baseVersion,
            kind: c.kind,
            summary: c.summary,
            evidence: c.evidence,
            policy: c.policy,
          },
          { ...opts, idempotencyKey: `improver:${p.id}:${scan.output.baseVersion}:${c.summary}` },
        );
        acted++;
      }
    } catch (error) {
      if (!isOperationError(error)) throw error;
      console.warn(`improver ${p.id}: ${error.code} ${error.message}`);
    }
  }
  return acted;
}

/**
 * The adjudicator's minute (ADR 0374, spec 09 M4): ask it about new open spec gates and gate steps
 * in projects that enable it, then record the verdicts of its finished jobs (approving, in active
 * mode, when it has earned it). A few of each per tick.
 */
export async function runAdjudicator(env: Env, limit = 10): Promise<number> {
  const deps = invokeDeps(env);
  const opts = { actor: IMPROVER, origin: { surface: "cron" as const } };
  const asks = await env.DB.prepare(
    `SELECT pa.id FROM core_pending_actions pa
     JOIN core_projects p ON p.id = pa.project_id
     JOIN core_project_policies pp ON pp.project_id = p.id AND pp.sha = p.policy_sha
     LEFT JOIN core_adjudications a ON a.pending_action_id = pa.id
     WHERE pa.status = 'pending' AND a.id IS NULL AND pa.work_item_id IS NOT NULL
       AND ((pa.kind = 'spec' AND pa.operation = 'spec.accept') OR pa.operation = 'workflow.gate')
       AND pp.raw LIKE '%"adjudicator"%'
     ORDER BY pa.created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  const verdicts = await env.DB.prepare(
    `SELECT a.pending_action_id AS id FROM core_adjudications a
     JOIN core_jobs j ON j.id = a.job_id
     WHERE a.verdict IS NULL AND (j.status IN ('done', 'failed', 'cancelled')
       OR EXISTS (SELECT 1 FROM core_runs r WHERE r.job_id = j.id AND r.status IN ('handed_back', 'failed', 'cancelled')))
     ORDER BY a.created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  let n = 0;
  for (const [op, rows] of [
    ["adjudicator.request", asks.results],
    ["adjudicator.record", verdicts.results],
  ] as const) {
    for (const { id } of rows) {
      try {
        await invoke(deps, op, { pendingActionId: id }, opts);
        n++;
      } catch (error) {
        if (!isOperationError(error)) throw error;
        console.warn(`${op} ${id}: ${error.code} ${error.message}`);
      }
    }
  }
  return n;
}
