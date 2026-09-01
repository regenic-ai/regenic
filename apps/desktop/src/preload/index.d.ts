export type KernelMode = "local" | "custom";
export type Locale = "en" | "zh";
export type DataPathSource = "env" | "settings" | "repo" | "default" | "relocated";
export type DataDirectoryAction = "migrate" | "empty" | "adopt" | "replace";

export interface DataDirectoryView {
  path: string;
  database: string;
  blobRoot: string;
  source: DataPathSource;
  envOverride: boolean;
  productRoot: string;
  checkoutRoot?: string;
  relocatedFrom?: string;
  splitLayout: boolean;
  canChange: boolean;
  remoteWarning: boolean;
}

export interface DataDirectoryPlan {
  path: string;
  currentRoot: string;
  sameAsCurrent: boolean;
  sourceHasData: boolean;
  destHasData: boolean;
  destLooksLikeStore: boolean;
  remoteWarning: boolean;
  relocatedTo?: string;
  pickedPath?: string;
  canChange: boolean;
  reason?: string;
}

export interface SourceRetentionView {
  path: string;
  size: string;
  bytes: number;
  canDelete: boolean;
}

export interface KernelSettingsView {
  mode: KernelMode;
  customOrigin: string;
  activeOrigin: string;
  hasSavedPersonalApiKey?: boolean;
  locale: Locale;
  dataDirectory: DataDirectoryView;
  sourceRetention?: SourceRetentionView;
}

export type HostWatchKind = "ok" | "attention" | "critical";

export interface HostDiskWatch {
  kind: HostWatchKind;
  total_bytes: number;
  free_bytes: number;
  used_bytes: number;
  data_bytes: number;
  path: string;
  hint: string | null;
}

export interface HostMemoryWatch {
  kind: HostWatchKind;
  kernel_bytes: number | null;
  app_bytes: number;
  used_bytes: number;
  kernel_alive: boolean | null;
  hint: string | null;
}

export interface HostStats {
  disk: HostDiskWatch;
  memory: HostMemoryWatch;
}

export interface RegenicDesktop {
  apiOrigin: string;
  getApiOrigin: () => Promise<string>;
  getKernelSettings: () => Promise<KernelSettingsView>;
  setKernelSettings: (input: {
    mode: KernelMode;
    origin?: string;
  }) => Promise<KernelSettingsView>;
  pickDataDirectory: () => Promise<DataDirectoryPlan | null>;
  setDataDirectory: (input: {
    path: string;
    action: DataDirectoryAction;
  }) => Promise<KernelSettingsView>;
  resolveSourceRetention: (input: {
    action: "keep" | "discard";
  }) => Promise<KernelSettingsView>;
  setLocale: (locale: Locale) => Promise<Locale>;
  onApiOriginChanged: (listener: (origin: string) => void) => () => void;
  onLocaleChanged: (listener: (locale: Locale) => void) => () => void;
  showConsole: () => Promise<void>;
  quitApp: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getHostStats: () => Promise<HostStats>;
}

declare global {
  interface Window {
    regenic: RegenicDesktop;
  }
}

export {};
