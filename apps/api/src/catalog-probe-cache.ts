import type { ConnectorCatalogServiceState, CopyRef } from "@regenic/domain";

export const CATALOG_PROBE_TTL_MS = 20_000;

export interface CatalogProbeSnapshot {
  services: Record<string, ConnectorCatalogServiceState>;
  field_options: Record<
    string,
    Record<string, { value: string; label: CopyRef }[]>
  >;
  at: number;
}

export interface CatalogProbeSource {
  probeCatalog(env?: NodeJS.ProcessEnv): Promise<{
    services: CatalogProbeSnapshot["services"];
    field_options: CatalogProbeSnapshot["field_options"];
  }>;
}

function emptySnapshot(): CatalogProbeSnapshot {
  return { services: {}, field_options: {}, at: 0 };
}

/**
 * Last-known catalog readiness. GET /v1/me/engine never awaits a live probe.
 */
export class CatalogProbeCache {
  private snapshot: CatalogProbeSnapshot = emptySnapshot();
  private inflight: Promise<void> | null = null;

  peek(): CatalogProbeSnapshot {
    return this.snapshot;
  }

  schedule(
    drivers: CatalogProbeSource,
    env: NodeJS.ProcessEnv = process.env,
    now: () => number = Date.now,
  ): void {
    const stale =
      this.snapshot.at === 0 || now() - this.snapshot.at >= CATALOG_PROBE_TTL_MS;
    if (!stale || this.inflight) {
      return;
    }
    this.inflight = Promise.resolve()
      .then(() => drivers.probeCatalog(env))
      .then((probed) => {
        this.snapshot = {
          services: { ...this.snapshot.services, ...(probed.services ?? {}) },
          field_options: {
            ...this.snapshot.field_options,
            ...(probed.field_options ?? {}),
          },
          at: now(),
        };
      })
      .catch(() => {
        this.snapshot = { ...this.snapshot, at: now() };
      })
      .finally(() => {
        this.inflight = null;
      });
  }
}
