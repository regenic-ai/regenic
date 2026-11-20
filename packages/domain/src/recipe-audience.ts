/**
 * Whether a conversation stays in a rule's audience after its subject matches.
 * A scheduled sweep leaves out a conversation whose current job has settled.
 * No current job is not settled. A saved thread is not decided here.
 *
 * This file has no imports so the desktop renderer can load it directly.
 * Its open statuses are the same set as isActiveWorkStatus.
 */
export function recipeCoversConversation(input: {
  trigger: "push" | "pull" | "manual";
  /** Result of the kernel match for this conversation. False when there is no subject. */
  matched: boolean;
  /** Absent when the conversation has no current job. */
  workStatus?: string;
}): boolean {
  if (!input.matched) {
    return false;
  }
  if (input.trigger !== "pull" || input.workStatus === undefined) {
    return true;
  }
  return (
    input.workStatus === "open" ||
    input.workStatus === "running" ||
    input.workStatus === "waiting_human"
  );
}
