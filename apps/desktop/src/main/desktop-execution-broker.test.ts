import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsLpacManagedExecutionAdapter } from "@scopeguard/managed-execution";

import {
  createDesktopExecutionBroker,
  readBrokerManifest,
} from "./desktop-execution-broker.js";

test("loads only exact installed Broker manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-broker-manifest-"));
  const path = join(root, "broker-config.json");
  try {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      pipeName: "ScopeGuardProvisioner",
      serviceClient: "scopeguard-provisioner-service.exe",
      launcher: "scopeguard-appcontainer.exe",
      lifetimeBroker: "scopeguard-lifetime-broker.exe",
      runtimeId: "scopeguard.node",
      workspaces: [{ id: "workspace.primary", root }],
    }), "utf8");
    assert.equal((await readBrokerManifest(path)).workspaces[0]?.id, "workspace.primary");

    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      pipeName: "ScopeGuardProvisioner",
      serviceClient: "../copied-client.exe",
      launcher: "scopeguard-appcontainer.exe",
      lifetimeBroker: "scopeguard-lifetime-broker.exe",
      runtimeId: "scopeguard.node",
      workspaces: [],
    }), "utf8");
    await assert.rejects(readBrokerManifest(path), /serviceClient/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constructs the Windows adapter only from packaged installation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-broker-factory-"));
  const install = join(root, "resources", "managed-execution", "windows");
  const workspace = join(root, "workspace");
  try {
    await mkdir(install, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(install, "broker-config.json"), JSON.stringify({
      schemaVersion: 1,
      pipeName: "ScopeGuardProvisioner",
      serviceClient: "scopeguard-provisioner-service.exe",
      launcher: "scopeguard-appcontainer.exe",
      lifetimeBroker: "scopeguard-lifetime-broker.exe",
      runtimeId: "scopeguard.node",
      workspaces: [{ id: "workspace.primary", root: workspace }],
    }), "utf8");
    const adapter = await createDesktopExecutionBroker({
      resourcesPath: join(root, "resources"),
      userDataPath: join(root, "user-data"),
      isPackaged: true,
      platform: "win32",
    });
    assert.equal(adapter instanceof WindowsLpacManagedExecutionAdapter, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
