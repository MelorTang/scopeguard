import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";

import { WorkbenchLayoutPersistence } from "@scopeguard/application/workbench-layout-persistence";
import type { RunEvent, WorkspaceSnapshot } from "@scopeguard/domain";
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

import { AgentHostClient } from "./main/agent-host-client.js";
import { writeControlledClipboard } from "./main/controlled-clipboard.js";
import { runDesktopPilotPhase } from "./main/desktop-pilot.js";
import { EncryptedSecretVault } from "./main/encrypted-secret-vault.js";
import { LayoutPersistenceFence } from "./main/layout-persistence-fence.js";
import { persistPilotLifecycleMetadata } from "./main/pilot-desktop-process.js";
import {
  assertDesktopPilotCredentialStoreIsolation,
  assertDesktopPilotLaunchAllowed,
  createDesktopPilotSafeStorage,
  parseDesktopPilotPhase,
} from "./main/pilot-safe-storage.js";
import { preparePrivateDataDirectory } from "./main/private-data-directory.js";
import { Phase3RendererClient } from "./main/phase3-renderer-client.js";
import {
  canonicalizeProjectDirectory,
  ProjectDirectoryAuthorizer,
} from "./main/project-directory-authorizer.js";
import {
  isTrustedRendererUrl as checkTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from "./main/renderer-security.js";
import { configureDenyAllSessionPermissions } from "./main/session-security.js";
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
let layoutPersistence: WorkbenchLayoutPersistence | null = null;
let layoutFence: LayoutPersistenceFence | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
const phase3ShutdownEvents: string[] = [];
let phase3LateLayoutStageAttempts = 0;
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
    await runLayoutShutdown("app quit", destroyRendererForShutdown, async () => {
      recordPhase3ShutdownEvent("host-stop-started");
      if (isPhase3DesktopPilot()) {
        await wait(requiredPositiveIntegerEnvironment(
          "SCOPEGUARD_PHASE3_PILOT_HOST_STOP_DELAY_MS",
        ));
      }
      try {
        await host?.stop();
      } catch (error) {
        console.error(
          `[scopeguard] Agent host shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (isPhase3DesktopPilot()) throw error;
      }
      recordPhase3ShutdownEvent("host-stop-complete");
      await persistPhase3ShutdownEvidence();
    });
  } catch (error) {
    shutdownStarted = false;
    console.error(error);
    return;
  }
  host = null;
  layoutPersistence = null;
  layoutFence = null;
  shutdownComplete = true;
  app.quit();
}

function destroyRendererForShutdown(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }
  window.destroy();
  if (!window.isDestroyed()) {
    throw new Error("Renderer could not be destroyed before Agent Host shutdown.");
  }
  recordPhase3ShutdownEvent("renderer-destroyed");
}

async function startApplication(): Promise<void> {
  app.setName("ScopeGuard");
  if (process.platform === "win32") {
    app.setAppUserModelId("com.melortang.scopeguard");
  }
  configureSessionSecurity();
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
  layoutPersistence = new WorkbenchLayoutPersistence({
    delayMs: 80,
    save: (layout) => host!.request("saveWorkspaceLayout", layout),
    onError: (error) => {
      console.error(
        `[scopeguard] Deferred Workspace layout save failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });
  layoutFence = new LayoutPersistenceFence({
    timeoutMs: 5_000,
    suspend: () => {
      requireLayoutPersistence().suspendScheduling();
      if (shutdownStarted) recordPhase3ShutdownEvent("layout-suspended");
    },
    resume: () => requireLayoutPersistence().resumeScheduling(),
    flushAll: async () => {
      await requireLayoutPersistence().flushAll();
      if (shutdownStarted) recordPhase3ShutdownEvent("layout-flushed");
    },
    reportError: reportLayoutPersistenceError,
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
    const phase3Renderer = process.env.SCOPEGUARD_DESKTOP_PILOT_KIND === "phase3"
      ? await createPhase3RendererEvidence()
      : undefined;
    await runDesktopPilotPhase(host, phase3Renderer);
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

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow) {
    return mainWindow;
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
  let closeAllowed = false;
  let closePending = false;

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
    if (!desktopPilotPhase) window.show();
  });
  window.on("close", (event) => {
    if (closeAllowed || shutdownComplete) {
      return;
    }
    event.preventDefault();
    if (closePending) {
      return;
    }
    closePending = true;
    void runLayoutTransient("BrowserWindow close", async () => {
      closeAllowed = true;
      await closeBrowserWindow(window);
    }).catch(() => {
      closeAllowed = false;
      closePending = false;
    });
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
  return window;
}

async function createPhase3RendererEvidence() {
  const window = await createMainWindow();
  const rendererProcessId = window.webContents.getOSProcessId();
  if (!Number.isInteger(rendererProcessId) || rendererProcessId <= 0) {
    throw new Error("Phase 3 Desktop Pilot Renderer process is unavailable.");
  }
  return {
    client: new Phase3RendererClient(window.webContents),
    browserWindowId: window.id,
    rendererProcessId,
    readClipboardText: () => clipboard.readText(),
  };
}

function registerIpcHandlers(agentHost: AgentHostClient): void {
  ipcMain.handle(IPC_CHANNELS.getWorkspaceSnapshot, async (event) => {
    assertTrustedSender(event);
    await runLayoutFence("Workspace snapshot refresh", () => undefined);
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
  ipcMain.handle(IPC_CHANNELS.getWorkspaceLayout, async (event, value: unknown) => {
    assertTrustedSender(event);
    const workspaceId = parseId(value, "workspaceId");
    await requireLayoutPersistence().flush(workspaceId);
    return agentHost.request("getWorkspaceLayout", workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.stageWorkspaceLayout, (event, value: unknown) => {
    assertTrustedSender(event);
    if (isPhase3DesktopPilot() && shutdownStarted) {
      phase3LateLayoutStageAttempts += 1;
    }
    const persistence = requireLayoutPersistence();
    if (persistence.isSchedulingSuspended) {
      return { accepted: false, reason: "quiescing" } as const;
    }
    persistence.schedule(parseWorkspaceLayoutRequest(value));
    return { accepted: true } as const;
  });
  ipcMain.handle(IPC_CHANNELS.flushWorkspaceLayouts, async (event) => {
    assertTrustedSender(event);
    await runLayoutFence("Renderer layout flush", () => undefined);
  });
  ipcMain.handle(IPC_CHANNELS.saveWorkspaceLayout, async (event, value: unknown) => {
    assertTrustedSender(event);
    const layout = parseWorkspaceLayoutRequest(value);
    const persistence = requireLayoutPersistence();
    persistence.schedule(layout);
    await persistence.flush(layout.workspaceId);
    return layout;
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
  ipcMain.handle(IPC_CHANNELS.copyHandoffPrompt, (event, value: unknown) => {
    writeControlledClipboard(event, value, {
      assertTrustedSender: (sender) => assertTrustedSender(sender as IpcMainInvokeEvent),
      writeText: (text) => clipboard.writeText(text),
    });
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
  configureDenyAllSessionPermissions(session.defaultSession);
}

function forwardRunEvent(event: RunEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.runEvent, event);
}

async function refreshRendererAfterHostReady(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const window = mainWindow;
  if (shutdownStarted) {
    return;
  }
  await runLayoutTransient("Agent Host ready Renderer reload", async () => {
    if (!window.isDestroyed()) {
      await reloadBrowserWindow(window);
    }
  });
}

function requireLayoutPersistence(): WorkbenchLayoutPersistence {
  if (!layoutPersistence) {
    throw new Error("Workspace layout persistence is unavailable.");
  }
  return layoutPersistence;
}

function runLayoutFence(
  reason: string,
  action: () => void | Promise<void>,
): Promise<void> {
  return layoutFence ? layoutFence.run(reason, action) : Promise.resolve().then(action);
}

function runLayoutTransient(
  reason: string,
  action: () => void | Promise<void>,
): Promise<void> {
  return layoutFence
    ? layoutFence.runTransient(reason, action)
    : Promise.resolve().then(action);
}

function runLayoutShutdown(
  reason: string,
  destroyRenderer: () => void | Promise<void>,
  stopAgentHost: () => void | Promise<void>,
): Promise<void> {
  return layoutFence
    ? layoutFence.runShutdown(reason, destroyRenderer, stopAgentHost)
    : Promise.resolve().then(destroyRenderer).then(stopAgentHost);
}

function closeBrowserWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveClose, rejectClose) => {
    const onClosed = (): void => resolveClose();
    window.once("closed", onClosed);
    try {
      window.close();
    } catch (error) {
      window.removeListener("closed", onClosed);
      rejectClose(error);
    }
  });
}

function reloadBrowserWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveReload, rejectReload) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReload(new Error("Renderer reload timed out after 15 seconds."));
    }, 15_000);
    const onFinished = (): void => {
      cleanup();
      resolveReload();
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      window.webContents.removeListener("did-finish-load", onFinished);
    };
    window.webContents.once("did-finish-load", onFinished);
    try {
      window.webContents.reload();
    } catch (error) {
      cleanup();
      rejectReload(error);
    }
  });
}

function reportLayoutPersistenceError(message: string): void {
  console.error(`[scopeguard] ${message}`);
  if (app.isReady()) {
    dialog.showErrorBox("ScopeGuard could not save the Workspace layout", message);
  }
}

function isPhase3DesktopPilot(): boolean {
  return Boolean(
    desktopPilotPhase &&
    process.env.SCOPEGUARD_DESKTOP_PILOT_KIND === "phase3"
  );
}

function recordPhase3ShutdownEvent(event: string): void {
  if (isPhase3DesktopPilot()) phase3ShutdownEvents.push(event);
}

async function persistPhase3ShutdownEvidence(): Promise<void> {
  if (!isPhase3DesktopPilot()) return;
  const expectedEvents = [
    "layout-suspended",
    "layout-flushed",
    "renderer-destroyed",
    "host-stop-started",
    "host-stop-complete",
  ];
  const evidence = {
    schemaVersion: 1,
    phase: desktopPilotPhase === "1" ? 1 : 2,
    events: phase3ShutdownEvents,
    rendererDestroyedBeforeHostStop:
      phase3ShutdownEvents.indexOf("renderer-destroyed") >= 0 &&
      phase3ShutdownEvents.indexOf("renderer-destroyed") <
        phase3ShutdownEvents.indexOf("host-stop-started"),
    hostStopDelayMs: requiredPositiveIntegerEnvironment(
      "SCOPEGUARD_PHASE3_PILOT_HOST_STOP_DELAY_MS",
    ),
    lateLayoutStageAttempts: phase3LateLayoutStageAttempts,
  };
  await writeFile(
    requiredPilotEnvironment("SCOPEGUARD_PHASE3_PILOT_SHUTDOWN_EVIDENCE"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (JSON.stringify(phase3ShutdownEvents) !== JSON.stringify(expectedEvents)) {
    throw new Error(
      `Phase 3 shutdown order was not exact: ${phase3ShutdownEvents.join(" -> ")}`,
    );
  }
  if (phase3LateLayoutStageAttempts !== 0) {
    throw new Error("A late Renderer layout revision crossed the shutdown boundary.");
  }
}

function requiredPositiveIntegerEnvironment(name: string): number {
  const value = Number(requiredPilotEnvironment(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}
