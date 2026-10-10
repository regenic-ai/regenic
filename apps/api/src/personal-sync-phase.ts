import {
  shouldDeferWorkForSync,
  type SyncCatalogMember,
  type SyncPhase,
} from "@regenic/domain";

type SyncPhaseAuthority = {
  listInstallations(orgId: string): Promise<Array<{ id: string; status: string }>>;
  getSyncCatalog(installationId: string): Promise<{ members: SyncCatalogMember[] }>;
  listSyncPhaseHeads(
    installationId: string,
  ): Promise<Array<{ stream_key: string; phase: SyncPhase }>>;
};

export type OrgSyncPhaseIndex = Map<string, SyncPhase>;

const PHASE_INDEX_TTL_MS = 2_000;

let cachedOrgId: string | null = null;
let cachedAt = 0;
let cachedIndex: OrgSyncPhaseIndex | null = null;

/** Drop the process-local phase index (tests / after catalog writes). */
export function clearOrgSyncPhaseIndex(orgId?: string): void {
  if (!orgId || cachedOrgId === orgId) {
    cachedOrgId = null;
    cachedAt = 0;
    cachedIndex = null;
  }
}

/**
 * Load enabled-install catalog members once and map thread_id → phase.
 * Avoids N× getSyncCatalog + listSyncStates on each projection/work gate.
 */
export async function loadOrgSyncPhaseIndex(
  authority: SyncPhaseAuthority,
  orgId: string,
  now = Date.now(),
): Promise<OrgSyncPhaseIndex> {
  if (
    cachedIndex &&
    cachedOrgId === orgId &&
    now - cachedAt < PHASE_INDEX_TTL_MS
  ) {
    return cachedIndex;
  }
  const installations = await authority.listInstallations(orgId);
  const index: OrgSyncPhaseIndex = new Map();
  for (const installation of installations) {
    if (installation.status !== "enabled") {
      continue;
    }
    const catalog = await authority.getSyncCatalog(installation.id);
    const states = new Map<string, SyncPhase>();
    for (const state of await authority.listSyncPhaseHeads(installation.id)) {
      states.set(state.stream_key, state.phase);
    }
    for (const member of catalog.members) {
      const threadId = member.thread_id?.trim();
      if (!threadId || index.has(threadId)) {
        continue;
      }
      const phase = states.get(member.stream_key);
      if (phase) {
        index.set(threadId, phase);
      }
    }
  }
  cachedOrgId = orgId;
  cachedAt = now;
  cachedIndex = index;
  return index;
}

export function syncPhaseFromIndex(
  index: OrgSyncPhaseIndex,
  threadId: string,
): SyncPhase | undefined {
  return index.get(threadId);
}

export async function syncPhaseForThread(
  authority: SyncPhaseAuthority,
  orgId: string,
  threadId: string,
): Promise<SyncPhase | undefined> {
  const index = await loadOrgSyncPhaseIndex(authority, orgId);
  return syncPhaseFromIndex(index, threadId);
}

export async function shouldDeferWorkForThread(
  authority: SyncPhaseAuthority,
  orgId: string,
  threadId: string,
): Promise<boolean> {
  const phase = await syncPhaseForThread(authority, orgId, threadId);
  return shouldDeferWorkForSync({ requires_full_sync: true, phase });
}

/** Continuous projection is best-effort: only wait for the first seed. */
export function shouldDeferProjectionForPhase(
  phase: SyncPhase | undefined,
): boolean {
  return phase === "unseeded";
}
