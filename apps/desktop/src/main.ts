import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

type BoardServer = {
  close: () => Promise<void>;
};

type ScopeGuardServerModule = {
  startBoardServer: (gitRoot: string, port: number) => Promise<BoardServer>;
};

type ElectronApp = {
  whenReady: () => Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  quit: () => void;
};

type ElectronBrowserWindow = new (options: Record<string, unknown>) => {
  loadURL: (url: string) => Promise<void>;
};

type ElectronRuntime = {
  app: ElectronApp;
  BrowserWindow: ElectronBrowserWindow;
  dialog: {
    showOpenDialog: (options: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
  };
};

type DesktopArgs = {
  projectRoot: string;
  port: number;
};

type DesktopProjectSnapshot = {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string | null;
  isGitRepo?: boolean;
  isInitialized: boolean;
  taskCount: number;
  activeTaskCount: number;
  updatedAt: string | null;
  source: "scopeguard" | "new-folder" | "local-folder";
};

const require = createRequire(import.meta.url);
const electron = require("electron") as ElectronRuntime;
const scopeguardServer = require("@scopeguard/server") as ScopeGuardServerModule;
const { app, BrowserWindow, dialog, ipcMain } = electron;
const moduleDir = dirname(fileURLToPath(import.meta.url));

let board: BoardServer | null = null;
let mainWindow: InstanceType<ElectronBrowserWindow> | null = null;
let currentProjectRoot = argsProjectRoot();
const args = parseDesktopArgs(process.argv.slice(2));

// ── Server build consistency check ─────────────────────────────────────
// Verifies that apps/server/dist/index.js is not older than
// apps/server/src/index.ts, so developers don't accidentally run stale code.

const moduleDirForCheck = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC_PATH = resolve(moduleDirForCheck, "../../server/src/index.ts");
const SERVER_DIST_PATH = resolve(moduleDirForCheck, "../../server/dist/index.js");

function verifyServerBuild(): { ok: boolean; srcMtime: string | null; distMtime: string | null; message: string } {
  const srcExists = existsSync(SERVER_SRC_PATH);
  const distExists = existsSync(SERVER_DIST_PATH);

  let srcMtime: string | null = null;
  let distMtime: string | null = null;
  let message = "";

  if (!srcExists && !distExists) {
    message = "[scopeguard-desktop] WARNING: server source and dist both missing at " + SERVER_DIST_PATH;
    return { ok: false, srcMtime: null, distMtime: null, message };
  }

  if (!distExists) {
    message = "[scopeguard-desktop] WARNING: server dist not found. Run pnpm --filter @scopeguard/server build first.";
    return { ok: false, srcMtime: null, distMtime: null, message };
  }

  try {
    const srcStat = srcExists ? statSync(SERVER_SRC_PATH) : null;
    const distStat = statSync(SERVER_DIST_PATH);
    srcMtime = srcStat ? srcStat.mtime.toISOString() : null;
    distMtime = distStat.mtime.toISOString();

    console.log("[scopeguard-desktop] server src:  " + (srcMtime ?? "N/A") + " " + SERVER_SRC_PATH);
    console.log("[scopeguard-desktop] server dist: " + distMtime + " " + SERVER_DIST_PATH);
    console.log("[scopeguard-desktop] server boot: " + (srcExists ? "SRC+dist" : "dist-only"));

    if (srcStat && srcStat.mtimeMs > distStat.mtimeMs + 1000) {
      message = "[scopeguard-desktop] WARNING: server src is NEWER than dist. Rebuild with: pnpm --filter @scopeguard/server build";
      console.warn(message);
      return { ok: false, srcMtime, distMtime, message };
    }

    message = "[scopeguard-desktop] server dist is up to date.";
    console.log(message);
    return { ok: true, srcMtime, distMtime, message };
  } catch (err) {
    message = "[scopeguard-desktop] WARNING: server build check failed: " + (err instanceof Error ? err.message : String(err));
    console.warn(message);
    return { ok: false, srcMtime: null, distMtime: null, message };
  }
}

app.whenReady().then(async () => {
  const buildCheck = verifyServerBuild();
  if (!buildCheck.ok) {
    // Non-fatal warning — desktop can still start with stale dist
    console.log(buildCheck.message);
  }

  currentProjectRoot = args.projectRoot;
  const resolvedGitRoot = findGitRoot(currentProjectRoot) ?? currentProjectRoot;
  console.log("[scopeguard-desktop] startBoardServer projectRoot=" + currentProjectRoot + " resolvedGitRoot=" + resolvedGitRoot + " port=" + args.port);
  board = await scopeguardServer.startBoardServer(currentProjectRoot, args.port);
  upsertRecentProject(buildProjectSnapshot(currentProjectRoot));

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "ScopeGuard",
    backgroundColor: "#f4f4fb",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolvePreloadPath(),
      sandbox: true,
    },
  });

  await mainWindow.loadURL(`http://127.0.0.1:${args.port}`);
});

ipcMain.handle("scopeguard:open-project-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open Project Folder",
    properties: ["openDirectory"],
    defaultPath: currentProjectRoot,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  const selectedPath = resolve(result.filePaths[0] ?? currentProjectRoot);
  const projectRoot = findGitRoot(selectedPath) ?? selectedPath;

  await restartBoardServer(projectRoot);
  const project = buildProjectSnapshot(projectRoot);
  upsertRecentProject(project);

  return { ok: true, folderPath: projectRoot, selectedPath, project };
});

ipcMain.handle("scopeguard:get-recent-projects", async () => {
  return { ok: true, projects: readRecentProjects() };
});

ipcMain.handle("scopeguard:get-external-api-token", async (_event, projectRoot: unknown) => {
  const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (!root) {
    return { ok: false, message: "projectRoot is required." };
  }
  // Use the same token path logic as the server
  const { randomUUID } = require("node:crypto");
  const tokenPath = join(root, ".scopeguard", "config", "external-api-token.json");
  if (existsSync(tokenPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tokenPath, "utf-8")) as { token?: string };
      if (parsed.token && typeof parsed.token === "string" && parsed.token.length > 0) {
        return { ok: true, token: parsed.token };
      }
    } catch { /* fall through to generate */ }
  }
  const newToken = randomUUID() + "-" + randomUUID();
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: newToken }, null, 2) + "\n", "utf-8");
  return { ok: true, token: newToken };
});

ipcMain.handle("scopeguard:open-known-project", async (_event, rawPath: unknown) => {
  const requestedPath = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!requestedPath) {
    return { ok: false, message: "projectPath is required." };
  }

  const selectedPath = resolve(requestedPath);
  if (!existsSync(selectedPath)) {
    return { ok: false, message: `Project path not found: ${selectedPath}` };
  }

  const projectRoot = findGitRoot(selectedPath) ?? selectedPath;

  await restartBoardServer(projectRoot);
  const project = buildProjectSnapshot(projectRoot);
  upsertRecentProject(project);

  return { ok: true, folderPath: projectRoot, selectedPath, project };
});

app.on("window-all-closed", () => {
  void shutdown();
});

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

async function shutdown(): Promise<void> {
  if (board) {
    await board.close();
    board = null;
  }
  app.quit();
}

async function restartBoardServer(projectRoot: string): Promise<void> {
  const oldRoot = currentProjectRoot;
  console.log("[scopeguard-desktop] restartBoardServer old=" + oldRoot + " new=" + projectRoot);

  if (board) {
    await board.close().catch(function (closeErr: unknown) {
      console.log("[scopeguard-desktop] restartBoardServer: board.close error: " + ((closeErr && typeof closeErr === "object" && "message" in closeErr) ? (closeErr as Error).message : String(closeErr)));
    });
    board = null;
  }

  currentProjectRoot = projectRoot;
  try {
    board = await scopeguardServer.startBoardServer(currentProjectRoot, args.port);
    console.log("[scopeguard-desktop] restartBoardServer: new board started on port " + args.port);
  } catch (err) {
    console.log("[scopeguard-desktop] restartBoardServer: FAILED to start board: " + ((err && typeof err === "object" && "message" in err) ? (err as Error).message : String(err)));
    throw err;
  }
}

function argsProjectRoot(): string {
  return findGitRoot(process.cwd()) ?? resolve(process.cwd());
}

function resolvePreloadPath(): string {
  const distPreload = join(moduleDir, "preload.cjs");
  if (existsSync(distPreload)) {
    return distPreload;
  }

  return join(moduleDir, "../src/preload.cjs");
}

function findGitRoot(folderPath: string): string | null {
  let current = resolve(folderPath);

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function buildProjectSnapshot(folderPath: string): DesktopProjectSnapshot {
  const resolvedRoot = findGitRoot(folderPath);
  if (!resolvedRoot) {
    const workspaceRoot = normalizeSlashes(resolve(folderPath));
    return {
      id: `local:${workspaceRoot.toLowerCase()}`,
      name: workspaceRoot.replace(/^.*[\\/]/, ""),
      rootPath: workspaceRoot,
      defaultBranch: null,
      isGitRepo: false,
      isInitialized: false,
      taskCount: 0,
      activeTaskCount: 0,
      updatedAt: null,
      source: "local-folder",
    };
  }

  const normalizedRoot = normalizeSlashes(resolvedRoot);
  const configPath = join(resolvedRoot, ".scopeguard", "config.json");
  if (!existsSync(configPath)) {
    return {
      id: `git:${normalizedRoot.toLowerCase()}`,
      name: resolvedRoot.replace(/^.*[\\/]/, ""),
      rootPath: normalizedRoot,
      defaultBranch: getDefaultBranch(resolvedRoot),
      isGitRepo: true,
      isInitialized: false,
      taskCount: 0,
      activeTaskCount: 0,
      updatedAt: null,
      source: "new-folder",
    };
  }

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projectId?: string;
      projectName?: string;
      rootPath?: string;
      defaultBranch?: string;
    };
    const tasksRoot = join(resolvedRoot, ".scopeguard", "tasks");
    const taskDirs = existsSync(tasksRoot)
      ? require("node:fs").readdirSync(tasksRoot, { withFileTypes: true }).filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
      : [];
    let activeTaskCount = 0;
    let updatedAt: string | null = null;

    for (const entry of taskDirs) {
      const taskPath = join(tasksRoot, entry.name, "task.json");
      if (!existsSync(taskPath)) {
        continue;
      }
      try {
        const task = JSON.parse(readFileSync(taskPath, "utf-8")) as { status?: string; updatedAt?: string };
        if (!["merged", "closed"].includes(String(task.status || ""))) {
          activeTaskCount += 1;
        }
        if (typeof task.updatedAt === "string" && (!updatedAt || task.updatedAt > updatedAt)) {
          updatedAt = task.updatedAt;
        }
      } catch {
        // ignore malformed task file
      }
    }

    return {
      id: config.projectId || `scopeguard:${normalizedRoot.toLowerCase()}`,
      name: config.projectName || resolvedRoot.replace(/^.*[\\/]/, ""),
      rootPath: normalizeSlashes(config.rootPath || resolvedRoot),
      defaultBranch: config.defaultBranch || getDefaultBranch(resolvedRoot),
      isGitRepo: true,
      isInitialized: true,
      taskCount: taskDirs.length,
      activeTaskCount,
      updatedAt,
      source: "scopeguard",
    };
  } catch {
    return {
      id: `git:${normalizedRoot.toLowerCase()}`,
      name: resolvedRoot.replace(/^.*[\\/]/, ""),
      rootPath: normalizedRoot,
      defaultBranch: getDefaultBranch(resolvedRoot),
      isGitRepo: true,
      isInitialized: false,
      taskCount: 0,
      activeTaskCount: 0,
      updatedAt: null,
      source: "new-folder",
    };
  }
}

function getRecentProjectsPath(): string {
  const baseDir = process.env.APPDATA?.trim()
    ? join(process.env.APPDATA.trim(), "ScopeGuard", "desktop")
    : join(homedir(), ".scopeguard", "desktop");
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, "recent-projects.json");
}

function readRecentProjects(): DesktopProjectSnapshot[] {
  const filePath = getRecentProjectsPath();
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as DesktopProjectSnapshot[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized: DesktopProjectSnapshot[] = [];
    for (const item of parsed) {
      if (!item || typeof item.rootPath !== "string") {
        continue;
      }

      const rawRootPath = item.rootPath.trim();
      if (!rawRootPath || !existsSync(rawRootPath)) {
        continue;
      }

      const snapshot = buildProjectSnapshot(rawRootPath);
      if (normalized.some((existing) => normalizeSlashes(existing.rootPath) === normalizeSlashes(snapshot.rootPath))) {
        continue;
      }

      normalized.push(snapshot);
    }

    const before = JSON.stringify(parsed);
    const after = JSON.stringify(normalized);
    if (before !== after) {
      writeRecentProjects(normalized);
    }

    return normalized;
  } catch {
    return [];
  }
}

function writeRecentProjects(projects: DesktopProjectSnapshot[]): void {
  writeFileSync(getRecentProjectsPath(), `${JSON.stringify(projects.slice(0, 12), null, 2)}\n`, "utf-8");
}

function upsertRecentProject(project: DesktopProjectSnapshot): void {
  const current = readRecentProjects();
  const existingIndex = current.findIndex((item) => normalizeSlashes(item.rootPath) === normalizeSlashes(project.rootPath));

  if (existingIndex >= 0) {
    current[existingIndex] = {
      ...current[existingIndex],
      ...project,
    };
    writeRecentProjects(current);
    return;
  }

  current.push(project);
  writeRecentProjects(current);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function getDefaultBranch(gitRoot: string): string | null {
  try {
    const result = require("node:child_process").execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: gitRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    const match = result.match(/refs\/remotes\/origin\/(.+)$/);
    return match ? match[1] : null;
  } catch {
    try {
      const branch = require("node:child_process").execSync("git branch --show-current", {
        cwd: gitRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      return branch || null;
    } catch {
      return null;
    }
  }
}

function parseDesktopArgs(rawArgs: string[]): DesktopArgs {
  const projectArg = readFlag(rawArgs, "--project") ?? process.cwd();
  const portArg = readFlag(rawArgs, "--port");
  const port = portArg ? Number(portArg) : 3737;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid --port value. Use a number between 1 and 65535.");
  }

  return {
    projectRoot: resolve(projectArg),
    port,
  };
}

function readFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}
