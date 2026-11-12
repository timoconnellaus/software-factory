# Guidance: build runs, the job sandbox and tests

From incident `inc_5a1729a24403429d87e22d72d6bc502c` (work item #8, "Fix the date-dependent
'rate-limited until' test"). Applies to every build and verify run, and to any test in the repo.
It sits beside [`runner-adapters.md`](runner-adapters.md), which covers how the runner starts the harness.

## What happened

#8's second attempt committed a correct fix: the test pins the clock to local noon. The third attempt
had nothing left to change, so it made no commit. The run then counted as a failure ("I made no new
commit this attempt"). The full suite it had to run also failed: two `packages/harness-claude` tests
can't pass inside the job sandbox. One execs `ps`, which gets EPERM. The other pushes to a real
github.com remote, which the network proxy stops before git reaches the credentials error the test
expects. After three attempts the run gave up, though the work was done.

## A build run whose fix is already committed reports it

- If the branch already holds a commit that meets the acceptance criteria (from an earlier attempt),
  the build run **reports that commit as its result**, naming the SHA and saying which criteria it
  meets. It must not end with "no commit" and count as a failed run.
- It reports every test failure it believes the sandbox caused, separately from failures in the change:
  the package and test, the exact error (`EPERM` from `ps`, a proxy refusal), and why it doesn't touch
  the changed files. Verify and the reviewer decide whether those failures block. The build
  doesn't hide them, and doesn't count them as its own.
- It never "fixes" a sandbox-blocked failure by weakening the sandbox, by skipping the test without
  saying so, or by making an empty commit to look like progress.

## Tests must run inside the sandbox

Every test runs in the job sandbox, on whatever date and in whatever time zone the runner has.
`tests-are-hermetic.json` enforces the parts a regex can see:

- No `ps` or other live process-table reads: inject a `ReadCommand` (or a stub) instead.
- No push, fetch or clone against a real remote: use a local bare repo (`git init --bare` in a temp
  dir) or a `file://` URL, or inject the dependency.
- A test that reads the real clock and checks a local time or date pins it with `vi.useFakeTimers()`
  and `vi.setSystemTime(...)`, and restores real timers afterwards.

The check excludes two files for now, each with a reason in the check's description:
`packages/harness-claude/test/harness.test.ts` (the `ps` and `git push` tests that caused this) and
`apps/app/test/lib.test.ts` (#8's own test, still unfixed on `main`). Fixing them changes existing
tests, which an add-only incident fix (ADR 0230) can't do. A person, or #8's next run, rewrites them
and removes each exclude.

## A person decides about placement

Whether a runner placement's `requires` in `.factory/policy.json` should list the sandbox's limits
(no `ps`, network only through the proxy), so that work needing them goes to a runner that has them,
is a policy change. Agents don't make it (AGENTS.md: policy isn't AI-configurable). A human decides
it and makes the change on the default branch.
