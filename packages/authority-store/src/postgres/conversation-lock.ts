import type { PoolClient } from "pg";
import type { PgSql } from "./sql";

export interface ConversationLockKey {
  org_id: string;
  thread_id: string;
}

export async function lockConversationThreads(
  db: PgSql,
  client: PoolClient,
  conversations: readonly ConversationLockKey[],
): Promise<void> {
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const ordered = [...conversations].sort((left, right) =>
    compare(left.org_id, right.org_id) ||
    compare(left.thread_id, right.thread_id),
  );
  let previous: ConversationLockKey | undefined;
  for (const conversation of ordered) {
    if (!conversation.org_id.trim() || !conversation.thread_id.trim()) {
      throw new Error("Conversation lock requires an organization and thread identity");
    }
    if (
      previous?.org_id === conversation.org_id &&
      previous.thread_id === conversation.thread_id
    ) {
      continue;
    }
    await db.queryOne(
      "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, $2::text)::text, 0))",
      [conversation.org_id, conversation.thread_id],
      client,
    );
    previous = conversation;
  }
}
