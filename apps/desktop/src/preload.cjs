const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  getWorkspaceSnapshot: "scopeguard:workspace:get-snapshot",
  createWorkspace: "scopeguard:workspace:create",
  chooseWorkspaceDirectory: "scopeguard:workspace:choose-directory",
  chooseWorkspaceFiles: "scopeguard:workspace:choose-files",
  saveProviderProfile: "scopeguard:provider:save",
  deleteProviderProfile: "scopeguard:provider:delete",
  testProviderConnection: "scopeguard:provider:test",
  createAgent: "scopeguard:agent:create",
  createConversation: "scopeguard:conversation:create",
  updateConversationSettings: "scopeguard:conversation:update-settings",
  getWorkspaceLayout: "scopeguard:layout:get",
  saveWorkspaceLayout: "scopeguard:layout:save",
  listConversationMessages: "scopeguard:conversation:list-messages",
  startRun: "scopeguard:run:start",
  cancelRun: "scopeguard:run:cancel",
  resolveApproval: "scopeguard:approval:resolve",
  createDispatch: "scopeguard:dispatch:create",
  listDispatches: "scopeguard:dispatch:list",
  executeDispatch: "scopeguard:dispatch:execute",
  generateHandoffPrompt: "scopeguard:handoff:generate",
  copyHandoffPrompt: "scopeguard:handoff:copy",
  getWorkspaceContext: "scopeguard:context:get",
  updateWorkspaceContext: "scopeguard:context:update",
  runEvent: "scopeguard:event:run",
});

const api = Object.freeze({
  getWorkspaceSnapshot: () => ipcRenderer.invoke(channels.getWorkspaceSnapshot),
  createWorkspace: (input) => ipcRenderer.invoke(channels.createWorkspace, input),
  chooseWorkspaceDirectory: () => ipcRenderer.invoke(channels.chooseWorkspaceDirectory),
  chooseWorkspaceFiles: (workspaceId) =>
    ipcRenderer.invoke(channels.chooseWorkspaceFiles, workspaceId),
  saveProviderProfile: (input) =>
    ipcRenderer.invoke(channels.saveProviderProfile, input),
  deleteProviderProfile: (providerProfileId) =>
    ipcRenderer.invoke(channels.deleteProviderProfile, providerProfileId),
  testProviderConnection: (input) =>
    ipcRenderer.invoke(channels.testProviderConnection, input),
  createAgent: (input) =>
    ipcRenderer.invoke(channels.createAgent, input),
  createConversation: (input) => ipcRenderer.invoke(channels.createConversation, input),
  updateConversationSettings: (input) =>
    ipcRenderer.invoke(channels.updateConversationSettings, input),
  getWorkspaceLayout: (workspaceId) =>
    ipcRenderer.invoke(channels.getWorkspaceLayout, workspaceId),
  saveWorkspaceLayout: (layout) =>
    ipcRenderer.invoke(channels.saveWorkspaceLayout, layout),
  listConversationMessages: (conversationId) =>
    ipcRenderer.invoke(channels.listConversationMessages, conversationId),
  startRun: (input) => ipcRenderer.invoke(channels.startRun, input),
  cancelRun: (runId) => ipcRenderer.invoke(channels.cancelRun, runId),
  resolveApproval: (approvalId, decision) =>
    ipcRenderer.invoke(channels.resolveApproval, { approvalId, decision }),
  createDispatch: (input) => ipcRenderer.invoke(channels.createDispatch, input),
  listDispatches: (workspaceId) =>
    ipcRenderer.invoke(channels.listDispatches, workspaceId),
  executeDispatch: (dispatchId) =>
    ipcRenderer.invoke(channels.executeDispatch, dispatchId),
  generateHandoffPrompt: (input) =>
    ipcRenderer.invoke(channels.generateHandoffPrompt, input),
  copyHandoffPrompt: (text) =>
    ipcRenderer.invoke(channels.copyHandoffPrompt, text),
  getWorkspaceContext: (workspaceId) =>
    ipcRenderer.invoke(channels.getWorkspaceContext, workspaceId),
  updateWorkspaceContext: (request) =>
    ipcRenderer.invoke(channels.updateWorkspaceContext, request),
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
      typeof value.conversationId === "string" &&
      typeof value.at === "string",
  );
}
