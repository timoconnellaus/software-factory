# @software-factory/connector-github

The GitHub App connector (ADR 0010, 0025, 0037, 0052). `routeGitHubEvent(event, payload, appSlug)`
maps one App webhook to the operations it implies; it never writes and never calls GitHub.
`sf-engine` mounts it at `https://software-factory.zerobsai.com/webhooks/github` (a Workers route in
front of sf-app's domain), authenticates the delivery with `@software-factory/connector-webhook`,
skips deliveries already in `core_connector_events`, invokes the calls as `{ type: "intake", id: "github" }`
and then records the delivery with `connector.receive`.

| Event | Operation |
| --- | --- |
| `pull_request` opened, reopened, synchronize, ready_for_review | `verify.refresh` (a new head has no passing `factory/verify` until verify runs; a PR the factory didn't open fails) |
| `check_suite` completed, not the factory's own | `verify.refresh` (CI settled: re-evaluate the check, wake the Workflow) |
| `check_run` rerequested on `factory/verify` | `verify.refresh` |
| `push` | `push.observe` (branch confinement for the App's pushes; `.factory/policy.json` mirror on the default branch) |
| `installation`, `installation_repositories` | `github.installation` |
| `repository_ruleset`, `branch_protection_rule` | `protection.observe` (re-check the default branch's protection: drift, ADR 0280) |

`APP_REQUIREMENTS` lists the events and permissions the App needs. `administration` stays `read`:
write would let the App delete repositories, so the factory verifies protection and a person applies
it (ADR 0280).
