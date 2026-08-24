import type {
  ArrangementDecision,
  AuthorityStore,
  BlobRecord,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  ConversationPref,
  ConversationPrefPatch,
  EventListQuery,
  EventRecord,
  EventRevision,
  InboxItem,
  InboxQuery,
  InboxSummary,
  IngestAttempt,
  IngestCommitRequest,
  IngestQuarantine,
  NewConnectorInstallation,
  NewEvent,
  NewIngestAttempt,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  SourceIdentity,
  TombstoneEvent,
} from "@regenic/domain";
import { SqliteAuthorityStore } from "./sqlite-authority-store";
import { SqliteWriteClient } from "./sqlite-write-client";

export class SqliteSplitAuthorityStore
  implements AuthorityStore, ConnectorRuntimeStore
{
  private constructor(
    private readonly reader: SqliteAuthorityStore,
    private readonly writer: SqliteWriteClient,
  ) {}

  static async open(path: string): Promise<SqliteSplitAuthorityStore> {
    const writer = await SqliteWriteClient.open(path);
    try {
      const reader = new SqliteAuthorityStore(path, { readonly: true });
      return new SqliteSplitAuthorityStore(reader, writer);
    } catch (error) {
      await writer.close();
      throw error;
    }
  }

  get readonly(): boolean {
    return this.reader.readonly;
  }

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    return this.reader.findBlob(contentHash);
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    return this.reader.findBlobs(contentHashes);
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.reader.findBySourceIdentity(identity);
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    return this.reader.getEvent(orgId, eventId);
  }

  async listEvents(
    orgId: string,
    query?: EventListQuery,
  ): Promise<EventRecord[]> {
    return this.reader.listEvents(orgId, query);
  }

  async getDisposition(
    eventId: string,
  ): Promise<ArrangementDecision | null> {
    return this.reader.getDisposition(eventId);
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    return this.reader.listInbox(orgId, query);
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    return this.reader.summarizeInbox(orgId);
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    return this.reader.listConversationPrefs(orgId);
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null> {
    return this.reader.getConversationPref(orgId, threadId);
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    return this.reader.findInstallation(id);
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    return this.reader.listInstallations(orgId);
  }

  async listAttempts(installationId: string): Promise<IngestAttempt[]> {
    return this.reader.listAttempts(installationId);
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    return this.reader.listQuarantines(installationId);
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    return this.reader.getCursor(installationId, streamKey);
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.writer.call("append", [input]);
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return this.writer.call("appendRevision", [input]);
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    return this.writer.call("markTombstone", [input]);
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    return this.writer.call("commitIngest", [request]);
  }

  async putDisposition(decision: ArrangementDecision): Promise<void> {
    await this.writer.call("putDisposition", [decision]);
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    return this.writer.call("putConversationPref", [input]);
  }

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    return this.writer.call("createInstallation", [input]);
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    return this.writer.call("setInstallationStatus", [input]);
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    return this.writer.call("updateInstallationConfig", [input]);
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    return this.writer.call("deleteInstallation", [id, orgId]);
  }

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
  }): Promise<ConnectorLease | null> {
    return this.writer.call("acquireLease", [input]);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    return this.writer.call("releaseLease", [input]);
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    return this.writer.call("resetCursor", [input]);
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    return this.writer.call("beginAttempt", [input]);
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    return this.writer.call("settleAttempt", [input]);
  }

  /** @internal Holds the writer so tests can prove inbox reads do not wait. */
  stallWriter(ms: number): Promise<void> {
    return this.writer.call("__sleep", [ms]);
  }

  async close(): Promise<void> {
    this.reader.close();
    await this.writer.close();
  }
}
