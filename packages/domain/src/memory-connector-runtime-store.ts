import type {
  AcquireConnectorLease,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  IngestAttempt,
  NewConnectorInstallation,
  NewIngestAttempt,
  ReleaseConnectorLease,
  SettleIngestAttempt,
} from "./ingestion";

interface StoredCursor extends ConnectorStreamCursor {
  lease_owner?: string;
  lease_expires_at?: string;
}

function cursorKey(installationId: string, streamKey: string): string {
  return JSON.stringify([installationId, streamKey]);
}

export class MemoryConnectorRuntimeStore implements ConnectorRuntimeStore {
  private readonly installations = new Map<string, ConnectorInstallation>();
  private readonly cursors = new Map<string, StoredCursor>();
  private readonly attempts = new Map<string, IngestAttempt>();

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    const installation: ConnectorInstallation = {
      ...input,
      config: { ...input.config },
      credentials_ref: input.credentials_ref,
      updated_at: input.created_at,
    };
    this.installations.set(installation.id, installation);
    return this.copyInstallation(installation);
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    const installation = this.installations.get(id);
    return installation ? this.copyInstallation(installation) : null;
  }

  async acquireLease(
    input: AcquireConnectorLease,
  ): Promise<ConnectorLease | null> {
    const key = cursorKey(input.installation_id, input.stream_key);
    const current = this.cursors.get(key);
    if (
      current?.lease_expires_at &&
      current.lease_expires_at > input.now &&
      current.lease_owner !== input.lease_owner
    ) {
      return null;
    }

    const lease: StoredCursor = {
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      cursor: current?.cursor,
      cursor_version: current?.cursor_version ?? 1,
      updated_at: input.now,
      lease_owner: input.lease_owner,
      lease_expires_at: new Date(
        new Date(input.now).getTime() + input.lease_duration_ms,
      ).toISOString(),
    };
    this.cursors.set(key, lease);
    return this.copyLease(lease);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    const key = cursorKey(input.installation_id, input.stream_key);
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.lease_owner !== input.lease_owner) {
      return false;
    }
    this.cursors.set(key, {
      ...cursor,
      lease_owner: undefined,
      lease_expires_at: undefined,
      updated_at: input.now,
    });
    return true;
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    const attempt: IngestAttempt = {
      ...input,
      status: "running",
      accepted_count: 0,
      duplicate_count: 0,
      quarantined_count: 0,
      retryable_failure_count: 0,
    };
    this.attempts.set(attempt.id, attempt);
    return { ...attempt };
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    const attempt = this.attempts.get(input.attempt_id);
    if (!attempt) {
      throw new Error(`Ingest attempt not found: ${input.attempt_id}`);
    }
    const key = cursorKey(input.installation_id, input.stream_key);
    const cursor = this.cursors.get(key);
    if (cursor?.lease_owner !== input.lease_owner) {
      throw new Error("Connector lease is not held by the attempt owner");
    }

    const settled: IngestAttempt = {
      ...attempt,
      finished_at: input.finished_at,
      status: input.retryable_failure_count === 0 ? "succeeded" : "failed",
      accepted_count: input.accepted_count,
      duplicate_count: input.duplicate_count,
      quarantined_count: input.quarantined_count,
      retryable_failure_count: input.retryable_failure_count,
      error_code: input.error_code,
    };
    this.attempts.set(settled.id, settled);

    this.cursors.set(key, {
      ...cursor,
      cursor:
        input.retryable_failure_count === 0 && input.next_cursor !== undefined
          ? input.next_cursor
          : cursor.cursor,
      cursor_version:
        input.retryable_failure_count === 0 && input.next_cursor !== undefined
          ? cursor.cursor_version + 1
          : cursor.cursor_version,
      updated_at: input.finished_at,
      lease_owner: undefined,
      lease_expires_at: undefined,
    });
    return { ...settled };
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    const cursor = this.cursors.get(cursorKey(installationId, streamKey));
    return cursor ? this.copyCursor(cursor) : null;
  }

  private copyInstallation(
    installation: ConnectorInstallation,
  ): ConnectorInstallation {
    return { ...installation, config: { ...installation.config } };
  }

  private copyCursor(cursor: StoredCursor): ConnectorStreamCursor {
    return {
      installation_id: cursor.installation_id,
      stream_key: cursor.stream_key,
      cursor: cursor.cursor,
      cursor_version: cursor.cursor_version,
      updated_at: cursor.updated_at,
    };
  }

  private copyLease(cursor: StoredCursor): ConnectorLease {
    return {
      ...this.copyCursor(cursor),
      lease_owner: cursor.lease_owner!,
      lease_expires_at: cursor.lease_expires_at!,
    };
  }
}