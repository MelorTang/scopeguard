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
  shell,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";

import { WorkbenchLayoutPersistence } from "@scopeguard/application/workbench-layout-persistence";
import type { RunEvent, WorkspaceLayout, WorkspaceSnapshot } from "@scopeguard/domain";
import {
  IPC_CHANNELS,
  parseCaptureWorkspaceFileRequest,
  parseCreateAgentInput,
  parseCreateConversationInput,
  parseCreateDispatchRequest,
  parseCreateWorkspaceInput,
  parseExportArtifactVersionRequest,
  parseOpenArtifactVersionRequest,
  parseId,
  parseHandoffPromptRequest,
  parseResolveApprovalRequest,
  parseSaveProviderProfileRequest,
  parseStartRunInput,
  parseSetArtifactCurrentVersionRequest,
  parseUpdateWorkspaceContextRequest,
  parseUpdateConversationSettingsInput,
  parseWorkspaceLayoutRequest,
  parseWorkspaceCenterStateRequest,
  type RendererLayoutDrainReceipt,
} from "@scopeguard/ipc-contracts";

import { AgentHostClient } from "./main/agent-host-client.js";
import { validateArtifactOpenPath } from "./main/artifact-open-path.js";
import { writeControlledClipboard } from "./main/controlled-clipboard.js";
import { runDesktopPilotPhase } from "./main/desktop-pilot.js";
import { EncryptedSecretVault } from "./main/encrypted-secret-vault.js";
import {
  LayoutPersistenceFence,
  type DestructiveLifecycleAction,
  type TerminalLifecycleCommit,
} from "./main/layout-persistence-fence.js";
import { persistPilotLifecycleMetadata } from "./main/pilot-desktop-process.js";
import {
  assertDesktopPilotCredentialStoreIsolation,
  assertDesktopPilotLaunchAllowed,
  createDesktopPilotSafeStorage,
  parseDesktopPilotPhase,
} from "./main/pilot-safe-storage.js";
import { preparePrivateDataDirectory } from "./main/private-data-directory.js";
import { Phase3LayoutDrainEvidence } from "./main/phase3-layout-drain-evidence.js";
import {
  assertPhase3LateLayoutObservation,
  type LateWorkspaceLayoutStageReceipt,
  type Phase3LateLayoutObservation,
} from "./main/phase3-late-layout-observation.js";
import { DesktopRendererClient } from "./main/desktop-renderer-client.js";
import { RendererLayoutLifecycleClient } from "./main/renderer-layout-lifecycle-client.js";
import {
  canonicalizeProjectDirectory,
  ProjectDirectoryAuthorizer,
} from "./main/project-directory-authorizer.js";
import {
  isTrustedRendererUrl as checkTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from "./main/renderer-security.js";
import { configureDenyAllSessionPermissions } from "./main/session-security.js";
import { stopAgentHostForTerminalShutdown } from "./main/terminal-agent-host-shutdown.js";
import { validateWorkspaceFileSelection } from "./main/workspace-file-selection.js";
import { stageWorkspaceLayoutRequest } from "./main/workspace-layout-stage-handler.js";

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
let rendererLayoutLifecycle: RendererLayoutLifecycleClient | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
const phase3ShutdownEvents: string[] = [];
let phase3LateLayoutStageAttempts = 0;
let phase3RendererDestroyedForShutdown = false;
let phase3RendererDestroyedAtUnixMs: number | null = null;
let phase3LateLayoutStageReceipt: LateWorkspaceLayoutStageReceipt | null = null;
let phase3LateLayoutObservation: Phase3LateLayoutObservation | null = null;
let phase3QuiescedLayoutStageAttempts = 0;
let phase3LayoutDrainEvidence: Phase3LayoutDrainEvidence | null = null;
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
    await runLayoutShutdown("app quit", () => undefined, async () => {
      destroyRendererForShutdown();
      await completePhase3LateLayoutObservation();
      await stopAgentHostForTerminalShutdown({
        stop: () => host?.stop() ?? Promise.resolve(),
        recordEvent: recordPhase3ShutdownEvent,
      });
    });
    await persistPhase3ShutdownEvidence();
  } catch (error) {
    shutdownStarted = false;
    console.error(error);
    return;
  }
  host = null;
  layoutPersistence = null;
  layoutFence = null;
  rendererLayoutLifecycle?.dispose();
  rendererLayoutLifecycle = null;
  shutdownComplete = true;
  app.quit();
}

function destroyRendererForShutdown(): void {
  const window = mainWindow;
  if (!window) return;
  if (!window.isDestroyed()) window.destroy();
  if (!window.isDestroyed()) {
    throw new Error("Renderer could not be destroyed before Agent Host shutdown.");
  }
  phase3RendererDestroyedForShutdown = true;
  phase3RendererDestroyedAtUnixMs = Date.now();
  recordPhase3ShutdownEvent("renderer-destroyed");
}

async function completePhase3LateLayoutObservation(): Promise<void> {
  if (!isPhase3DesktopPilot()) return;
  if (!phase3LateLayoutStageReceipt || !phase3RendererDestroyedAtUnixMs) {
    throw new Error("Phase 3 late-layout observation was not armed before shutdown.");
  }
  await wait(requiredPositiveIntegerEnvironment(
    "SCOPEGUARD_PHASE3_PILOT_POST_DESTROY_OBSERVATION_MS",
  ));
  phase3LateLayoutObservation = {
    ...phase3LateLayoutStageReceipt,
    rendererDestroyedAtUnixMs: phase3RendererDestroyedAtUnixMs,
    observationCompletedAtUnixMs: Date.now(),
    lateLayoutStageAttempts: phase3LateLayoutStageAttempts,
  };
  assertPhase3LateLayoutObservation(phase3LateLayoutObservation);
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
  const artifactRoot = join(userDataPath, "artifacts");
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
    artifactRoot,
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
    timeoutMs: 10_000,
    drainRenderer: async () => {
      const receipt = await drainRendererLayouts();
      if (shutdownStarted && receipt) {
        phase3LayoutDrainEvidence?.recordDrainReceipt(receipt);
        recordPhase3ShutdownEvent("renderer-layout-drained");
      }
    },
    resumeRenderer: () => resumeRendererLayouts(),
    suspend: () => {
      requireLayoutPersistence().suspendScheduling();
      if (shutdownStarted) {
        phase3LayoutDrainEvidence?.recordMainSuspended();
        recordPhase3ShutdownEvent("layout-suspended");
      }
    },
    resume: () => requireLayoutPersistence().resumeScheduling(),
    flushAll: async () => {
      await requireLayoutPersistence().flushAll();
      if (shutdownStarted) {
        phase3LayoutDrainEvidence?.recordSqliteFlushed();
        recordPhase3ShutdownEvent("layout-flushed");
      }
    },
    reportError: reportLayoutPersistenceError,
  });
  registerIpcHandlers(host, artifactRoot);
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
    const phase3Renderer = ["phase3", "phase4"].includes(
        process.env.SCOPEGUARD_DESKTOP_PILOT_KIND ?? "",
      )
      ? await createPhase3RendererEvidence()
      : undefined;
    phase3LateLayoutStageReceipt = await runDesktopPilotPhase(host, phase3Renderer);
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
  rendererLayoutLifecycle?.dispose();
  rendererLayoutLifecycle = new RendererLayoutLifecycleClient({
    rendererId: window.webContents.id,
    timeoutMs: 5_000,
    send: (request) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error("Renderer is unavailable for Workspace layout lifecycle requests.");
      }
      window.webContents.send(IPC_CHANNELS.rendererLayoutLifecycleRequest, request);
    },
  });
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
    void runLayoutTransient("BrowserWindow close", () => () => {
      closeAllowed = true;
      closeBrowserWindow(window);
      return undefined;
    }).catch((error: unknown) => {
      closeAllowed = false;
      closePending = false;
      console.error(
        `[scopeguard] BrowserWindow close was blocked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      rendererLayoutLifecycle?.dispose();
      rendererLayoutLifecycle = null;
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
  const client = new DesktopRendererClient(window.webContents);
  const rendererProcessId = window.webContents.getOSProcessId();
  if (!Number.isInteger(rendererProcessId) || rendererProcessId <= 0) {
    throw new Error("Phase 3 Desktop Pilot Renderer process is unavailable.");
  }
  return {
    client,
    browserWindowId: window.id,
    rendererProcessId,
    readClipboardText: () => clipboard.readText(),
    reloadRenderer: () => runLayoutTransient(
      "Phase 3 terminal drain preparation reload",
      () => () => {
        reloadBrowserWindow(window);
        return undefined;
      },
    ),
    armTerminalLayoutDrainRace: async (
      expectedBefore: WorkspaceLayout,
      expectedAfter: WorkspaceLayout,
    ) => {
      const persistence = requireLayoutPersistence();
      phase3LayoutDrainEvidence = new Phase3LayoutDrainEvidence(expectedAfter);
      persistence.suspendScheduling();
      try {
        const widths = await client.resizeFirstPaneThroughWorkbench(
          expectedBefore.paneWidths,
        );
        if (JSON.stringify(widths) !== JSON.stringify(expectedAfter.paneWidths)) {
          throw new Error(
            `Phase 3 Renderer resize mismatch: ${JSON.stringify(widths)}.`,
          );
        }
        await waitForPhase3TargetLayoutRejection();
      } finally {
        persistence.resumeScheduling();
      }
      app.quit();
    },
  };
}

function registerIpcHandlers(agentHost: AgentHostClient, artifactRoot: string): void {
  ipcMain.on(IPC_CHANNELS.rendererLayoutLifecycleResponse, (event, value: unknown) => {
    try {
      assertTrustedSender(event);
      rendererLayoutLifecycle?.handleResponse(event.sender.id, value);
    } catch (error) {
      console.error(
        `[scopeguard] Rejected Renderer layout lifecycle response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
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
    const layout = parseWorkspaceLayoutRequest(value);
    const persistence = requireLayoutPersistence();
    const result = stageWorkspaceLayoutRequest(layout, persistence);
    if (isPhase3DesktopPilot() && !result.accepted) {
      phase3QuiescedLayoutStageAttempts += 1;
    }
    if (
      isPhase3DesktopPilot() &&
      phase3RendererDestroyedForShutdown
    ) {
      phase3LateLayoutStageAttempts += 1;
    }
    phase3LayoutDrainEvidence?.recordStage(layout, result);
    return result;
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
  ipcMain.handle(IPC_CHANNELS.captureWorkspaceFile, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "captureWorkspaceFile",
      parseCaptureWorkspaceFileRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.exportArtifactVersion, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "exportArtifactVersion",
      parseExportArtifactVersionRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.openArtifactVersion, async (event, value: unknown) => {
    assertTrustedSender(event);
    const request = parseOpenArtifactVersionRequest(value);
    const path = await agentHost.request<unknown>(
      "prepareArtifactVersionOpen",
      request.versionId,
    );
    const validatedPath = await validateArtifactOpenPath(path, artifactRoot);
    const error = await shell.openPath(validatedPath);
    if (error) throw new Error(`System application could not open the Artifact: ${error}`);
  });
  ipcMain.handle(IPC_CHANNELS.setArtifactCurrentVersion, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "setArtifactCurrentVersion",
      parseSetArtifactCurrentVersionRequest(value),
    );
  });
  ipcMain.handle(IPC_CHANNELS.saveWorkspaceCenterState, (event, value: unknown) => {
    assertTrustedSender(event);
    return agentHost.request(
      "saveWorkspaceCenterState",
      parseWorkspaceCenterStateRequest(value),
    );
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
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
  await runLayoutTransient("Agent Host ready Renderer reload", () => () => {
    if (!window.isDestroyed()) reloadBrowserWindow(window);
    return undefined;
  });
}

function requireLayoutPersistence(): WorkbenchLayoutPersistence {
  if (!layoutPersistence) {
    throw new Error("Workspace layout persistence is unavailable.");
  }
  return layoutPersistence;
}

async function drainRendererLayouts(): Promise<RendererLayoutDrainReceipt | null> {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (!rendererLayoutLifecycle) {
    throw new Error("Renderer layout lifecycle client is unavailable.");
  }
  return rendererLayoutLifecycle.drain();
}

function resumeRendererLayouts(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  if (!rendererLayoutLifecycle) {
    return Promise.reject(new Error("Renderer layout lifecycle client is unavailable."));
  }
  return rendererLayoutLifecycle.resume();
}

function runLayoutFence(
  reason: string,
  action: () => void | Promise<void>,
): Promise<void> {
  return layoutFence ? layoutFence.run(reason, action) : Promise.resolve().then(action);
}

function runLayoutTransient(
  reason: string,
  action: DestructiveLifecycleAction,
): Promise<void> {
  if (layoutFence) return layoutFence.runTransient(reason, action);
  const controller = new AbortController();
  return Promise.resolve(action(controller.signal))
    .then((commit) => commit())
    .finally(() => controller.abort());
}

function runLayoutShutdown(
  reason: string,
  prepareTerminalShutdown: (signal: AbortSignal) => void | Promise<void>,
  commitTerminalShutdown: TerminalLifecycleCommit,
): Promise<void> {
  if (layoutFence) {
    return layoutFence.runShutdown(
      reason,
      prepareTerminalShutdown,
      commitTerminalShutdown,
    );
  }
  const controller = new AbortController();
  return Promise.resolve(prepareTerminalShutdown(controller.signal))
    .then(commitTerminalShutdown)
    .finally(() => controller.abort());
}

function closeBrowserWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.destroy();
  if (!window.isDestroyed()) {
    throw new Error("BrowserWindow close did not synchronously destroy the Renderer.");
  }
}

function reloadBrowserWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.webContents.reload();
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
    "renderer-layout-drained",
    "layout-suspended",
    "layout-flushed",
    "renderer-destroyed",
    "host-stop-started",
    "host-stop-complete",
  ];
  const evidence = {
    schemaVersion: 3,
    phase: desktopPilotPhase === "1" ? 1 : 2,
    events: phase3ShutdownEvents,
    rendererDestroyedBeforeHostStop:
      phase3ShutdownEvents.indexOf("renderer-destroyed") >= 0 &&
      phase3ShutdownEvents.indexOf("renderer-destroyed") <
        phase3ShutdownEvents.indexOf("host-stop-started"),
    postDestroyObservationMs: requiredPositiveIntegerEnvironment(
      "SCOPEGUARD_PHASE3_PILOT_POST_DESTROY_OBSERVATION_MS",
    ),
    lateLayoutStageAttempts: phase3LateLayoutStageAttempts,
    lateLayoutObservation: phase3LateLayoutObservation,
    quiescedLayoutStageAttempts: phase3QuiescedLayoutStageAttempts,
    targetLayoutDrain: phase3LayoutDrainEvidence?.snapshot() ?? null,
    rendererDrainAcknowledgedBeforeMainSuspend:
      phase3ShutdownEvents.indexOf("renderer-layout-drained") >= 0 &&
      phase3ShutdownEvents.indexOf("renderer-layout-drained") <
        phase3ShutdownEvents.indexOf("layout-suspended"),
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
  if (!phase3LateLayoutObservation) {
    throw new Error("Phase 3 late-layout observation evidence is missing.");
  }
  assertPhase3LateLayoutObservation(phase3LateLayoutObservation);
}

async function waitForPhase3TargetLayoutRejection(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!phase3LayoutDrainEvidence?.targetRevisionRejectedWhileQuiescing) {
    if (Date.now() >= deadline) {
      throw new Error("Phase 3 target layout revision was not rejected while Main quiesced.");
    }
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
}

function requiredPositiveIntegerEnvironment(name: string): number {
  const value = Number(requiredPilotEnvironment(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Lifecycle wait was cancelled."));
  }
  return new Promise((resolveWait, rejectWait) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectWait(new Error("Lifecycle wait was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
