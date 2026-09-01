import type { ConnectorStream, SyncCatalogMember } from "@regenic/domain";

export function catalogMembersFromStreams(
  installationId: string,
  streams: readonly ConnectorStream[],
): SyncCatalogMember[] {
  const now = new Date().toISOString();
  return streams.map((stream) => ({
    installation_id: installationId,
    stream_key: stream.stream_key,
    thread_id: stream.thread_id,
    label: stream.label,
    generation: 1,
    discovered_at: now,
    last_seen_at: now,
  }));
}
