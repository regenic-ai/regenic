import type { ChannelConnector } from "./ingestion";

export type RegisteredConnector = Pick<ChannelConnector, "poll" | "source">;

export interface ConnectorRegistry {
  register(installationId: string, connector: RegisteredConnector): () => void;
  get(installationId: string): RegisteredConnector | undefined;
}

export class MemoryConnectorRegistry implements ConnectorRegistry {
  private readonly connectors = new Map<string, RegisteredConnector>();

  register(installationId: string, connector: RegisteredConnector): () => void {
    if (this.connectors.has(installationId)) {
      throw new Error(`Connector already registered: ${installationId}`);
    }
    this.connectors.set(installationId, connector);
    return () => {
      this.connectors.delete(installationId);
    };
  }

  get(installationId: string): RegisteredConnector | undefined {
    return this.connectors.get(installationId);
  }
}
