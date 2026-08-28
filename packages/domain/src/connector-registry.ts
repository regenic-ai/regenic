import { ChannelDriverError, type ConnectorStream } from "./channel-driver";
import type { ChannelConnector } from "./ingestion";

export type RegisteredConnector = Pick<ChannelConnector, "source"> & {
  poll: NonNullable<ChannelConnector["poll"]>;
  source_mode?: ChannelConnector["source_mode"];
  quota?: ChannelConnector["quota"];
};

export interface ConnectorStreamBinding {
  stream_key?: string;
  thread_id?: string;
  label?: string;
  pace?: ConnectorStream["pace"];
}

export interface ConnectorRegistry {
  register(
    installationId: string,
    connector: RegisteredConnector,
    binding?: ConnectorStreamBinding,
  ): () => void;
  get(
    installationId: string,
    streamKey?: string,
  ): RegisteredConnector | undefined;
  getStream(
    installationId: string,
    streamKey?: string,
  ): ConnectorStream | undefined;
  listStreams(installationId: string): ConnectorStream[];
  unregister(installationId: string, streamKey: string): boolean;
}

interface StoredStream {
  stream_key: string;
  connector: RegisteredConnector;
  thread_id?: string;
  label?: string;
  pace?: ConnectorStream["pace"];
}

export class MemoryConnectorRegistry implements ConnectorRegistry {
  private readonly byInstall = new Map<string, Map<string, StoredStream>>();

  register(
    installationId: string,
    connector: RegisteredConnector,
    binding: ConnectorStreamBinding = {},
  ): () => void {
    const streamKey = binding.stream_key ?? "";
    let streams = this.byInstall.get(installationId);
    if (!streams) {
      streams = new Map();
      this.byInstall.set(installationId, streams);
    }
    if (streams.has(streamKey)) {
      throw new Error(
        streamKey
          ? `Connector already registered: ${installationId}:${streamKey}`
          : `Connector already registered: ${installationId}`,
      );
    }
    streams.set(streamKey, {
      stream_key: streamKey,
      connector,
      thread_id: binding.thread_id,
      label: binding.label,
      pace: binding.pace,
    });
    return () => {
      streams.delete(streamKey);
      if (streams.size === 0) {
        this.byInstall.delete(installationId);
      }
    };
  }

  get(
    installationId: string,
    streamKey?: string,
  ): RegisteredConnector | undefined {
    return this.storedStream(installationId, streamKey)?.connector;
  }

  getStream(
    installationId: string,
    streamKey?: string,
  ): ConnectorStream | undefined {
    const stored = this.storedStream(installationId, streamKey);
    return stored ? toConnectorStream(stored) : undefined;
  }

  listStreams(installationId: string): ConnectorStream[] {
    const streams = this.byInstall.get(installationId);
    if (!streams) {
      return [];
    }
    return [...streams.values()].map(toConnectorStream);
  }

  unregister(installationId: string, streamKey: string): boolean {
    const streams = this.byInstall.get(installationId);
    if (!streams?.delete(streamKey)) {
      return false;
    }
    if (streams.size === 0) {
      this.byInstall.delete(installationId);
    }
    return true;
  }

  private storedStream(
    installationId: string,
    streamKey?: string,
  ): StoredStream | undefined {
    const streams = this.byInstall.get(installationId);
    if (!streams || streams.size === 0) {
      return undefined;
    }
    if (streamKey !== undefined) {
      return streams.get(streamKey);
    }
    if (streams.size === 1) {
      return [...streams.values()][0];
    }
    return streams.get("");
  }
}

export function requireConnectorStream(
  registry: ConnectorRegistry,
  installationId: string,
  streamKey?: string,
): ConnectorStream {
  const stream = registry.getStream(installationId, streamKey);
  if (!stream) {
    throw new ChannelDriverError("sync_failed", "Connector failed to mount");
  }
  return stream;
}

function toConnectorStream(stored: StoredStream): ConnectorStream {
  return {
    stream_key: stored.stream_key,
    connector: stored.connector,
    thread_id: stored.thread_id,
    label: stored.label,
    pace: stored.pace,
  };
}
