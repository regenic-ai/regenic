import { randomUUID } from "node:crypto";
import {
  DEFAULT_BOOTSTRAP_DUE_WORK_CLAIM_LIMIT,
  DEFAULT_DUE_WORK_CLAIM_LIMIT,
  DueWorkClaimLimiter,
  InstallationQuotaBook,
  MAX_DUE_WORK_CLAIM_LIMIT,
  MIN_DUE_WORK_CLAIM_LIMIT,
} from "@regenic/domain";
import type {
  ChannelDriverRegistry,
  ConnectorInstallation,
  ConnectorPollRunResult,
  ConnectorRuntimeStore,
  ConnectorSecrets,
  ConnectorStream,
} from "@regenic/domain";
import type { KernelRuntimeService } from "./kernel-runtime.service";
import type { PersonalInboxService } from "./personal-inbox.service";
import type { PersonalRuntimeService } from "./personal-runtime.service";
import type { CreatedConversationView } from "./personal-connector-types";

export interface ConnectorFocusSlot {
  threadId: string;
  generation: number;
  kind: "hydrate" | "live" | "older" | "media" | "receipt";
  abort: AbortController;
  promise: Promise<void>;
}

/** One explicitly owned coordination state per PersonalConnectorService instance. */
export interface ConnectorState {
  readonly runtime: Pick<PersonalRuntimeService, "orgId" | "requireHost">;
  readonly inbox: Pick<PersonalInboxService,
    "listInbox" | "publishInboxDigest" | "publishThreadUpdated" | "touchInboxDigest">;
  readonly drivers: ChannelDriverRegistry;
  readonly kernelRuntime: Pick<KernelRuntimeService,
    "clearInstallationSnapshots" | "pressureView" | "publishInstallAttempt" | "publishSyncSnapshot" | "shouldDeferHistorySync">;
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
  catchUp(installationId: string): Promise<void>;
}

type ConnectorDependencies = Pick<ConnectorState,
  "runtime" | "inbox" | "drivers" | "kernelRuntime" | "exclusiveStream" |
  "publishStreams" | "rememberStreamMeta" | "rememberStreamPace" | "requireInstallation" | "installSecrets" | "catchUp"
> & { maintenanceHeld(): boolean };

export function createConnectorState(input: ConnectorDependencies): ConnectorState {
  const { maintenanceHeld, ...dependencies } = input;
  return {
    ...dependencies,
    get maintenanceHold() {
      return maintenanceHeld();
    },
    quota: new InstallationQuotaBook(),
    streamCatchingUp: new Set(),
    streamMeta: new Map(),
    streamPulling: new Set(),
    streamPullingHistory: new Set(),
    focusSlot: null,
    focusGeneration: 0,
    hydrateCooldown: new Map(),
    liveKickCooldown: new Map(),
    dueWorkOwner: `personal-due:${randomUUID()}`,
    dueWorkLimiters: {
      steady: new DueWorkClaimLimiter(
        MIN_DUE_WORK_CLAIM_LIMIT, MAX_DUE_WORK_CLAIM_LIMIT, DEFAULT_DUE_WORK_CLAIM_LIMIT,
      ),
      bootstrap: new DueWorkClaimLimiter(
        MIN_DUE_WORK_CLAIM_LIMIT, MAX_DUE_WORK_CLAIM_LIMIT, DEFAULT_BOOTSTRAP_DUE_WORK_CLAIM_LIMIT,
      ),
    },
    creatingByClient: new Map(),
    catalogSizeByInstall: new Map(),
  };
}

export type ConnectorConversationState = Pick<ConnectorState,
  "runtime" | "drivers" | "quota" | "creatingByClient" | "catchUp">;
export type ConnectorInstallState = Pick<ConnectorState,
  "runtime" | "drivers" | "kernelRuntime" | "requireInstallation" | "installSecrets" | "catchUp">;
export type ConnectorEgressState = Pick<ConnectorState,
  "runtime" | "drivers" | "requireInstallation" | "installSecrets">;
export type ConnectorWebhookState = Pick<ConnectorState,
  "runtime" | "drivers" | "inbox" | "maintenanceHold" | "quota" | "requireInstallation">;
export type ConnectorDueWorkState = Pick<ConnectorState,
  "runtime" | "drivers" | "inbox" | "kernelRuntime" | "quota" | "maintenanceHold" |
  "catalogSizeByInstall" | "dueWorkLimiters" | "dueWorkOwner" | "exclusiveStream" |
  "publishStreams" | "rememberStreamMeta" | "rememberStreamPace" | "requireInstallation" |
  "streamCatchingUp" | "streamPulling" | "streamPullingHistory">;
export type ConnectorLiveState = Pick<ConnectorState,
  "runtime" | "drivers" | "inbox" | "quota" | "maintenanceHold" | "exclusiveStream" |
  "focusSlot" | "focusGeneration" | "hydrateCooldown" | "liveKickCooldown" |
  "publishStreams" | "rememberStreamMeta" | "rememberStreamPace" | "requireInstallation" |
  "streamMeta" | "streamPulling" | "streamPullingHistory">;
