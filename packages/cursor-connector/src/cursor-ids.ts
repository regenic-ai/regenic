/**
 * Inbox groups by `conversationId(source, external_id)`, which keeps
 * everything before the last `:`. DSH uses `session:seq`. Cursor local
 * turn ids look like `agent-uuid:0:user`, so prefixing the agent id
 * again would split one session into a conversation per message.
 */
export function cursorExternalId(agentId: string, ...pieces: string[]): string {
  const token = pieces
    .flatMap((piece) => piece.split(":"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join(".");
  return `${agentId}:${token || "message"}`;
}

export function cursorMessageId(...pieces: string[]): string {
  return pieces
    .flatMap((piece) => piece.split(":"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join(".");
}

/** Local SDK ids are `agent-<uuid>`. Extra colons are leftover poll fragments. */
export function isLocalCursorAgentId(agentId: string): boolean {
  return /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    agentId.trim(),
  );
}
