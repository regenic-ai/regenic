import type {
  ChannelDriverRegistry,
  ConnectorInstallation,
  ConnectorPollRunResult,
  ConnectorRuntimeStore,
  ConnectorSecrets,
  ConnectorStream,
  DueWorkClaimLimiter,
  InstallationQuotaBook,
} from "@regenic/domain";
import type { KernelRuntimeService } from "./kernel-runtime.service";
import type { PersonalInboxService } from "./personal-inbox.service";
import type { PersonalRuntimeService } from "./personal-runtime.service";
import type { CreatedConversationView } from "./personal-connector.service";

export interface ConnectorFocusSlot {
  threadId: string;
  generation: number;
  kind: "hydrate" | "live" | "older" | "media" | "receipt";
  abort: AbortController;
  promise: Promise<void>;
}

/**
 * Mutable personal-connector state. Timers, leases, and these fields stay on
 * PersonalConnectorService; extracted functions borrow the same instance.
 */
export interface ConnectorState {
  readonly runtime: PersonalRuntimeService;
  readonly inbox: PersonalInboxService;
  readonly drivers: ChannelDriverRegistry;
  readonly kernelRuntime: KernelRuntimeService;
  readonly quota: InstallationQuotaBook;
  readonly streamCatchingUp: Set<string>;
  readonly streamMeta: Map<
    string,
    { thread_id: string | null; label: string | null }
  >;
  readonly streamPulling: Set<string>;
  readonly streamPullingHistory: Set<string>;
  focusSlot: ConnectorFocusSlot | null;
  focusGeneration: number;
  readonly hydrateCooldown: Map<string, number>;
  readonly liveKickCooldown: Map<string, number>;
  readonly maintenanceHold: boolean;
  readonly dueWorkOwner: string;
  readonly dueWorkLimiters: {
    steady: DueWorkClaimLimiter;
    bootstrap: DueWorkClaimLimiter;
  };
  readonly creatingByClient: Map<string, Promise<CreatedConversationView>>;
  readonly catalogSizeByInstall: Map<string, number>;
  exclusiveStream<T>(
    installationId: string,
    streamKey: string,
    work: () => Promise<T>,
    options?: { skipIfBusy?: boolean; ahead?: boolean },
  ): Promise<T | undefined>;
  publishStreams(): void;
  rememberStreamMeta(key: string, stream: ConnectorStream): void;
  rememberStreamPace(input: {
    key: string;
    pages: ConnectorPollRunResult[];
    pagesBudget: number;
    idleMs?: number;
    error?: unknown;
  }): void;
  requireInstallation(
    store: ConnectorRuntimeStore,
    installationId: string,
  ): Promise<ConnectorInstallation>;
  installSecrets(): ConnectorSecrets;
}
