const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("catrupoleUpdates", {
  getStatus: () => ipcRenderer.invoke("updates:get-status"),
  openRelease: () => ipcRenderer.invoke("updates:open-release"),
  performAction: () => ipcRenderer.invoke("updates:perform-action"),
  onStatus: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
});
