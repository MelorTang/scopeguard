import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";

import {
  IPC_CHANNELS,
  parseCreateAgentInput,
  parseCreateConversationInput,
  parseCreateDispatchRequest,
  parseCreateWorkspaceInput,
  parseId,
  parseHandoffPromptRequest,
  parseResolveApprovalRequest,
  parseSaveProviderProfileRequest,
  parseStartRunInput,
  parseUpdateWorkspaceContextRequest,
  parseUpdateConversationSettingsInput,
  parseWorkspaceLayoutRequest,
} from "@scopeguard/ipc-contracts";
import type { RunEvent, WorkspaceSnapshot } from "@scopeguard/domain";

import { AgentHostClient } from "./main/agent-host-client.js";
import { runDesktopPilotPhase } from "./main/desktop-pilot.js";
import { EncryptedSecretVault } from "./main/encrypted-secret-vault.js";
import { persistPilotLifecycleMetadata } from "./main/pilot-desktop-process.js";
import {
  assertDesktopPilotCredentialStoreIsolation,
  assertDesktopPilotLaunchAllowed,
  createDesktopPilotSafeStorage,
  parseDesktopPilotPhase,
} from "./main/pilot-safe-storage.js";
import { preparePrivateDataDirectory } from "./main/private-data-directory.js";
import {
  canonicalizeProjectDirectory,
  ProjectDirectoryAuthorizer,
} from "./main/project-directory-authorizer.js";
import {
  isTrustedRendererUrl as checkTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from "./main/renderer-security.js";
import { validateWorkspaceFileSelection } from "./main/workspace-file-selection.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const rendererDirectory = resolve(moduleDir, "../dist-renderer");
const desktopPilotPhase = parseDesktopPilotPhase(
  process.env.SCOPEGUARD_DESKTOP_PILOT_PHASE,
);
if (desktopPilotPhase) {
  assertDesktopPilotLaunchAllowed(process.platform);
  assertDesktopPilotCredentialStoreIsolation(process.platform, app.commandLine);
  app.setPath(
    "userData",
    resolve(requiredPilotEnvironment("SCOPEGUARD_DESKTOP_PILOT_USER_DATA")),
  );
}
let developmentRendererUrl: string | null = null;

let mainWindow: BrowserWindow | null = null;
let host: AgentHostClient | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
const projectDirectoryAuthorizer = new ProjectDirectoryAuthorizer();

if (!app.requestSingleInstanceLock()) {
  if (desktopPilotPhase) {
    console.error("ScopeGuard Desktop Pilot could not acquire the single-instance lock.");
    process.exitCode = 1;
  }
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

  void app.whenReady().then(startApplication).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!desktopPilotPhase && BrowserWindow.getAllWindows().length === 0) {
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
  if (process.platform === "win32") {
    app.setAppUserModelId("com.melortang.scopeguard");
  }
  if (!desktopPilotPhase) {
    configureSessionSecurity();
  }
  developmentRendererUrl = resolveDevelopmentRendererUrl({
    configuredUrl: process.env.SCOPEGUARD_RENDERER_URL,
    isPackaged: app.isPackaged,
  });

  const userDataPath = app.getPath("userData");
  const packagedRuntimeRoot = app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "runtime")
    : process.env.SCOPEGUARD_DESKTOP_PILOT_STAGED === "1"
      ? resolve(moduleDir, "../runtime")
      : null;
  await preparePrivateDataDirectory(userDataPath);
  const credentialStorage = desktopPilotPhase
    ? createDesktopPilotSafeStorage(
        requiredPilotEnvironment("SCOPEGUARD_DESKTOP_PILOT_STORAGE_KEY"),
      )
    : (await import("electron")).safeStorage;
  const vault = new EncryptedSecretVault(
    join(userDataPath, "credentials", "providers.json"),
    {
      safeStorage: credentialStorage,
    },
  );
  host = new AgentHostClient({
    modulePath: join(moduleDir, "agent-host.js"),
    databasePath: join(userDataPath, "scopeguard.db"),
    piSessionRoot: join(userDataPath, "pi-sessions"),
    piCliPath: packagedRuntimeRoot
      ? join(
          packagedRuntimeRoot,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        )
      : undefined,
    piRuntimeAssetRoot: packagedRuntimeRoot ?? undefined,
    vault,
    fork: (modulePath, args, options) =>
      utilityProcess.fork(modulePath, args, options),
    onRunEvent: forwardRunEvent,
    onReady: refreshRendererAfterHostReady,
  });
  registerIpcHandlers(host);
  await host.start();
  if (desktopPilotPhase) {
    const agentHostPid = host.processId;
    if (!agentHostPid) {
      throw new Error(
        "Production AgentHostClient did not expose a running utility process.",
      );
    }
    await persistPilotLifecycleMetadata(
      requiredPilotEnvironment("SCOPEGUARD_DESKTOP_PILOT_LIFECYCLE"),
      {
        schemaVersion: 1,
        phase: desktopPilotPhase === "1" ? 1 : 2,
        mainPid: process.pid,
        agentHostPid,
      },
    );
    await runDesktopPilotPhase(host);
    app.quit();
    return;
  }
  await createMainWindow();
}

function requiredPilotEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Desktop Pilot mode.`);
  return value;
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
  ipcMain.handle(IPC_CHANNELS.chooseWorkspaceDirectory, async (event) => {
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
    const localRootPath = await canonicalizeProjectDirectory(result.filePaths[0]);
    projectDirectoryAuthorizer.authorize(senderId, localRootPath);
    return {
      canceled: false,
      localRootPath,
    };
  });
  ipcMain.handle(IPC_CHANNELS.chooseWorkspaceFiles, async (event, value: unknown) => {
    assertTrustedSender(event);
    const workspaceId = parseId(value, "workspaceId");
    const snapshot = await agentHost.request<WorkspaceSnapshot>(
      "getWorkspaceSnapshot",
    );
    const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
    if (!workspace?.localRootPath) {
      throw new Error("Workspace not found.");
    }
    const rootPath = await canonicalizeProjectDirectory(workspace.localRootPath);
    const options: OpenDialogOptions = {
      title: "添加 Workspace 文件",
      buttonLabel: "添加",
      defaultPath: rootPath,
      properties: ["openFile", "multiSelections"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [] };
    }
    const files = await validateWorkspaceFileSelection(
      rootPath,
      result.filePaths,
    );
    return { canceled: false, files };
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
  ipcMain.handle(IPC_CHANNELS.createAgent, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "createAgent",
      parseCreateAgentInput(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.createConversation, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createConversation", parseCreateConversationInput(value));
  });
  ipcMain.handle(IPC_CHANNELS.updateConversationSettings, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "updateConversationSettings",
      parseUpdateConversationSettingsInput(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.getWorkspaceLayout, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("getWorkspaceLayout", parseId(value, "workspaceId"));
  });
  ipcMain.handle(IPC_CHANNELS.saveWorkspaceLayout, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("saveWorkspaceLayout", parseWorkspaceLayoutRequest(value));
  });
  ipcMain.handle(IPC_CHANNELS.listConversationMessages, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("listConversationMessages", parseId(value, "conversationId"));
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
  ipcMain.handle(IPC_CHANNELS.createDispatch, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("createDispatch", parseCreateDispatchRequest(value));
  });
  ipcMain.handle(IPC_CHANNELS.listDispatches, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("listDispatches", parseId(value, "workspaceId"));
  });
  ipcMain.handle(IPC_CHANNELS.executeDispatch, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("executeDispatch", parseId(value, "dispatchId"));
  });
  ipcMain.handle(IPC_CHANNELS.generateHandoffPrompt, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "generateHandoffPrompt",
      parseHandoffPromptRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.getWorkspaceContext, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request("getWorkspaceContext", parseId(value, "workspaceId"));
  });
  ipcMain.handle(IPC_CHANNELS.updateWorkspaceContext, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "updateWorkspaceContext",
      parseUpdateWorkspaceContextRequest(value),
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
