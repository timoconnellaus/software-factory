# @software-factory/flow

The new core's kernel (ADR 0660, spec 70). Pure: no D1, no Cloudflare, no knowledge of any kind of work.

- `model.ts`: a **workflow** is an ordered list of **statuses**; each has an owner (an agent, a
  person, or nobody), a brief, where the item goes when done or rejected, and whether leaving it
  takes a person's decision.
- `validate.ts`: `checkWorkflow(input)` parses a workflow and refuses one whose statuses point at
  statuses that don't exist.
- `reconcile.ts`: `apply(workflow, state, event)` is the whole engine. It returns the item's new
  state and the **effects** the caller must carry out (start a run, cancel one, add to an inbox,
  ask for a decision). `replay(workflow, events)` rebuilds a state from its events.

An item waits on one thing at a time: a run, a person, a decision, or nothing. A failed run stops
the item with its error until someone retries it or moves it.
