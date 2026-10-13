import type { ContentPart } from "./ingest";

export interface EgressCapabilities {
  reply: boolean;
  edit: boolean;
  tombstone: boolean;
}

export interface SendTarget {
  external_id?: string;
  scope_id?: string;
}

export interface SendIntent {
  installation_id: string;
  target?: SendTarget;
  content: ContentPart[];
  /** Stable key for at-least-once write-back. Drivers may ignore it. */
  idempotency_key?: string;
}

export interface DeliveryReceipt {
  accepted: boolean;
  /** Primary channel message id used for `:out:{rpc_id}` when present. */
  rpc_id?: string;
  /**
   * Every channel-native message id produced by this send (e.g. Feishu may
   * split text/images/files into multiple IM messages). Bound as source-identity
   * aliases of the local outbound Event so pull hits identity, not content echo.
   */
  channel_message_ids?: string[];
}

export interface EgressAdapter {
  readonly source: string;
  capabilities(): EgressCapabilities;
  send(intent: SendIntent): Promise<DeliveryReceipt>;
}

export type RegisteredEgress = Pick<EgressAdapter, "send" | "source" | "capabilities">;

export interface EgressRegistry {
  register(
    installationId: string,
    adapter: RegisteredEgress,
    streamKey?: string,
  ): () => void;
  get(installationId: string, streamKey?: string): RegisteredEgress | undefined;
  unregister(installationId: string, streamKey: string): boolean;
}
