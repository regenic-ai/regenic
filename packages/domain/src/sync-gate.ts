import type { SyncCatalogMember, SyncPhase, SyncStreamState } from "./sync-contracts";
import { isSyncComplete } from "./sync-lifecycle";

/** Defer context-heavy work until bootstrap (seed + history) has finished. */
export function shouldDeferWorkForSync(input: {
  requires_full_sync: boolean;
  phase: SyncPhase | undefined;
}): boolean {
  if (!input.requires_full_sync) {
    return false;
  }
  if (!input.phase) {
    return false;
  }
  return !isSyncComplete(input.phase);
}

export function syncPhaseForThread(
  threadId: string,
  members: readonly SyncCatalogMember[],
  states: ReadonlyMap<string, SyncStreamState>,
): SyncPhase | undefined {
  const member = members.find((item) => item.thread_id === threadId);
  if (!member) {
    return undefined;
  }
  return states.get(member.stream_key)?.phase;
}
