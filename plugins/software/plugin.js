// The software plugin: pull requests for the items of a project with a GitHub repository.
// - When an agent's run ends `done` and has pushed the item's branch, it opens a pull request from
//   that branch into the default branch (unless one is open), keeps its number in the item's `pr`
//   field, and adds a card with the pull request, its size and its checks.
// - An item can't leave a status whose name has "review" in it while a check on the pull request's
//   head has failed or is still running.
// - When an item enters "Merged" or "Shipped", its open pull request is merged (a merge commit).
// Everything goes through the built-in `github` gateway, on the repository of the item's project.

const FAILED = ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"];

async function gh(ctx, path, init) {
  const res = await ctx.gateway("github").fetch(path, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

function why(res) {
  const message = res.body && typeof res.body === "object" ? res.body.message : res.body;
  return `GitHub said ${res.status}${message ? `: ${message}` : ""}`;
}

async function pull(ctx, number) {
  const res = await gh(ctx, `/pulls/${number}`);
  if (!res.ok) throw new Error(`Couldn't read pull request #${number}. ${why(res)}`);
  return res.body;
}

async function checksOn(ctx, sha) {
  const res = await gh(ctx, `/commits/${sha}/check-runs?per_page=100`);
  if (!res.ok) throw new Error(`Couldn't read the checks on ${sha.slice(0, 7)}. ${why(res)}`);
  return res.body.check_runs.map((c) => ({
    name: c.name,
    running: c.status !== "completed",
    failed: c.status === "completed" && FAILED.includes(c.conclusion),
  }));
}

async function card(ctx, pr) {
  const checks = await checksOn(ctx, pr.head.sha);
  await ctx.card({
    kind: "pull-request",
    title: `#${pr.number} ${pr.title}`,
    subtitle: `+${pr.additions} −${pr.deletions}`,
    checks: checks.map((c) => ({
      label: c.running ? `${c.name} (running)` : c.name,
      ok: !c.running && !c.failed,
    })),
    link: { label: "Open on GitHub", url: pr.html_url },
  });
}

export default {
  fields: [{ id: "pr", label: "Pull request", type: "number" }],
  on: {
    async runEnded(ctx, { item, run }) {
      if (run.outcome !== "done" || !item.repo || !item.branch || !item.headSha) return;
      const open = await gh(
        ctx,
        `/pulls?state=open&head=${encodeURIComponent(`${item.repo.owner}:${item.branch}`)}`,
      );
      if (!open.ok) throw new Error(`Couldn't list the pull requests. ${why(open)}`);
      let number = open.body[0]?.number;
      if (number === undefined) {
        const made = await gh(ctx, "/pulls", {
          method: "POST",
          body: {
            title: item.title,
            head: item.branch,
            base: item.repo.defaultBranch,
            body: `${run.summary}\n\nFor item #${item.number}: ${item.title}`,
          },
        });
        if (!made.ok) throw new Error(`Couldn't open a pull request. ${why(made)}`);
        number = made.body.number;
      }
      await ctx.setField("pr", number);
      await card(ctx, await pull(ctx, number));
    },

    async leaving(ctx, { item, fromName }) {
      if (!/review/i.test(fromName ?? "") || typeof item.fields.pr !== "number") return;
      const pr = await pull(ctx, item.fields.pr);
      const checks = await checksOn(ctx, pr.head.sha);
      const failed = checks.filter((c) => c.failed).map((c) => c.name);
      const running = checks.filter((c) => c.running).map((c) => c.name);
      if (failed.length === 0 && running.length === 0) return;
      const said = [];
      if (failed.length) said.push(`failed: ${failed.join(", ")}`);
      if (running.length) said.push(`still running: ${running.join(", ")}`);
      return { refuse: `The pull request's checks haven't passed (${said.join("; ")}).` };
    },

    async entered(ctx, { item, toName }) {
      if (!/^(merged|shipped)$/i.test(toName.trim()) || typeof item.fields.pr !== "number") return;
      const pr = await pull(ctx, item.fields.pr);
      if (pr.state !== "open" || pr.merged) return;
      const merged = await gh(ctx, `/pulls/${pr.number}/merge`, {
        method: "PUT",
        body: { merge_method: "merge", sha: pr.head.sha },
      });
      if (!merged.ok) throw new Error(`Couldn't merge #${pr.number}. ${why(merged)}`);
      await ctx.card({
        kind: "pull-request",
        title: `Merged #${pr.number} ${pr.title}`,
        subtitle: `into ${pr.base.ref}`,
        link: { label: "Open on GitHub", url: pr.html_url },
      });
    },
  },
};
