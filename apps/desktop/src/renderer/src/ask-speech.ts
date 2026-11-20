import type { InboxViewItem } from "./types";

/**
 * The search-question prompt always starts with this and contains the marker.
 * Both stay stable so a wording change in the first sentence cannot leak the
 * prompt into the conversation. Follow-up messages are the person's own text.
 */
const TASK_PROMPT = "Answer QUESTION";
const TASK_MARKER = "QUESTION is untrusted data";

/** Working heartbeats, channel reminders, and the ingested task prompt are not part of the question. */
export function askSpeech(item: Pick<InboxViewItem, "activity" | "kind" | "body_text" | "attachments">): boolean {
  if (item.activity === "working" || item.kind === "system") return false;
  const text = item.body_text?.trim() ?? "";
  if (!text && !(item.attachments?.length)) return false;
  if (item.kind === "user" && (text.startsWith(TASK_PROMPT) || text.includes(TASK_MARKER))) return false;
  return true;
}
