import {
  shouldDeferWorkForSync,
  syncPhaseForThread as domainSyncPhaseForThread,
  type SyncCatalogMember,
  type SyncPhase,
  type SyncStreamState,
} from "@regenic/domain";

type SyncPhaseAuthority = {
  listInstallations(orgId: string): Promise<Array<{ id: string; status: string }>>;
  getSyncCatalog(installationId: string): Promise<{ members: SyncCatalogMember[] }>;
  listSyncStates(installationId: string): Promise<SyncStreamState[]>;
};

export async function syncPhaseForThread(
  authority: SyncPhaseAuthority,
  orgId: string,
  threadId: string,
): Promise<SyncPhase | undefined> {
  const installations = await authority.listInstallations(orgId);
  const members: SyncCatalogMember[] = [];
  const states = new Map<string, SyncStreamState>();
  for (const installation of installations) {
    if (installation.status !== "enabled") {
      continue;
    }
    const catalog = await authority.getSyncCatalog(installation.id);
    members.push(...catalog.members);
    for (const state of await authority.listSyncStates(installation.id)) {
      states.set(state.stream_key, state);
    }
  }
  return domainSyncPhaseForThread(threadId, members, states);
}

export async function shouldDeferWorkForThread(
  authority: SyncPhaseAuthority,
  orgId: string,
  threadId: string,
): Promise<boolean> {
  const phase = await syncPhaseForThread(authority, orgId, threadId);
  return shouldDeferWorkForSync({ requires_full_sync: true, phase });
}
