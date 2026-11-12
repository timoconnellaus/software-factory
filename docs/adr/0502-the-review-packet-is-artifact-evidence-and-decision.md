# ADR 0502: The review packet is an artifact, its evidence and a decision on its digest

Status: **proposed**, 2026-11-12 (spec [52](../specs/52-workflows-from-stage-types.md)). Would amend
[ADR 0020](0020-verification-and-review-packet.md), [ADR 0037](0037-factory-verify-pinned-and-sha-bound.md)
and [ADR 0041](0041-in-app-review-packet-is-the-merge-gate.md).

## Context
The review packet is software's: checks, CI, criteria and a reviewer on one head SHA, backing
`factory/verify`. A Marketing workflow needs a person to watch the real reel before it posts. Both
are "a person decides on exactly this thing, with this evidence".

## Decision
1. A packet has a **subject** (an artifact: kind, id and digest, a git SHA or a sha256), **evidence**
   from any earlier stage, each item bound to a digest, a **verdict** computed in code from the
   evidence the stages require, and a **decision** that records the digest the person saw.
2. Evidence on another digest doesn't count. A new digest (a push, a re-render) withdraws the
   evidence and any pending decision, as `verify.refresh` does today.
3. An outside action needs an approved decision on the digest it acts on. The merge queue's
   carry-over of an approval across a clean update-branch (ADR 0330) is the one defined exception.
4. For software the subject is the PR's head SHA and the verdict backs `factory/verify`, unchanged.
   For media the subject is the file's sha256 and the evidence includes the live preview.

## Consequences
- Software's checks-on-a-SHA and marketing's preview are one mechanism, one screen family and one
  set of tests.
- Existing packets read through an adapter; nothing about `factory/verify` changes.
