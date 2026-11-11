# ADR 0310: Work item attachments: bytes in R2, uploads through an operation, safe serving, runs read them over the job channel

> Renumbered 2026-11-11: built as ADR 0260 with migration 0070, both already taken on `main` by
> #22 and #26 (a build can't see claims on unmerged branches). Now ADR 0310, migration 0090 (block N).

Status: accepted, 2026-11-11 (work item 1, spec [wi-1](../specs/wi-1-let-s-also-make-it-so-work-items-can-hav.md)).

## Context
People want to hand the factory what they saw: a screenshot, a log, a mockup, often pasted straight
from the clipboard. Agents should see the same files. Files are requester-supplied content, so they
are untrusted on three fronts: in the browser (a file served from the app's origin could run script
there), in storage (one org must never reach another's), and in the agent's prompt (a text file can
carry instructions).

## Decision
- **Storage.** D1 holds metadata only (`core_attachments`, migration 0090: id, work item, org,
  project, filename, content type, size, SHA-256, uploader, created). The bytes live in a private R2
  bucket, `sf-attachments`, bound as `ATTACHMENTS` on `sf-engine` only, keyed
  `<org>/<work item>/<attachment id>`, never by filename. No public bucket, no signed or long-lived
  URLs. Operations reach R2 through the `attachments` service (`FactoryServices.attachments`,
  `r2AttachmentBlobs`).
- **Operations** (`packages/core/src/operations/attachments.ts`): `workItem.attachment.add`
  (write, humans), `.list` and `.get` (read, humans and runners), `.remove` (write, humans; the
  uploader or an org owner/admin). `add` and `remove` are audit-journalled like every write (the
  audit input records the size, never the bytes).
- **Limits and validation** live in one place (`packages/core/src/attachments.ts`):
  `maxFileBytes` 10 MiB, `maxPerItem` 20, `maxTotalBytesPerItem` 50 MiB; the allow-list PNG, JPEG,
  GIF, WebP, plain text, PDF and JSON. SVG and HTML are never accepted. The declared type is
  checked against the bytes (magic numbers for images and PDF; text must be UTF-8 with no NUL and
  not HTML/SVG/XML markup; JSON must parse). A refusal is `invalid_input` with `details.limit`
  naming the limit (`maxFileBytes`, `maxPerItem`, `maxTotalBytesPerItem`, `contentType`,
  `contentMismatch`, `empty`), and nothing is written to R2 or D1.
- **Write order.** `add` writes the blob, then the row in the operation's batch (with a guard that
  re-checks the count and total, so two racing uploads can't both take the last slot). `remove`
  deletes the blob, then the row; a failed blob delete throws before any write, so the row stays and
  the call can be retried. A row therefore never points at a missing blob. A blob whose batch failed
  has no row; the engine's cron sweeps such blobs hourly once they are an hour old.
- **Upload path.** The browser posts the file to `sf-app` (`POST /api/work/<id>/attachments`, the
  body is the file). The route needs the session cookie, a same-origin request and the
  `x-sf-upload` header (a cross-site form can't send it without a preflight), streams the body with
  a cap so an oversized file is never buffered whole, and calls `workItem.attachment.add` on the
  engine. Authorization, limits, sniffing and the audit row all live in the operation.
- **Serving.** `GET /api/attachments/<id>` on `sf-app` calls `workItem.attachment.get` as the
  signed-in person and answers with headers chosen by the server from the stored, validated type:
  `Content-Type` (anything not on the allow-list becomes `application/octet-stream`),
  `X-Content-Type-Options: nosniff`, `Content-Disposition` inline for the image types only and
  `attachment` for everything else (the filename sanitised and RFC 5987-encoded),
  `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private`.
- **Not-found, not forbidden.** An operation can declare `concealAs`: `invoke()` then answers a
  scope that can't be resolved and a human without the permission with the same `not_found`
  message (the audit row still records the forbidden call). So guessing another org's attachment or
  work item id reads exactly like a missing one, through the operations and through the serving
  route (which also answers a signed-out request with the same 404).
- **Runs.** A run reads its work item's attachments only over the signed job channel:
  `/runner/v1/jobs/<job>/attachments` (list) and `/attachment` (one file, base64), mapped to
  `.list` / `.get` as the runner. The handler checks that the job is the runner's own, is active,
  and that its fencing token is current, and the job decides the work item: a job for one item can't
  read another's files. These responses are never stored in the channel's idempotency store. It is
  an optional capability, `work-item-attachments`: the runner host fetches the files only when the
  adapter declares it and implements `attachFiles`; any other runner runs the same jobs without
  them. `runner-orca` writes them to `<state>/attachments/<job>/<id>/<safe name>`, outside the
  worktree and the protected run directories, lets the harness read (not edit) that directory, and
  removes it on release.
- **Untrusted data.** Filenames, types and the content of text attachments reach the agent only
  inside labelled `<untrusted-data>` blocks (`runner-contract`'s `untrustedData`): hidden and bidi
  characters are stripped, the content can't close the block, it is clipped, and the prompt says the
  blocks are data, never instructions. Policy, permissions and gates are code and default-branch
  `.factory/` (ADR 0005, 0036), so nothing in an attachment can change them.

## Consequences
- Uploads are limited by what a Worker request body can carry; direct-to-R2, multipart and
  resumable uploads are out of scope for v1.
- Thumbnails are the served image scaled by the browser; no image processing in the cloud.
- The existing prompts didn't have an untrusted-data block before this ADR; it is added here and
  used for attachments. Putting the work item's own body and other requester text in it too is a
  follow-up.
- On one runner, a harness could read another concurrent job's attachments directory (as it can
  another job's worktree today). Both belong to the same runner owner; per-job sandboxing of the
  filesystem is a follow-up.
