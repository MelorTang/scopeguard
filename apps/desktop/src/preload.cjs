const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scopeguardDesktop", {
  openProjectFolder: async () => ipcRenderer.invoke("scopeguard:open-project-folder"),
  getRecentProjects: async () => ipcRenderer.invoke("scopeguard:get-recent-projects"),
  openKnownProject: async (projectPath) => ipcRenderer.invoke("scopeguard:open-known-project", projectPath),
  getExternalApiToken: async (projectRoot) => ipcRenderer.invoke("scopeguard:get-external-api-token", projectRoot),
});
