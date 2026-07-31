const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  getWorkspaceSnapshot: "scopeguard:workspace:get-snapshot",
  createWorkspace: "scopeguard:workspace:create",
  saveRuntimeNode: "scopeguard:runtime:save",
  testRuntimeConnection: "scopeguard:runtime:test",
  createAgentDefinition: "scopeguard:agent-definition:create",
  createAgentInstance: "scopeguard:agent-instance:create",
  updateAgentInstanceRuntime: "scopeguard:agent-instance:update-runtime",
  createTask: "scopeguard:task:create",
  updateTaskStatus: "scopeguard:task:update-status",
  assignAgentToTask: "scopeguard:task:assign-agent",
  createArtifact: "scopeguard:artifact:create",
  getWorkspaceContext: "scopeguard:workspace-context:get",
  publishWorkspaceContext: "scopeguard:workspace-context:publish",
  createHandoff: "scopeguard:handoff:create",
  createSchedule: "scopeguard:schedule:create",
  resolveInboxItem: "scopeguard:inbox:resolve",
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
  createWorkspace: (input) => ipcRenderer.invoke(channels.createWorkspace, input),
  saveRuntimeNode: (input) => ipcRenderer.invoke(channels.saveRuntimeNode, input),
  testRuntimeConnection: (runtimeNodeId) =>
    ipcRenderer.invoke(channels.testRuntimeConnection, runtimeNodeId),
  createAgentDefinition: (input) =>
    ipcRenderer.invoke(channels.createAgentDefinition, input),
  createAgentInstance: (input) =>
    ipcRenderer.invoke(channels.createAgentInstance, input),
  updateAgentInstanceRuntime: (input) =>
    ipcRenderer.invoke(channels.updateAgentInstanceRuntime, input),
  createTask: (input) => ipcRenderer.invoke(channels.createTask, input),
  updateTaskStatus: (request) =>
    ipcRenderer.invoke(channels.updateTaskStatus, request),
  assignAgentToTask: (input) =>
    ipcRenderer.invoke(channels.assignAgentToTask, input),
  createArtifact: (input) => ipcRenderer.invoke(channels.createArtifact, input),
  getWorkspaceContext: (workspaceId) =>
    ipcRenderer.invoke(channels.getWorkspaceContext, workspaceId),
  publishWorkspaceContext: (input) =>
    ipcRenderer.invoke(channels.publishWorkspaceContext, input),
  createHandoff: (input) => ipcRenderer.invoke(channels.createHandoff, input),
  createSchedule: (input) => ipcRenderer.invoke(channels.createSchedule, input),
  resolveInboxItem: (inboxItemId) =>
    ipcRenderer.invoke(channels.resolveInboxItem, inboxItemId),
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
