# ADR 0543: Chat proposes a config change; a person approves it, on the phone, with a fingerprint bound to the version

Status: proposed, 2026-11-12. Spec [60](../specs/60-mobile-app.md). **Amends**
[ADR 0370](0370-factory-config-lives-in-the-app.md) (config operations are human-only). Consistent
with [ADR 0005](0005-hybrid-coordinator.md), [0008](0008-autonomy-presets-and-floor.md),
[0036](0036-policy-from-the-default-branch.md) (as superseded) and
[0373](0373-the-factory-improves-its-own-practice.md). Needs the owner's sign-off at the merge
gate on the PR that adds it.

## Context
The owner decided that chat can draft a policy or workflow change and that the owner approves it
on the phone. The approval comes after a before-and-after screen that marks anything that loosens a
gate, and it takes a fingerprint (`docs/design/mobile/PolicyApprove.html`). The desktop design says
chat "cannot approve, merge or loosen policy".

The standing rules:
- loosening policy is a human-only change (ADR 0008, 0370);
- policy is enforced in code, never by a prompt (ADR 0005);
- the factory may change its practice itself, never its policy (ADR 0373).

Today, config operations are human-only and no agent can reach them (ADR 0370, consequences). A
loosening `config.save` becomes a `self-modify` pending action, judged under the current version,
which an approver decides with `approval.decide`.

## Decision
1. **Chat can propose, and only propose.**
   - `config.propose { projectId, baseVersion, policy, note }` may be called by a person or by the
     chat agent acting for a person (`requestedBy`). It validates the document and refuses a stale
     base, as `config.save` does. It **always** creates a pending action of kind `config`, assigned
     to the project's approvers: proposals from an agent wait for a person even when they tighten.
   - It changes nothing else.
   - `config.save` and `config.rollback` stay human-only.
   - The `notify` it writes becomes the push type `policy`.
2. **A version has a hash.**
   - Each config version stores `content_digest`, the SHA-256 of the canonical JSON of its document
     (core's `canonicalJson`). Migration 0310 backfills it for existing versions.
   - A proposal stores the digest of the version it would create: `proposalDigest`.
   - The screen shows the version change and the short digest, for example
     `Version 14 → 15 · a41c9e2`.
3. **Approving is `config.approve`, and the fingerprint binds to that exact version.**
   - The input is `{ pendingActionId, decision, baseVersion, proposalDigest, note? }`.
   - It is `browserOnly` when approving and presence-decidable on `desktop` and `mobile`. Rejecting
     is one tap (ADR 0541).
   - The presence proof covers the input's digest, so it covers `proposalDigest` and `baseVersion`.
     The handler refuses with `conflict`, and decides nothing, unless:
     - the pending action is an open `config` proposal;
     - the project's current version is still `baseVersion`;
     - the stored proposal's digest equals `proposalDigest`.
     A fingerprint therefore approves one document on one base, never a later edit.
   - The engine writes the summary, never the chat:
     `Approve Factory config v15 (a41c9e2): loosens 1, from v14`.
   - On approval it applies the proposal through `applyApprovedConfig`, with the proposer as
     author, source `chat`, and the approver recorded as approver.
   - `approval.decide` refuses `approved` for a `config` pending action ("approve a config change
     with config.approve"). That leaves one way in, the one that binds the digest.
4. **The before-and-after screen comes from the engine.**
   - `config.proposal.get { pendingActionId }` returns the current and proposed values and
     `policyImpact` for each change (`loosens`, `tightens`, `neutral`, and anything it can't
     classify counts as loosening).
   - It also returns the rules that can't change (`ALWAYS_REVIEW`: merge, deploy and self-modify
     always need a person; the floor), and the versions and digest.
   - The phone renders that. The chat's own words about the change are shown only as the note,
     labelled as chat's.
5. **Who may approve:** a human approver on `app`, `desktop` (Touch ID) or `mobile` (fingerprint),
   judged under the **current** version's rules (ADR 0370 decision 4). Not the chat, an
   autopilot, the improver, the adjudicator, the CLI or MCP. `invoke()` already refuses those:
   `config.approve` is `actors: ["human"]` and browser-only without a proof.

## Why this keeps "loosening is human-only"
- **The change that takes effect is a person's decision.** Chat writes a proposal, which is inert.
  Only a person's `config.approve` makes it current.
- **The proof is a person.** A biometric-bound, per-use key in attested hardware signs a prompt
  that names the version and its digest (ADR 0541).
- **The policy is checked in code, and the chat's description isn't trusted.** The gate judges the
  proposal under the current version. The loosening marks come from `policyImpact`, not from the
  chat. `ALWAYS_REVIEW` and the floor can't be changed by any document: an attempt is invalid, and
  the screen shows those rules as "cannot change".
- **What this amends** is ADR 0370's consequence that "an agent has no path to config operations
  at all". An agent now has a path to *propose*. That is the same capability a member already
  has, and no more.

## Consequences
- A proposal goes stale as soon as any other save lands. The phone shows "This change was drafted
  against v14; the config is now v15", and chat has to propose again.
- The audit journal records the proposer (the chat agent and the person it acted for), the
  approver, the device, the proof's summary and the digest.
- Workflow changes ride the same path, because workflows are part of the config document (ADR
  0371).

## Amendment, 2026-11-13: the website no longer approves (ADR 0610)
The website keeps only sign-in and device approval
([ADR 0610](0610-everything-but-sign-in-moves-to-the-desktop-app.md)), so the places a person approves
a config change are the desktop app (Touch ID) and, as decided here, the phone (fingerprint). The
`app` surface stays allowed in `invoke()`, but no website screen calls these operations any more.
The phone's rules are unchanged.
