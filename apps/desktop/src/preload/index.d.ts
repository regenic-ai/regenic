export type KernelMode = "local" | "custom";

export interface KernelSettingsView {
  mode: KernelMode;
  customOrigin: string;
  activeOrigin: string;
}

export interface RegenicDesktop {
  apiOrigin: string;
  getApiOrigin: () => Promise<string>;
  getKernelSettings: () => Promise<KernelSettingsView>;
  setKernelSettings: (input: {
    mode: KernelMode;
    origin?: string;
  }) => Promise<KernelSettingsView>;
  onApiOriginChanged: (listener: (origin: string) => void) => () => void;
  showConsole: () => Promise<void>;
  quitApp: () => Promise<void>;
}

declare global {
  interface Window {
    regenic: RegenicDesktop;
  }
}

export {};
