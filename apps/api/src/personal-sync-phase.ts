import type { SyncPhase } from "@regenic/domain";

export async function syncPhaseForThread(
  authority: {
    listInstallations(orgId: string): Promise<Array<{ id: string; status: string }>>;
    getSyncState(installationId: string, streamKey: string): Promise<{ phase: SyncPhase } | null>;
  },
  connectors: {
    listStreams(installationId: string): Array<{ thread_id?: string | null; stream_key: string }>;
  },
  orgId: string,
  threadId: string,
): Promise<SyncPhase | undefined> {
  const installations = await authority.listInstallations(orgId);
  for (const installation of installations) {
    if (installation.status !== "enabled") {
      continue;
    }
    const stream = connectors
      .listStreams(installation.id)
      .find((item) => item.thread_id === threadId);
    if (!stream) {
      continue;
    }
    const state = await authority.getSyncState(installation.id, stream.stream_key);
    return state?.phase;
  }
  return undefined;
}
