import type { ConnectorStreamDescriptor } from "@regenic/connector-contract";
import type {
  ChannelConnector,
  ConnectorCursor,
  ConnectorPollOptions,
  ConnectorQuotaHint,
  ConnectorSourceMode,
  IngestBatch,
  PollResult,
  VerifiedWebhook,
  WebhookRequest,
} from "./ingestion";
import type { ConnectorStream } from "./channel-driver";

/**
 * Core-facing invocation port. Core owns scheduling and persistence; an
 * adapter owns how connector code is reached (embedded, stdio, or RPC).
 */
export interface ConnectorRuntimeInvoker {
  readonly source: string;
  readonly source_mode?: ConnectorSourceMode;
  readonly quota?: ConnectorQuotaHint;
  poll?(
    cursor: ConnectorCursor | null,
    options?: ConnectorPollOptions,
  ): Promise<PollResult>;
  verifyWebhook?(request: WebhookRequest): Promise<VerifiedWebhook>;
  handleWebhook?(webhook: VerifiedWebhook): Promise<IngestBatch>;
}

export class InProcessConnectorInvoker implements ConnectorRuntimeInvoker {
  constructor(private readonly connector: ChannelConnector) {}

  get source(): string {
    return this.connector.source;
  }

  get source_mode(): ConnectorSourceMode | undefined {
    return this.connector.source_mode;
  }

  get quota(): ConnectorQuotaHint | undefined {
    return this.connector.quota;
  }

  poll(
    cursor: ConnectorCursor | null,
    options?: ConnectorPollOptions,
  ): Promise<PollResult> {
    if (!this.connector.poll) {
      throw new Error("Connector does not expose poll");
    }
    return this.connector.poll(cursor, options);
  }

  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    if (!this.connector.verifyWebhook) {
      throw new Error("Connector does not expose verifyWebhook");
    }
    return this.connector.verifyWebhook(request);
  }

  handleWebhook(webhook: VerifiedWebhook): Promise<IngestBatch> {
    if (!this.connector.handleWebhook) {
      throw new Error("Connector does not expose handleWebhook");
    }
    return this.connector.handleWebhook(webhook);
  }
}

export function asConnectorRuntimeInvoker(
  connector: ConnectorRuntimeInvoker | ChannelConnector,
): ConnectorRuntimeInvoker {
  return connector instanceof InProcessConnectorInvoker
    ? connector
    : new InProcessConnectorInvoker(connector as ChannelConnector);
}

/**
 * Converts an in-process stream into the data-only shape used at a remote
 * connector-host boundary. No callback or credential crosses this boundary.
 */
export function connectorStreamDescriptor(
  stream: Pick<
    ConnectorStream,
    "stream_key" | "thread_id" | "label" | "pace"
  >,
): ConnectorStreamDescriptor {
  return {
    stream_key: stream.stream_key,
    ...(stream.thread_id ? { thread_id: stream.thread_id } : {}),
    ...(stream.label ? { label: stream.label } : {}),
    ...(stream.pace
      ? {
          pace: {
            ...(stream.pace.idle_ms === undefined
              ? {}
              : { idle_ms: stream.pace.idle_ms }),
            ...(stream.pace.catch_up_pages === undefined
              ? {}
              : { catch_up_pages: stream.pace.catch_up_pages }),
          },
        }
      : {}),
  };
}
