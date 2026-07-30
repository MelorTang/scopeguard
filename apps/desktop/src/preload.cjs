const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  getWorkspaceSnapshot: "scopeguard:workspace:get-snapshot",
  chooseProjectDirectory: "scopeguard:project:choose-directory",
  addProject: "scopeguard:project:add",
  saveProviderProfile: "scopeguard:provider:save",
  deleteProviderProfile: "scopeguard:provider:delete",
  testProviderConnection: "scopeguard:provider:test",
  createAgentProfile: "scopeguard:agent-profile:create",
  createThread: "scopeguard:thread:create",
  listThreadMessages: "scopeguard:thread:list-messages",
  startRun: "scopeguard:run:start",
  cancelRun: "scopeguard:run:cancel",
  resolveApproval: "scopeguard:approval:resolve",
  getProjectContext: "scopeguard:context:get",
  updateProjectContext: "scopeguard:context:update",
  runEvent: "scopeguard:event:run",
});

const api = Object.freeze({
  getWorkspaceSnapshot: () => ipcRenderer.invoke(channels.getWorkspaceSnapshot),
  chooseProjectDirectory: () => ipcRenderer.invoke(channels.chooseProjectDirectory),
  addProject: (input) => ipcRenderer.invoke(channels.addProject, input),
  saveProviderProfile: (input) =>
    ipcRenderer.invoke(channels.saveProviderProfile, input),
  deleteProviderProfile: (providerProfileId) =>
    ipcRenderer.invoke(channels.deleteProviderProfile, providerProfileId),
  testProviderConnection: (input) =>
    ipcRenderer.invoke(channels.testProviderConnection, input),
  createAgentProfile: (input) =>
    ipcRenderer.invoke(channels.createAgentProfile, input),
  createThread: (input) => ipcRenderer.invoke(channels.createThread, input),
  listThreadMessages: (threadId) =>
    ipcRenderer.invoke(channels.listThreadMessages, threadId),
  startRun: (input) => ipcRenderer.invoke(channels.startRun, input),
  cancelRun: (runId) => ipcRenderer.invoke(channels.cancelRun, runId),
  resolveApproval: (approvalId, decision) =>
    ipcRenderer.invoke(channels.resolveApproval, { approvalId, decision }),
  getProjectContext: (projectId) =>
    ipcRenderer.invoke(channels.getProjectContext, projectId),
  updateProjectContext: (request) =>
    ipcRenderer.invoke(channels.updateProjectContext, request),
  subscribeRunEvents: (listener) => {
    if (typeof listener !== "function") {
      throw new TypeError("Run event listener must be a function.");
    }
    const handler = (_event, value) => {
      if (isRunEventEnvelope(value)) {
        listener(value);
      }
    };
    ipcRenderer.on(channels.runEvent, handler);
    return () => ipcRenderer.removeListener(channels.runEvent, handler);
  },
});

contextBridge.exposeInMainWorld("scopeguardDesktop", api);

function isRunEventEnvelope(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.type === "string" &&
      typeof value.runId === "string" &&
      typeof value.threadId === "string" &&
      typeof value.at === "string",
  );
}
