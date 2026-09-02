import type { InboxSummary } from "./ingestion";

/** Cached result of `summarizeInbox` — refreshed on ingest, not on every read. */
export interface InboxSummarySnapshot extends InboxSummary {
  org_id: string;
  updated_at: string;
}

export class InboxSummarySnapshotStore {
  private snapshot: InboxSummarySnapshot | null = null;

  publish(input: InboxSummarySnapshot): InboxSummarySnapshot {
    this.snapshot = input;
    return input;
  }

  peek(orgId: string): InboxSummarySnapshot | null {
    if (!this.snapshot || this.snapshot.org_id !== orgId) {
      return null;
    }
    return this.snapshot;
  }

  summary(orgId: string): InboxSummary | null {
    const hit = this.peek(orgId);
    if (!hit) {
      return null;
    }
    return { count: hit.count, digest: hit.digest };
  }

  clear(orgId?: string): void {
    if (!orgId || this.snapshot?.org_id === orgId) {
      this.snapshot = null;
    }
  }
}
