import type {
  EgressRegistry,
  RegisteredEgress,
} from "@regenic/connector-contract";

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

  unregister(installationId: string, streamKey: string): boolean {
    const adapters = this.byInstall.get(installationId);
    if (!adapters?.delete(streamKey)) {
      return false;
    }
    if (adapters.size === 0) {
      this.byInstall.delete(installationId);
    }
    return true;
  }
}
