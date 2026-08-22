import type { Host } from "@regenic/plugin-host";
import type { DeliveryReceipt, RegisteredEgress } from "./egress";
import type {
  ChannelConnector,
  ConnectorInstallation,
  NewConnectorInstallation,
} from "./ingestion";

export interface ConversationThread {
  source: string;
  target: string;
}

export interface ConnectorStream {
  stream_key: string;
  connector: Pick<ChannelConnector, "poll">;
}

export class ChannelDriverError extends Error {
  constructor(
    readonly code:
      | "invalid_config"
      | "missing_credentials"
      | "sync_failed"
      | "send_failed"
      | "unsupported_channel"
      | "no_sender",
    message: string,
  ) {
    super(message);
    this.name = "ChannelDriverError";
  }
}

export interface ChannelDriver {
  readonly connector_type: string;
  readonly source: string;
  install(input: {
    id: string;
    org_id: string;
    config: Record<string, unknown>;
    now: string;
  }): NewConnectorInstallation;
  matchesThread(
    installation: ConnectorInstallation,
    thread: ConversationThread,
  ): boolean;
  ownsThread(
    installation: ConnectorInstallation,
    thread: ConversationThread,
  ): boolean;
  canReply(installation: ConnectorInstallation): boolean;
  resolveStreams(
    installation: ConnectorInstallation,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<ConnectorStream[]>;
  resolveThreadStream(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<ConnectorStream>;
  bindEgress(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<RegisteredEgress>;
  outboundId(thread: ConversationThread, receipt: DeliveryReceipt): string;
}

export class ChannelDriverRegistry {
  private readonly drivers = new Map<string, ChannelDriver>();

  register(driver: ChannelDriver): this {
    this.drivers.set(driver.connector_type, driver);
    return this;
  }

  get(connectorType: string): ChannelDriver | undefined {
    return this.drivers.get(connectorType);
  }

  has(connectorType: string): boolean {
    return this.drivers.has(connectorType);
  }

  findForThread(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): { installation: ConnectorInstallation; driver: ChannelDriver } | undefined {
    const matches = installations.flatMap((installation) => {
      const driver = this.get(installation.connector_type);
      if (
        !driver ||
        installation.status !== "enabled" ||
        !driver.matchesThread(installation, thread)
      ) {
        return [];
      }
      return [{ installation, driver }];
    });
    return (
      matches.find((item) =>
        item.driver.ownsThread(item.installation, thread),
      ) ?? matches[0]
    );
  }

  canSend(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(found && found.driver.canReply(found.installation));
  }
}

export function parseConversationThread(threadId: string): ConversationThread {
  const colon = threadId.indexOf(":");
  if (colon <= 0 || colon === threadId.length - 1) {
    throw new ChannelDriverError(
      "invalid_config",
      "thread_id must look like source:target",
    );
  }
  return {
    source: threadId.slice(0, colon),
    target: threadId.slice(colon + 1),
  };
}
