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
  register(installationId: string, adapter: RegisteredEgress): () => void;
  get(installationId: string): RegisteredEgress | undefined;
}

export class MemoryEgressRegistry implements EgressRegistry {
  private readonly adapters = new Map<string, RegisteredEgress>();

  register(installationId: string, adapter: RegisteredEgress): () => void {
    if (this.adapters.has(installationId)) {
      throw new Error(`Egress adapter already registered: ${installationId}`);
    }
    this.adapters.set(installationId, adapter);
    return () => {
      this.adapters.delete(installationId);
    };
  }

  get(installationId: string): RegisteredEgress | undefined {
    return this.adapters.get(installationId);
  }
}
