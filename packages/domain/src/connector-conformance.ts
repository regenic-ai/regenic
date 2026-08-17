import type { ChannelConnector, ConnectorCursor, IngestBatch, JsonValue } from "./ingestion";
import { validateIngestBatch } from "./ingestion-schema";

export class ConnectorConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorConformanceError";
  }
}

export interface PollConnectorConformanceInput {
  connector: Pick<ChannelConnector, "poll">;
  cursor: ConnectorCursor | null;
  connector_id: string;
  source: string;
}

export interface PollConnectorConformanceReport {
  delivery_id: string;
  record_count: number;
  next_cursor?: string;
}

export async function verifyPollConnectorConformance(
  input: PollConnectorConformanceInput,
): Promise<PollConnectorConformanceReport> {
  const first = await input.connector.poll(input.cursor);
  const replay = await input.connector.poll(input.cursor);
  assertValidBatch(first.batch, input);
  assertValidBatch(replay.batch, input);
  if (first.next_cursor !== first.batch.next_cursor) {
    throw new ConnectorConformanceError("PollResult next_cursor must match batch next_cursor");
  }
  if (replay.next_cursor !== replay.batch.next_cursor) {
    throw new ConnectorConformanceError("Replay next_cursor must match batch next_cursor");
  }
  if (stableBatch(first.batch) !== stableBatch(replay.batch)) {
    throw new ConnectorConformanceError("Polling the same cursor must produce a stable batch");
  }
  return {
    delivery_id: first.batch.delivery_id,
    record_count: first.batch.records.length,
    next_cursor: first.next_cursor,
  };
}

function assertValidBatch(
  batch: IngestBatch,
  input: PollConnectorConformanceInput,
): void {
  const validation = validateIngestBatch(batch);
  if (!validation.success) {
    throw new ConnectorConformanceError(`Connector emitted an invalid batch: ${validation.error_code}`);
  }
  if (batch.connector_id !== input.connector_id) {
    throw new ConnectorConformanceError("Connector emitted an unexpected connector_id");
  }
  const identities = new Set<string>();
  for (const record of batch.records) {
    if (record.source !== input.source) {
      throw new ConnectorConformanceError("Connector emitted an unexpected record source");
    }
    const identity = JSON.stringify([record.source, record.external_id]);
    if (identities.has(identity)) {
      throw new ConnectorConformanceError("Connector emitted duplicate source identities in one page");
    }
    identities.add(identity);
  }
}

function stableBatch(batch: IngestBatch): string {
  const { received_at: _receivedAt, ...stable } = batch;
  return stableSerialize(stable);
}

function stableSerialize(value: unknown): string {
  if (value instanceof Uint8Array) {
    return JSON.stringify({ bytes: Buffer.from(value).toString("base64") });
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value as JsonValue);
}