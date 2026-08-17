import type {
  AcquireConnectorLease,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  IngestAttempt,
  IngestQuarantine,
  NewConnectorInstallation,
  NewIngestAttempt,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationStatus,
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
  private readonly quarantines: IngestQuarantine[] = [];

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

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    return [...this.installations.values()]
      .filter((installation) => installation.org_id === orgId)
      .map((installation) => this.copyInstallation(installation));
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    const installation = this.installations.get(input.id);
    if (!installation || installation.org_id !== input.org_id) {
      return null;
    }
    const updated = {
      ...installation,
      status: input.status,
      updated_at: input.updated_at,
    };
    this.installations.set(updated.id, updated);
    return this.copyInstallation(updated);
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

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    const key = cursorKey(input.installation_id, input.stream_key);
    const cursor = this.cursors.get(key);
    if (!cursor) {
      return null;
    }
    if (cursor.lease_expires_at && cursor.lease_expires_at > input.now) {
      throw new Error("Connector cursor is leased and cannot be reset");
    }
    const reset = {
      ...cursor,
      cursor: undefined,
      cursor_version: cursor.cursor_version + 1,
      lease_owner: undefined,
      lease_expires_at: undefined,
      updated_at: input.now,
    };
    this.cursors.set(key, reset);
    return this.copyCursor(reset);
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
    this.quarantines.push(
      ...input.quarantines.map((quarantine) => ({
        ...quarantine,
        safe_metadata: { ...quarantine.safe_metadata },
        attempt_id: input.attempt_id,
        connector_installation_id: input.installation_id,
        stream_key: input.stream_key,
      })),
    );

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

  async listAttempts(installationId: string): Promise<IngestAttempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.connector_installation_id === installationId)
      .map((attempt) => ({ ...attempt }));
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    return this.quarantines
      .filter((quarantine) => quarantine.connector_installation_id === installationId)
      .map((quarantine) => ({
        ...quarantine,
        safe_metadata: { ...quarantine.safe_metadata },
      }));
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