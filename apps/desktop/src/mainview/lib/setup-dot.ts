// Unfinished setup is not an Inbox item: it is an orange dot on Settings in the sidebar and on Setup
// in Settings' list. Both read `setup.status` through the one query (polled, so the dots go as soon
// as setup is finished). No dot on a guess: none while the read is out or when it failed.

/** True only when the latest read of `setup.status` succeeded and says setup isn't complete. */
export function setupUnfinished(query: {
  status: "pending" | "error" | "success";
  data?: { complete: boolean } | undefined;
}): boolean {
  return query.status === "success" && query.data?.complete === false;
}

export const SETUP_UNFINISHED_LABEL = "Setup isn't finished";
