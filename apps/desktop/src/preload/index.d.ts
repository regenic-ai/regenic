export interface RegenicDesktop {
  apiOrigin: string;
  showConsole: () => Promise<void>;
  quitApp: () => Promise<void>;
}

declare global {
  interface Window {
    regenic: RegenicDesktop;
  }
}

export {};
