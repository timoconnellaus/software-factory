# @software-factory/evals

The factory's improvement loop (V1 scope, ADR 0027, ADR 0230): the format of a project's own
static checks (`.factory/checks/`), the regression case every factory incident adds
(`evals/regressions/`), and the suite CI runs over both. Benchmarks of autonomy policies, model
roles and harnesses come later.

## `.factory/checks/<name>.json`

```json
{
  "name": "no-console-log",
  "description": "Why this check exists.",
  "appliesTo": ["apps/**/src/**/*.ts"],
  "exclude": ["**/testing/**"],
  "forbid": ["^\\s*console\\.log\\("],
  "require": [],
  "message": "What to do when it fails."
}
```

`appliesTo`/`exclude` are globs (`*` within a segment, `**` across segments). `forbid` patterns
must not match a file; `require` patterns must. Patterns are JavaScript regexes, multiline.
`test/regressions.test.ts` runs every check over the repo on each CI run, so a check is enforced
from the commit that adds it, and `factory/verify` (which reads CI) can't pass while one fails.

## `evals/regressions/<incident id>.json`

```json
{
  "incident": "inc_…",
  "rootCause": "missing-check",
  "summary": "What slipped through.",
  "check": "no-console-log",
  "cases": [
    { "path": "apps/engine/src/outbox.ts", "content": "console.log('here')", "expect": "fail" },
    { "path": "apps/engine/src/outbox.ts", "content": "console.error('x', id)", "expect": "pass" }
  ]
}
```

At least one case must fail (the input that slipped through); passing cases keep the check from
flagging everything. Root causes are the core's classes (`packages/core/src/incidents/classify.ts`):
`missing-check`, `prompt-or-skill`, `missing-context`, `policy`, `runner`, `confinement`, `unknown`.
`fixtures/` holds a worked example.

## Auto-merge

An incident fix that only **adds** files under `.factory/checks/` and `evals/regressions/` (with at
least one regression case) merges without a person once CI, which runs this suite, and
`factory/verify` are green on its head, if the project opts in (`"overrides": { "agent":
{ "check-merge": "allow" } }` in `.factory/policy.json`). See ADR 0230.
