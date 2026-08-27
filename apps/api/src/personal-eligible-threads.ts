import {
  conversationId,
  parseConversationThread,
  type AuthorityStore,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConversationThread,
  type InboxItem,
} from "@regenic/domain";

export async function loadEligibleInstallationThreads(
  store: Pick<AuthorityStore, "listInbox">,
  orgId: string,
  installation: ConnectorInstallation,
  driver: Pick<ChannelDriver, "matchesThread">,
  preferredThreadId?: string | null,
): Promise<ConversationThread[]> {
  const items = await store.listInbox(orgId, { heads: true });
  return eligibleInstallationThreads(
    items,
    installation,
    driver,
    preferredThreadId,
  );
}

export function eligibleInstallationThreads(
  items: InboxItem[],
  installation: ConnectorInstallation,
  driver: Pick<ChannelDriver, "matchesThread">,
  preferredThreadId?: string | null,
): ConversationThread[] {
  const byId = new Map<string, ConversationThread>();
  for (const item of items) {
    const thread = threadFromEvent(item.event);
    if (!driver.matchesThread(installation, thread)) {
      continue;
    }
    byId.set(`${thread.source}:${thread.target}`, thread);
  }
  if (preferredThreadId) {
    try {
      const thread = parseConversationThread(preferredThreadId);
      if (driver.matchesThread(installation, thread)) {
        byId.set(`${thread.source}:${thread.target}`, thread);
      }
    } catch {
      // Ignore a malformed preferred id. Current work still stands.
    }
  }
  return [...byId.values()];
}

function threadFromEvent(event: {
  source: string;
  external_id: string;
  id: string;
}): ConversationThread {
  try {
    return parseConversationThread(
      conversationId(event.source, event.external_id, event.id),
    );
  } catch {
    return { source: event.source, target: event.external_id };
  }
}
