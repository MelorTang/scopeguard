import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";

import {
  IPC_CHANNELS,
  parseCreateAgentDefinitionInput,
  parseCreateAgentInstanceInput,
  parseCreateAgentProfileInput,
  parseCreateArtifactInput,
  parseCreateHandoffInput,
  parseCreateProjectInput,
  parseCreateScheduleInput,
  parseCreateTaskAssignmentInput,
  parseCreateTaskInput,
  parseCreateThreadInput,
  parseCreateWorkspaceInput,
  parseId,
  parsePublishWorkspaceContextRequest,
  parseResolveApprovalRequest,
  parseSaveRuntimeNodeInput,
  parseSaveProviderProfileRequest,
  parseStartRunInput,
  parseUpdateTaskStatusRequest,
  parseUpdateAgentInstanceRuntimeRequest,
  parseUpdateProjectContextRequest,
} from "@scopeguard/ipc-contracts";
import type { RunEvent } from "@scopeguard/domain";

import { AgentHostClient } from "./main/agent-host-client.js";
import { createDesktopExecutionBroker } from "./main/desktop-execution-broker.js";
import { EncryptedSecretVault } from "./main/encrypted-secret-vault.js";
import { preparePrivateDataDirectory } from "./main/private-data-directory.js";
import {
  canonicalizeProjectDirectory,
  ProjectDirectoryAuthorizer,
} from "./main/project-directory-authorizer.js";
import {
  isTrustedRendererUrl as checkTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from "./main/renderer-security.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const rendererDirectory = resolve(moduleDir, "../dist-renderer");
let developmentRendererUrl: string | null = null;

let mainWindow: BrowserWindow | null = null;
let host: AgentHostClient | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
const projectDirectoryAuthorizer = new ProjectDirectoryAuthorizer();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(startApplication);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});

app.on("before-quit", (event) => {
  if (shutdownComplete) {
    return;
  }
  event.preventDefault();
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  void stopAgentHostAndQuit();
});

process.once("SIGINT", () => {
  app.quit();
});
process.once("SIGTERM", () => {
  app.quit();
});

async function stopAgentHostAndQuit(): Promise<void> {
  try {
    await host?.stop();
  } catch (error) {
    console.error(
      `[scopeguard] Agent host shutdown failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    host = null;
    shutdownComplete = true;
    app.quit();
  }
}

async function startApplication(): Promise<void> {
  app.setName("ScopeGuard");
  configureSessionSecurity();
  developmentRendererUrl = resolveDevelopmentRendererUrl({
    configuredUrl: process.env.SCOPEGUARD_RENDERER_URL,
    isPackaged: app.isPackaged,
  });

  const userDataPath = app.getPath("userData");
  await preparePrivateDataDirectory(userDataPath);
  const vault = new EncryptedSecretVault(
    join(userDataPath, "credentials", "providers.json"),
    {
      safeStorage,
    },
  );
  const managedExecution = await createDesktopExecutionBroker({
    resourcesPath: process.resourcesPath,
    userDataPath,
    isPackaged: app.isPackaged,
  });
  host = new AgentHostClient({
    modulePath: join(moduleDir, "agent-host.js"),
    databasePath: join(userDataPath, "scopeguard.db"),
    vault,
    fork: (modulePath, args, options) =>
      utilityProcess.fork(modulePath, args, options),
    onRunEvent: forwardRunEvent,
    onReady: refreshRendererAfterHostReady,
    managedExecution,
  });
  registerIpcHandlers(host);
  await host.start();
  await createMainWindow();
}

async function createMainWindow(): Promise<void> {
  if (mainWindow) {
    return;
  }
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: "ScopeGuard",
    backgroundColor: "#f7f7f5",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(moduleDir, "preload.cjs"),
      webviewTag: false,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (developmentRendererUrl) {
    await window.loadURL(developmentRendererUrl);
  } else {
    await window.loadFile(join(rendererDirectory, "index.html"));
  }
}

function registerIpcHandlers(agentHost: AgentHostClient): void {
  ipcMain.handle(IPC_CHANNELS.getWorkspaceSnapshot, (event) => {
    assertTrustedSender(event);
    return agentHost.request("getWorkspaceSnapshot");
  });
  ipcMain.handle(IPC_CHANNELS.createWorkspace, async (event, value: unknown) => {
    assertTrustedSender(event);
    const input = parseCreateWorkspaceInput(value);
    const localRootPath = input.localRootPath
      ? await projectDirectoryAuthorizer.consume(
        event.sender.id,
        input.localRootPath,
      )
      : input.localRootPath;
    return agentHost.request("createWorkspace", {
      ...input,
      localRootPath,
    });
  });
  ipcMain.handle(IPC_CHANNELS.saveRuntimeNode, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("saveRuntimeNode", parseSaveRuntimeNodeInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.testRuntimeConnection, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "testRuntimeConnection",
      parseId(value, "runtimeNodeId"),
    );
  });
  ipcMain.handle(IPC_CHANNELS.createAgentDefinition, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "createAgentDefinition",
      parseCreateAgentDefinitionInput(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.createAgentInstance, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "createAgentInstance",
      parseCreateAgentInstanceInput(value),
    );
  });
  ipcMain.handle(
    IPC_CHANNELS.updateAgentInstanceRuntime,
    (event, value: unknown) => {
      assertTrustedSender(event);
      return agentHost.request(
        "updateAgentInstanceRuntime",
        parseUpdateAgentInstanceRuntimeRequest(value),
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.createTask, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createTask", parseCreateTaskInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.updateTaskStatus, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "updateTaskStatus",
      parseUpdateTaskStatusRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.assignAgentToTask, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "assignAgentToTask",
      parseCreateTaskAssignmentInput(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.createArtifact, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createArtifact", parseCreateArtifactInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.getWorkspaceContext, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "getWorkspaceContext",
      parseId(value, "workspaceId"),
    );
  });
  ipcMain.handle(
    IPC_CHANNELS.publishWorkspaceContext,
    (event, value: unknown) => {
      assertTrustedSender(event);
      return agentHost.request(
        "publishWorkspaceContext",
        parsePublishWorkspaceContextRequest(value),
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.createHandoff, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createHandoff", parseCreateHandoffInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.createSchedule, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createSchedule", parseCreateScheduleInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.resolveInboxItem, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("resolveInboxItem", parseId(value, "inboxItemId"));
  });
  ipcMain.handle(IPC_CHANNELS.chooseProjectDirectory, async (event) => {
    assertTrustedSender(event);
    const senderId = event.sender.id;
    projectDirectoryAuthorizer.revoke(senderId);
    const options: OpenDialogOptions = {
      title: "Open project folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const rootPath = await canonicalizeProjectDirectory(result.filePaths[0]);
    projectDirectoryAuthorizer.authorize(senderId, rootPath);
    return {
      canceled: false,
      rootPath,
    };
  });
  ipcMain.handle(IPC_CHANNELS.addProject, async (event, value: unknown) => {
    assertTrustedSender(event);
    const input = parseCreateProjectInput(value);
    const rootPath = await projectDirectoryAuthorizer.consume(
      event.sender.id,
      input.rootPath,
    );
    return agentHost.request("addProject", {
      ...input,
      rootPath,
    });
  });
  ipcMain.handle(IPC_CHANNELS.saveProviderProfile, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "saveProviderProfile",
      parseSaveProviderProfileRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.deleteProviderProfile, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("deleteProviderProfile", parseId(value));
  });
  ipcMain.handle(IPC_CHANNELS.testProviderConnection, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "testProviderConnection",
      parseSaveProviderProfileRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.createAgentProfile, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "createAgentProfile",
      parseCreateAgentProfileInput(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.createThread, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createThread", parseCreateThreadInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.listThreadMessages, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("listThreadMessages", parseId(value, "threadId"));
  });
  ipcMain.handle(IPC_CHANNELS.startRun, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("startRun", parseStartRunInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.cancelRun, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("cancelRun", parseId(value, "runId"));
  });
  ipcMain.handle(IPC_CHANNELS.resolveApproval, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "resolveApproval",
      parseResolveApprovalRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.getProjectContext, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("getProjectContext", parseId(value, "projectId"));
  });
  ipcMain.handle(IPC_CHANNELS.updateProjectContext, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "updateProjectContext",
      parseUpdateProjectContextRequest(value),
    );
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
    throw new Error("Rejected IPC call from an untrusted renderer.");
  }
}

function isTrustedRendererUrl(value: string): boolean {
  return checkTrustedRendererUrl(value, {
    developmentRendererUrl,
    rendererDirectory,
  });
}

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function forwardRunEvent(event: RunEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.runEvent, event);
}

function refreshRendererAfterHostReady(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.reload();
}
