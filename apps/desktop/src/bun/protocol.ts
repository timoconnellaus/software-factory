// The client door's version handshake (spec 40 M4, ADR 0393). Every request to the door says which
// app and which door protocol this build speaks. The engine answers 426 `update_required` when the
// build is older than the oldest protocol it still serves (DESKTOP_MIN_PROTOCOL on sf-engine).
//
// Bump DOOR_PROTOCOL in the change that makes this app depend on something new in the door; raise
// DESKTOP_MIN_PROTOCOL on the engine only when older builds must stop (they then update).

// 1: the handshake itself. 2: review.merge names the commit the person reviewed (headSha); the
// engine refuses a merge approval without it, telling an older build to update.
/** The door protocol this build speaks. Bump DESKTOP_PROTOCOL_LATEST in apps/engine/src/cli.ts with it. */
export const DOOR_PROTOCOL = 2;

/** The headers every door request carries (fetch and the live socket). */
export const PROTOCOL_HEADERS: Readonly<Record<string, string>> = {
  "x-sf-client": "desktop",
  "x-sf-client-protocol": String(DOOR_PROTOCOL),
};

/** The door refused this build as too old: only an update fixes it. */
export class UpdateRequiredError extends Error {
  readonly code = "update_required";
}
