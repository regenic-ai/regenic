import type { ContentPart } from "./ingestion";

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
}

export interface DeliveryReceipt {
  accepted: boolean;
  rpc_id?: string;
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
}

export class MemoryEgressRegistry implements EgressRegistry {
  private readonly byInstall = new Map<string, Map<string, RegisteredEgress>>();

  register(
    installationId: string,
    adapter: RegisteredEgress,
    streamKey = "",
  ): () => void {
    let adapters = this.byInstall.get(installationId);
    if (!adapters) {
      adapters = new Map();
      this.byInstall.set(installationId, adapters);
    }
    if (adapters.has(streamKey)) {
      throw new Error(
        streamKey
          ? `Egress adapter already registered: ${installationId}:${streamKey}`
          : `Egress adapter already registered: ${installationId}`,
      );
    }
    adapters.set(streamKey, adapter);
    return () => {
      adapters.delete(streamKey);
      if (adapters.size === 0) {
        this.byInstall.delete(installationId);
      }
    };
  }

  get(
    installationId: string,
    streamKey?: string,
  ): RegisteredEgress | undefined {
    const adapters = this.byInstall.get(installationId);
    if (!adapters || adapters.size === 0) {
      return undefined;
    }
    if (streamKey !== undefined) {
      return adapters.get(streamKey);
    }
    if (adapters.size === 1) {
      return [...adapters.values()][0];
    }
    return adapters.get("");
  }
}
