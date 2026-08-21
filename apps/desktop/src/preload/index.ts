import { contextBridge, ipcRenderer } from "electron";

function readApiOrigin(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--regenic-api="));
  return flag?.slice("--regenic-api=".length) ?? "http://127.0.0.1:4370";
}

contextBridge.exposeInMainWorld("regenic", {
  apiOrigin: readApiOrigin(),
  showConsole: () => ipcRenderer.invoke("regenic:show-console"),
  quitApp: () => ipcRenderer.invoke("regenic:quit"),
});
