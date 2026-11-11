# Spec 07: The `sf` CLI

**Read first**: [ADR 0340](../adr/0340-a-cli-for-people-gates-stay-in-the-browser.md),
[ADR 0003](../adr/0003-operations-registry.md) and [0004](../adr/0004-invoke-pipeline-and-gate.md)
(operations, the invoke pipeline and the gate), [ADR 0056](../adr/0056-runner-device-login.md) (the runner's device
login, which this mirrors), [ADR 0005](../adr/0005-hybrid-coordinator.md).

## Goal
A person (or an agent session working for them) can see the factory's work and act on it from a
terminal: the inbox, a work item's state and timeline, the merge queue, new work, attaching a PR,
cancelling. Gate decisions stay in the browser, so an agent holding a CLI token can't approve its
own work.

## Scope
- **Gates are browser-only, in code.** Operations carry `browserOnly` (optionally per input).
  `invoke()` refuses them for a human on any surface but the app, with `forbidden`. That covers
  the CLI, and MCP when it comes. Browser-only:
  - spec and merge decisions, `approval.decide`;
  - answering questions and accepting their defaults;
  - approving a runner or CLI login;
  - registering a runner, or rotating its key;
  - turning a kill switch **off** (turning one on stays allowed).
- **Device login for people** (migration 0110):
  - `cli.deviceStart` and `cli.devicePoll` are unsigned and run as `CLI_DEVICE_ACTOR`.
  - `cli.deviceLookup`, `cli.approveDevice` (browser-only; the person picks the scope) and
    `cli.denyDevice` run in the app at `/cli/connect?code=…`.
  - The token is minted at the first poll after approval and handed over once. Only its SHA-256
    is stored.
- **Tokens:**
  - Scope `read` allows only `read`-risk operations; `write` allows the rest of what the person
    may do.
  - Tokens expire after 30 days.
  - `cliToken.list` and `cliToken.revoke` let a person see and revoke only their own tokens.
- **`sf-engine` `/cli/v1`:** `device/start`, `device/poll`, `call` (`Authorization: Bearer`,
  `{ op, input }`) and `ops`. The actor is `human`, from the token, with `origin.surface = "cli"`.
- **`local/cli`, the `sf` command (Node 24):**
  - `login [--write]`, `logout`, `status`;
  - `ops` and `call <op> [json]`, generic over the registry;
  - `inbox`, `ls`, `show <n>`, `timeline <n>`, `queue`, `new`, `attach <pr>`, `cancel <n>`;
  - `open <n>` opens the work item, or its review packet, in the browser.

## Out of scope
- MCP. It will use the same endpoint and the same browser-only rule.
- Managing tokens in the app. Revoking is `sf logout` or `sf tokens revoke`.
- Org admin from the CLI (connecting GitHub, creating projects). Those flows need the browser.

## Acceptance criteria
1. `sf login` shows a code and a link. Approving it in the app with a scope gives the CLI a token
   once, and a second poll gets `expired`. Denying the code ends the login.
2. **Read scope:** a `read` token can run `inbox.list`, `workItem.get` and `mergeQueue.list`.
   `workItem.create` is refused with `forbidden` (scope).
3. **Write scope:** a `write` token can create, attach and cancel. It can't run `review.merge`,
   `spec.approve`, `question.answer`, `approval.decide` or `cli.approveDevice`, or turn a kill
   switch off. Each refusal is `forbidden` and names the browser.
4. Calls are audited as the person, with `origin.surface = "cli"`.
5. A revoked, expired or unknown token gets `401`.
6. `sf show <n>` prints the stage, status and reason, the merge queue position, open gates (with
   their app links) and runs. `sf ls`, `sf inbox` and `sf queue` print one line per item.
7. `sf call <op>` reaches any operation the token's scope allows, and `sf ops` lists them with
   their risk and whether they're browser-only.
