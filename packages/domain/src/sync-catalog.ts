import type {
  ApplySyncCatalogPageInput,
  NoteSyncCatalogStreamInput,
  SyncCatalogMember,
  SyncCatalogSnapshot,
  SyncCatalogView,
  SyncDirectoryMember,
  SyncStreamState,
} from "./sync-contracts";
import { SYNC_CATALOG_STREAM } from "./sync-contracts";

export function emptySyncCatalog(installationId: string): SyncCatalogView {
  return { members: [], catalog: null };
}

/**
 * Apply one directory page.
 * `complete` ends the round. A page that is not the whole directory only
 * upserts. A new census starts when `replaces` marks a full snapshot, or
 * when an idle catalog receives an unfinished page. Members from the
 * previous generation stay until that census completes, then they are pruned.
 */
export function applySyncCatalogMembers(
  current: SyncCatalogView,
  input: ApplySyncCatalogPageInput,
): SyncCatalogView {
  const starting =
    input.replaces === true ||
    (!current.catalog?.cursor && input.complete !== true);
  const generation = starting
    ? (current.catalog?.generation ?? 0) + 1
    : current.catalog?.generation ?? 1;
  const byKey = new Map<string, SyncCatalogMember>();
  for (const member of current.members) {
    byKey.set(member.stream_key, { ...member });
  }
  for (const incoming of input.members) {
    const streamKey = incoming.stream_key.trim();
    if (!streamKey) {
      continue;
    }
    const prev = byKey.get(streamKey);
    byKey.set(streamKey, {
      installation_id: input.installation_id,
      stream_key: streamKey,
      thread_id: incoming.thread_id ?? prev?.thread_id,
      label: incoming.label ?? prev?.label,
      kind: incoming.kind ?? prev?.kind,
      generation,
      discovered_at: prev?.discovered_at ?? input.now,
      last_seen_at: input.now,
    });
  }
  let members = [...byKey.values()];
  if (input.complete) {
    members = members.filter((member) => member.generation === generation);
  }
  const catalog: SyncCatalogSnapshot = {
    installation_id: input.installation_id,
    ...(input.complete || !input.next_cursor
      ? {}
      : { cursor: input.next_cursor }),
    complete: input.complete === true,
    generation,
    updated_at: input.now,
  };
  return { members, catalog };
}

/**
 * Remember one push stream on the current generation.
 * A finished directory stays finished, and other members stay put.
 */
export function noteSyncCatalogStream(
  current: SyncCatalogView,
  input: NoteSyncCatalogStreamInput,
): SyncCatalogView {
  const streamKey = input.stream_key.trim();
  if (!streamKey || streamKey === SYNC_CATALOG_STREAM) {
    return current;
  }
  const generation = current.catalog?.generation ?? 1;
  const prev = current.members.find((member) => member.stream_key === streamKey);
  const nextMember: SyncCatalogMember = {
    installation_id: input.installation_id,
    stream_key: streamKey,
    thread_id: input.thread_id ?? prev?.thread_id,
    label: input.label ?? prev?.label,
    kind: prev?.kind,
    generation: prev?.generation ?? generation,
    discovered_at: prev?.discovered_at ?? input.now,
    last_seen_at: input.now,
  };
  const members = prev
    ? current.members.map((member) => member.stream_key === streamKey ? nextMember : member)
    : [...current.members, nextMember];
  const catalog: SyncCatalogSnapshot = current.catalog ?? {
    installation_id: input.installation_id,
    complete: false,
    generation,
    updated_at: input.now,
  };
  return { members, catalog };
}

/**
 * Sync state that belongs in the same write as this catalog note.
 * A different installation or stream is ignored so the two rows cannot split.
 */
export function syncStateNotedWith(
  input: NoteSyncCatalogStreamInput,
): SyncStreamState | undefined {
  const streamKey = input.stream_key.trim();
  const state = input.sync_state;
  if (
    !state ||
    !streamKey ||
    streamKey === SYNC_CATALOG_STREAM ||
    state.installation_id !== input.installation_id ||
    state.stream_key.trim() !== streamKey
  ) {
    return undefined;
  }
  return { ...state, stream_key: streamKey };
}

/** Stream keys a completed directory page removed. Incomplete pages keep them. */
export function catalogStreamKeysLeft(
  current: SyncCatalogView,
  next: SyncCatalogView,
): string[] {
  const kept = new Set(next.members.map((member) => member.stream_key));
  const seen = new Set<string>();
  const left: string[] = [];
  for (const member of current.members) {
    const key = member.stream_key;
    if (!key || key === SYNC_CATALOG_STREAM || kept.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    left.push(key);
  }
  return left;
}

export function mergeDirectoryMembers(
  known: readonly SyncDirectoryMember[],
  extra: readonly SyncDirectoryMember[],
): SyncDirectoryMember[] {
  const byKey = new Map<string, SyncDirectoryMember>();
  for (const member of [...known, ...extra]) {
    const streamKey = member.stream_key.trim();
    if (!streamKey) {
      continue;
    }
    const prev = byKey.get(streamKey);
    byKey.set(streamKey, {
      stream_key: streamKey,
      thread_id: member.thread_id ?? prev?.thread_id,
      label: member.label ?? prev?.label,
      kind: member.kind ?? prev?.kind,
    });
  }
  return [...byKey.values()];
}

export function catalogMemberOf(
  installationId: string,
  member: SyncDirectoryMember,
  now: string,
  generation = 1,
): SyncCatalogMember {
  return {
    installation_id: installationId,
    stream_key: member.stream_key,
    thread_id: member.thread_id,
    label: member.label,
    kind: member.kind,
    generation,
    discovered_at: now,
    last_seen_at: now,
  };
}
