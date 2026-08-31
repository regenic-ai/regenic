import type {
  ApplySyncCatalogPageInput,
  SyncCatalogMember,
  SyncCatalogSnapshot,
  SyncCatalogView,
  SyncDirectoryMember,
} from "./sync-contracts";

export function emptySyncCatalog(installationId: string): SyncCatalogView {
  return { members: [], catalog: null };
}

/**
 * Apply one directory page. A new census starts when the previous snapshot
 * has no in-flight cursor. Members from the previous generation stay until
 * the new census completes, then they are pruned.
 */
export function applySyncCatalogMembers(
  current: SyncCatalogView,
  input: ApplySyncCatalogPageInput,
): SyncCatalogView {
  const starting = !current.catalog?.cursor;
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
