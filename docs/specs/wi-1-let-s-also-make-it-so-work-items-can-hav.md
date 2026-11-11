# Spec: Work item attachments

Read first: [`docs/architecture.md`](../architecture.md), ADRs [0003](../adr/0003-operations-registry.md), [0004](../adr/0004-operations-are-the-api.md), [0010](../adr/0010-no-ambient-authority.md), [0011](../adr/0011-audit-journal-is-the-metrics.md), [0033](../adr/0033-per-job-github-app-token.md); specs [01](01-operations-and-store.md), [03](03-runner-contract-and-orca.md), [13](13-r1-work-item-detail.md).

## Goal
A work item can carry files, such as screenshots, logs and mockups, that people add by picker, drag-and-drop or pasting from the clipboard, and that the item's runs can read, so agents see what the requester saw.

## Scope
- **Data.** A work item holds zero or more attachments. D1 stores metadata only (id, work item, org, project, filename, content type, size in bytes, sha-256, uploader actor, created); the bytes live in an R2 bucket declared in the app/engine `wrangler.jsonc`, keyed by org, work item and attachment id (never by filename). One new migration from the claimed block.
- **Operations** in the registry (`packages/core`), each with zod schemas, a model-facing description, a permission and a risk class: `workItem.attachment.add`, `.list`, `.get`, `.remove`. `add` and `remove` are audit-journalled in the same D1 batch as the metadata write. `remove` deletes the blob and the metadata (blob first, then the row; a failed blob delete leaves the row and is retried, never an orphaned row pointing at nothing, and a stray blob without a row is swept).
- **Limits**, as named constants in one place: max size per file, max attachments per work item, and max total bytes per work item. Allow-list of content types in v1: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `text/plain`, `application/pdf`, `application/json`. SVG and HTML are rejected. The content type is checked by sniffing the leading bytes against the declared type; a mismatch is rejected.
- **Upload path.** Bytes go through a Worker endpoint that calls the `add` operation (so authz, limits, validation and audit all live in the operation), not straight to R2. The request body is streamed and size-capped before buffering.
- **Serving.** A Worker route streams a file after an authorization check via `get`. Responses carry a server-chosen `Content-Type` from the stored, validated value, `X-Content-Type-Options: nosniff`, `Content-Disposition` (inline only for the image types, `attachment` for everything else, with the filename safely encoded), `Content-Security-Policy: sandbox; default-src 'none'`, and `Cache-Control: private`. Files are served from the app origin only through this route; no public bucket, no unauthenticated or long-lived URLs.
- **Authorization.** Only actors with access to the work item's org and project can add, list, fetch or remove its attachments. Someone without access gets not-found, identical to a missing attachment. Remove needs the uploader or an org admin/owner.
- **UI** (work item detail, spec 13): an Attachments section (in the sidebar/Details) listing files with thumbnails for images, size and uploader. Users add files by picker or drag-and-drop, and by pasting a clipboard image anywhere in the New work form and the detail page; pasted images get a generated name (`pasted-image-<timestamp>.png`). Per-file progress and error messages for rejected files; remove with confirmation. Also available on the New work form, so a request can start with a screenshot (files are attached once the work item is created).
- **Runs.** A run reads its work item's attachments only through the per-job, work-item-scoped runner channel: a new channel message pair (list and fetch by attachment id) added to `packages/runner-contract`, authorized by the job token's work item, never by a standing credential and never by a signed public URL. It is an optional capability (`work-item-attachments`) the adapter declares; runners without it simply see no attachments. The Orca adapter and `harness-claude` fetch the files into the run workspace outside the git tree (so they cannot be committed) and give the agent their paths.
- **Untrusted data.** Attachment filenames, content types and content are passed to agents inside the labelled untrusted-data block, the same as other requester-supplied text, and go through the existing sanitising path. Text-like attachments are never treated as instructions, and attachment content never changes the autonomy policy, permissions or gates.
- **Docs.** Update `CONTEXT.md` (the term *attachment*), `docs/architecture.md`, a new ADR (blob storage in R2, upload through an operation, serving headers, runner access), `docs/parallel-work.md` (claim block I: migrations 0070-0079, ADRs 0260-0269, in the first commit) and `docs/specs/README.md`. Amend spec 13 and spec 03 with a dated note.

## Out of scope
- Attachments on anything other than work items (questions, comments, specs, runs' own outputs).
- Virus/malware scanning, OCR, image resizing or thumbnail generation beyond browser-side scaling, and video.
- Direct-to-R2 presigned uploads and multipart/resumable uploads for large files.
- Public or shareable links, versioning or editing of an attachment, and quota or billing per org.
- Agents adding attachments back to a work item (read only in v1).
- Including attachments in the review packet and in the PR description.
- Retention after a work item is deleted beyond removing its attachments with it.

## Acceptance criteria
1. A work item holds zero or more attachments, each with filename, content type, size, uploader and created time; D1 holds only metadata and the bytes are in an R2 bucket declared in wrangler config, with tests running against the real binding in workerd.
2. `workItem.attachment.add`, `.list`, `.get` and `.remove` exist in the registry with zod schemas, model-facing descriptions, permissions and risk classes, and the dashboard and runner channel reach attachments only through them.
3. In the work item UI a user can add files by file picker or drag-and-drop, and by pasting a clipboard image; the file then appears in the list with a thumbnail for images. A test covers the paste-to-upload flow end to end.
4. Uploads over the per-file size, per-item count or per-item total limits, or with a disallowed content type, or whose sniffed content does not match the declared type, are rejected with a typed error that names the limit, and nothing is stored in R2 or D1.
5. Served files carry a server-chosen `Content-Type`, `X-Content-Type-Options: nosniff`, a safe `Content-Disposition` (inline for images only) and a sandboxing `Content-Security-Policy`; an uploaded HTML or SVG file is never rendered inline in a test.
6. Only actors with access to the work item's org and project can list, fetch, add or remove its attachments; others get not-found indistinguishable from a missing attachment, including via the serving route and when guessing ids from another org.
7. Attachment add and remove are audit-journalled; remove deletes both the blob and the metadata, and a failed blob delete never leaves metadata pointing at a missing blob.
8. A run can list and fetch its own work item's attachments through the per-job, work-item-scoped channel, and a job token for one work item cannot read another work item's attachments; a runner that does not declare the capability still works.
9. Attachment filenames and content are passed to agents as labelled untrusted data through the existing sanitising path, and a test shows an attachment containing instruction-like text does not change a policy, gate or permission.
10. `CONTEXT.md`, `docs/architecture.md`, the new ADR, `docs/parallel-work.md` and `docs/specs/README.md` are updated and true.
11. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
