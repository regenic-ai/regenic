import { contextBridge, ipcRenderer } from "electron";

function readApiOrigin(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--regenic-api="));
  return flag?.slice("--regenic-api=".length) ?? "http://127.0.0.1:4370";
}

contextBridge.exposeInMainWorld("regenic", {
  apiOrigin: readApiOrigin(),
  getApiOrigin: () => ipcRenderer.invoke("regenic:get-api-origin"),
  getKernelSettings: () => ipcRenderer.invoke("regenic:get-kernel-settings"),
  setKernelSettings: (input: { mode: "local" | "custom"; origin?: string }) =>
    ipcRenderer.invoke("regenic:set-kernel-settings", input),
  setLocale: (locale: "en" | "zh") => ipcRenderer.invoke("regenic:set-locale", locale),
  onApiOriginChanged: (listener: (origin: string) => void) => {
    const wrapped = (_event: unknown, origin: string) => {
      listener(origin);
    };
    ipcRenderer.on("regenic:api-origin", wrapped);
    return () => {
      ipcRenderer.removeListener("regenic:api-origin", wrapped);
    };
  },
  onLocaleChanged: (listener: (locale: "en" | "zh") => void) => {
    const wrapped = (_event: unknown, locale: "en" | "zh") => {
      listener(locale);
    };
    ipcRenderer.on("regenic:locale", wrapped);
    return () => {
      ipcRenderer.removeListener("regenic:locale", wrapped);
    };
  },
  showConsole: () => ipcRenderer.invoke("regenic:show-console"),
  quitApp: () => ipcRenderer.invoke("regenic:quit"),
  getHostStats: () => ipcRenderer.invoke("regenic:get-host-stats"),
});
