import {
  conversationId,
  threadIdOf,
  type ArrangementDecision,
  type AuthorityStore,
  type BlobStore,
  type ChannelDriverRegistry,
  type ConnectorInstallation,
  type ConversationThread,
  type EventRecord,
  type InboxItem,
  type MessageReceipt,
  type ThreadReceiptQuery,
} from "@regenic/domain";
import { resolveInboxBodies, type InboxBody } from "./inbox-body";
import {
  byEventTime,
  messageSurfaceOf,
  threadOf,
} from "./personal-inbox-surface";

const RECEIPT_SCAN_LIMIT = 8;

export type InboxResolvedRow = {
  item: { decision: ArrangementDecision; event: EventRecord };
  threadId: string;
  body: InboxBody;
};

export async function loadInboxReceipts(input: {
  heads: boolean;
  thread?: ConversationThread;
  since?: string;
  resolved: InboxResolvedRow[];
  installations: ConnectorInstallation[];
  drivers: ChannelDriverRegistry;
  host: Parameters<ChannelDriverRegistry["readReceipts"]>[2];
  authority: AuthorityStore;
  blobs: BlobStore;
  orgId: string;
}): Promise<{
  receipts: ReadonlyMap<string, MessageReceipt>;
  extras: InboxResolvedRow[];
}> {
  if (input.heads) {
    return { receipts: new Map(), extras: [] };
  }
  const siblings =
    input.thread && input.drivers.canReceipt(input.installations, input.thread)
      ? await input.authority.listInbox(input.orgId, {
          siblings: true,
          thread_ids: [threadIdOf(input.thread)],
        })
      : [];
  const siblingOutbound =
    siblings.length > 0
      ? await outboundSiblingEvents(siblings, input.authority, input.blobs)
      : [];
  const queries = mergeReceiptQueries(
    receiptQueriesOf(input.resolved),
    siblingOutbound.length > 0
      ? receiptQueriesFromOutboundEvents(siblingOutbound)
      : [],
  );
  const receipts = await input.drivers.readReceipts(
    input.installations,
    queries,
    input.host,
  );
  if (!input.since || siblingOutbound.length === 0) {
    return { receipts, extras: [] };
  }
  const seen = new Set(input.resolved.map((row) => row.item.event.id));
  const extras = siblingOutbound.filter(
    (item) =>
      !seen.has(item.event.id) &&
      receipts.get(item.event.external_id)?.state === "read",
  );
  if (extras.length === 0) {
    return { receipts, extras: [] };
  }
  const bodies = await resolveInboxBodies(
    input.authority,
    input.blobs,
    extras.map((item) => item.event.content_hash),
    "preview",
  );
  return {
    receipts,
    extras: extras.map((item) => ({
      item,
      threadId: conversationId(
        item.event.source,
        item.event.external_id,
        item.event.id,
      ),
      body: item.event.content_hash
        ? (bodies.get(item.event.content_hash) ?? {})
        : {},
    })),
  };
}

export function receiptQueriesOf(resolved: InboxResolvedRow[]): ThreadReceiptQuery[] {
  const groups = new Map<string, ThreadReceiptQuery>();
  for (const row of resolved) {
    const surface = messageSurfaceOf(row.item.event, row.body);
    if (surface.direction !== "outbound") {
      continue;
    }
    const thread = threadOf(row.item.event);
    const current = groups.get(row.threadId) ?? { ...thread, outbound: [] };
    current.outbound.push({
      external_id: row.item.event.external_id,
      occurred_at: row.item.event.occurred_at,
    });
    groups.set(row.threadId, current);
  }
  return [...groups.values()].map((query) => ({
    ...query,
    outbound: newestOutbound(query.outbound),
  }));
}

function mergeReceiptQueries(
  ...groups: ThreadReceiptQuery[][]
): ThreadReceiptQuery[] {
  const merged = new Map<string, ThreadReceiptQuery>();
  for (const group of groups) {
    for (const query of group) {
      const threadId = threadIdOf(query);
      const current = merged.get(threadId);
      if (!current) {
        merged.set(threadId, {
          ...query,
          outbound: [...query.outbound],
        });
        continue;
      }
      current.outbound.push(...query.outbound);
    }
  }
  return [...merged.values()].map((query) => ({
    ...query,
    outbound: newestOutbound(uniqueOutbound(query.outbound)),
  }));
}

function uniqueOutbound<T extends { external_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.external_id)) {
      return false;
    }
    seen.add(item.external_id);
    return true;
  });
}

async function outboundSiblingEvents(
  items: InboxItem[],
  authority: AuthorityStore,
  blobs: BlobStore,
): Promise<InboxItem[]> {
  const newest = items.slice().sort(byEventTime).reverse().slice(0, 48);
  const hashes = newest
    .map((item) => item.event.content_hash)
    .filter((hash): hash is string => Boolean(hash));
  const bodies =
    hashes.length > 0
      ? await resolveInboxBodies(authority, blobs, hashes, "meta")
      : new Map<string, InboxBody>();
  return newest
    .filter((item) => {
      const body = item.event.content_hash
        ? (bodies.get(item.event.content_hash) ?? {})
        : {};
      return messageSurfaceOf(item.event, body).direction === "outbound";
    })
    .slice(0, RECEIPT_SCAN_LIMIT);
}

function receiptQueriesFromOutboundEvents(
  items: Array<{ event: EventRecord }>,
): ThreadReceiptQuery[] {
  const groups = new Map<string, ThreadReceiptQuery>();
  for (const { event } of items) {
    const thread = threadOf(event);
    const threadId = threadIdOf(thread);
    const current = groups.get(threadId) ?? { ...thread, outbound: [] };
    current.outbound.push({
      external_id: event.external_id,
      occurred_at: event.occurred_at,
    });
    groups.set(threadId, current);
  }
  return [...groups.values()].map((query) => ({
    ...query,
    outbound: newestOutbound(query.outbound),
  }));
}

function newestOutbound<T extends { occurred_at: string; external_id: string }>(
  items: T[],
): T[] {
  return items
    .slice()
    .sort((left, right) =>
      left.occurred_at === right.occurred_at
        ? left.external_id < right.external_id
          ? 1
          : -1
        : left.occurred_at < right.occurred_at
          ? 1
          : -1,
    )
    .slice(0, RECEIPT_SCAN_LIMIT);
}
