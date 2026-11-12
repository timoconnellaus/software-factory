// The Inbox merge card's wording, apart from the component so it is testable without the router.

/** Why the card's Merge is disabled, shown on hover; undefined when it isn't. */
export function mergeBlocked(state: {
  loaded: boolean;
  canMerge: boolean;
  packet: boolean;
}): string | undefined {
  if (!state.loaded) return "Loading the review packet: Merge is ready once it has loaded";
  if (!state.canMerge) return "Only an approver on this project can merge";
  if (!state.packet)
    return "The review packet for this commit hasn't loaded: open it to review before merging";
  return undefined;
}
