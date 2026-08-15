import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";

import {
  type ManagedExecutionAdapter,
  UnavailableManagedExecutionAdapter,
  WindowsLpacManagedExecutionAdapter,
} from "@scopeguard/managed-execution";

type BrokerManifest = {
  pipeName: string;
  serviceClient: string;
  launcher: string;
  lifetimeBroker: string;
  runtimeId: string;
  workspaces: Array<{ id: string; root: string }>;
};

export async function createDesktopExecutionBroker(input: {
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
}): Promise<ManagedExecutionAdapter> {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return new UnavailableManagedExecutionAdapter();
  }
  const installationRoot = input.isPackaged
    ? resolve(input.resourcesPath, "managed-execution", "windows")
    : resolve(process.cwd(), "packages", "managed-execution", "native", "windows", "bin");
  try {
    const manifest = await readBrokerManifest(
      resolve(installationRoot, "broker-config.json"),
    );
    const registeredRoots = new Map<string, string>();
    for (const workspace of manifest.workspaces) {
      registeredRoots.set(await realpath(workspace.root), workspace.id);
    }
    const diagnosticsDirectory = resolve(
      input.userDataPath,
      "managed-execution",
      "diagnostics",
    );
    const profileStateDirectory = resolve(
      input.userDataPath,
      "managed-execution",
      "profile-intents",
    );
    await mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(profileStateDirectory, { recursive: true, mode: 0o700 });
    return new WindowsLpacManagedExecutionAdapter({
      installationRoot,
      serviceClientPath: resolveInstalledPath(
        installationRoot,
        manifest.serviceClient,
      ),
      launcherPath: resolveInstalledPath(installationRoot, manifest.launcher),
      lifetimeBrokerPath: resolveInstalledPath(
        installationRoot,
        manifest.lifetimeBroker,
      ),
      pipeName: manifest.pipeName,
      runtimeId: manifest.runtimeId,
      diagnosticsDirectory,
      profileStateDirectory,
      platform,
      resolveWorkspaceId: async (request) => {
        const canonical = await realpath(request.workspaceRoot);
        const workspaceId = registeredRoots.get(canonical);
        if (!workspaceId) {
          throw new Error(
            "This Workspace is not registered with the Windows sandbox service.",
          );
        }
        return workspaceId;
      },
    });
  } catch (error) {
    console.error(
      `[scopeguard] Windows managed execution is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new UnavailableManagedExecutionAdapter();
  }
}

export async function readBrokerManifest(path: string): Promise<BrokerManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const record = requireExactRecord(
    parsed,
    [
      "schemaVersion",
      "pipeName",
      "serviceClient",
      "launcher",
      "lifetimeBroker",
      "runtimeId",
      "workspaces",
    ],
    "Broker manifest",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("Broker manifest schemaVersion must be 1.");
  }
  if (!Array.isArray(record.workspaces) || record.workspaces.length > 128) {
    throw new Error("Broker manifest workspaces must be an array of at most 128 entries.");
  }
  const workspaces = record.workspaces.map((value, index) => {
    const workspace = requireExactRecord(value, ["id", "root"], `Workspace ${index}`);
    const id = requireString(workspace.id, `Workspace ${index} id`);
    const root = requireString(workspace.root, `Workspace ${index} root`);
    if (!/^workspace\.[a-z][a-z0-9-]{0,62}$/.test(id) || !isAbsolute(root)) {
      throw new Error(`Workspace ${index} registration is invalid.`);
    }
    return { id, root };
  });
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  const roots = new Set(workspaces.map((workspace) => workspace.root.toLowerCase()));
  if (ids.size !== workspaces.length || roots.size !== workspaces.length) {
    throw new Error("Broker manifest Workspace registrations must be unique.");
  }
  const pipeName = requireString(record.pipeName, "pipeName");
  const runtimeId = requireString(record.runtimeId, "runtimeId");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(pipeName)) {
    throw new Error("Broker manifest pipeName is invalid.");
  }
  if (!/^scopeguard\.[a-z][a-z0-9.-]{0,63}$/.test(runtimeId)) {
    throw new Error("Broker manifest runtimeId is invalid.");
  }
  return {
    pipeName,
    serviceClient: requireRelativeFile(record.serviceClient, "serviceClient"),
    launcher: requireRelativeFile(record.launcher, "launcher"),
    lifetimeBroker: requireRelativeFile(record.lifetimeBroker, "lifetimeBroker"),
    runtimeId,
    workspaces,
  };
}

function resolveInstalledPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith("../") ||
    fromRoot.startsWith("..\\") ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("Broker binary path escapes the installation root.");
  }
  return resolved;
}

function requireRelativeFile(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (isAbsolute(path) || path.includes("/") || path.includes("\\") || path === ".") {
    throw new Error(`${field} must be a filename inside the installation root.`);
  }
  return path;
}

function requireExactRecord(
  value: unknown,
  expected: string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${field} properties must be exactly ${expected.join(", ")}.`);
  }
  return record;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}
