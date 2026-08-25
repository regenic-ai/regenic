export type KernelMode = "local" | "custom";
export type Locale = "en" | "zh";

export interface KernelSettingsView {
  mode: KernelMode;
  customOrigin: string;
  activeOrigin: string;
  locale: Locale;
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
  setLocale: (locale: Locale) => Promise<Locale>;
  onApiOriginChanged: (listener: (origin: string) => void) => () => void;
  onLocaleChanged: (listener: (locale: Locale) => void) => () => void;
  showConsole: () => Promise<void>;
  quitApp: () => Promise<void>;
  getHostStats: () => Promise<HostStats>;
}

declare global {
  interface Window {
    regenic: RegenicDesktop;
  }
}

export {};
