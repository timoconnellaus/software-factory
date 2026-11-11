# ADR 0241: sf-app runs next to D1, and a page loads in one request from a cached session

Status: accepted, 2026-11-11 (app performance).

## Context
Switching pages was slow: 0.6–2 s per navigation. Measured on production from Sydney:

- D1's primary is in **SJC** (WNAM, `served_by_colo`), and the Workers ran at the visitor's edge
  (SYD). Every D1 query, from Better Auth or from an operation, crossed the Pacific. One operation
  is several queries in series (scope → project → policy → permission → handler), so a read took
  380–2,100 ms.
- `_app`'s `beforeLoad` called the `getSession` server function on **every** navigation (two D1
  queries, ~570 ms) before any loader started.
- Loaders fetched only part of a page; the rest was fetched by `useQuery` after render. With no
  SSR query integration, the cache filled during the server render was dropped, and the browser
  fetched it all again after hydration.
- Each read was its own server-function request, re-resolving the session each time.

Placement only applies to a Worker's `fetch` handler, not to RPC entrypoints; a service-binding
RPC callee runs where its caller runs.

## Decision
- **`sf-app` is pinned next to D1** (`placement.region: "aws:us-west-1"`, the Bay Area, near SJC).
  A request crosses the Pacific once; its D1 queries and its `ENGINE` RPCs (which run alongside it)
  are local. Static assets are still served from the visitor's edge. `sf-engine` gets the same
  placement for its own fetch handlers (the runner channel, the GitHub webhook). If D1 moves (or
  read replicas arrive), move this with it.
- **The session lives in the query cache** (`sessionQuery`): fetched once per page load (on the
  server, carried to the browser), read by `_app`'s `beforeLoad` with `ensureQueryData`, re-checked
  in the background once it is five minutes stale. A background check that finds no session sends
  the person to sign in. **This is not an authorisation cache**: every server function still
  resolves the session from the request and every operation checks it. Better Auth's `cookieCache`
  is not used: next to D1 the lookup costs ~1 ms, and the cache would delay revocation.
- **Loaders `ensureQueryData` everything their page renders**, in parallel, and pages read it with
  `useSuspenseQuery` (or `useQuery` where the query is optional). A test (`test/perf.test.ts`)
  fails if a page or a component it renders uses a query its loader (or the shell's) doesn't load.
  The one deliberate exception is the inbox's Finish setup card, which asks GitHub: its query is
  started in the loader but not awaited. Setup and `/runners/connect` fetch on demand by design.
- **Reads batch per tick.** `read()` queues every read asked for in the same tick and sends them in
  one `callReads` request; the server resolves the session once and runs them in parallel. Only
  read operations (`APP_READ_OPERATIONS`) batch; writes stay one call each with their idempotency
  key. On the server, reads never batch: one isolate renders many people's requests, and a shared
  queue could mix them.
- **The SSR query integration** (`@tanstack/react-router-ssr-query`) carries the server render's
  cache to the browser, so a full page load makes no further requests.
- **Freshness is TanStack Query's**: `defaultPreloadStaleTime: 0` (the router always runs loaders;
  `ensureQueryData` answers from the cache), per-query `staleTime`s, and stale data is refetched in
  the background on mount. Intent preloading warms the cache on hover.
- **Pending UI**: a navigation that has to fetch shows the page's skeleton after 150 ms.
- **`Server-Timing`** on every server function: `auth`, `orgs`, each operation's RPC time (`opN`),
  and the time inside the engine (`engineN`, which `EngineApi.invoke` now returns as `ms`).

## Consequences
- A navigation that fetches costs one round trip to SJC plus local work; a cached one renders at
  once. The hop from Australia (~150 ms) is the floor until D1 read replicas or a primary in OC.
- The server render runs in the US: the first HTML byte for an Australian visitor is one Pacific
  crossing later than at the edge, and no longer pays for many crossings inside the render.
- A revoked session can keep the shell on screen until the next background check (≤ 5 minutes),
  but every read and write is refused at once.

> Amended 2026-11-11 (after deploying #20): `cf-placement: remote-SJC` confirmed, and cached page
> switches take 4–11 ms. A navigation that fetches still took 360–525 ms, because D1 costs about
> 10–25 ms per query even from the same colo and operations ran their lookups one after another
> (`workItem.get` made 7 round trips). `invoke()` now resolves the scope (work item → project →
> policy) and the human caller's org role in **one D1 batch**, using subqueries for the dependent
> lookups. `checkPermission` takes the role it read, and still refuses the same way.
> `workItem.get` and `inbox.list` run their independent reads in parallel. Round trips:
> `workItem.get` 7 → 3, `inbox.list` 7 → 3, `workItem.timeline` 5 → 2.

> Amended 2026-11-11 (after deploying #21): within one `callReads`, each operation's engine time
> rose with its position (18 → 51 → 66 → 116 → 153 ms). Concurrent D1 requests queue behind one
> another, so the number of D1 **requests** is the cost, not how many run at once. Independent reads
> now go as one `readBatch` (`packages/db`): `inbox.list` is a single D1 request (memberships and
> runner slot counts as subqueries), and `workItem.get` reads the item's rows in one. Reads that call
> GitHub (`setup.status`, `github.repos`, `SLOW_READS` in the app) are never batched with database
> reads: a batch answers when its slowest read does, and a cold inbox had waited ~2 s for GitHub.
