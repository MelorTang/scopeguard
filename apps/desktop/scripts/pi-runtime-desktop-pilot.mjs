import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { app, utilityProcess } from "electron";

import { startPiRuntimeFakeProvider } from "./pi-runtime-fake-provider.mjs";

console.log("[pi-runtime-pilot] Electron main loaded");
app.disableHardwareAcceleration();
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = process.env.SCOPEGUARD_PILOT_STAGE_ROOT
  ? resolve(process.env.SCOPEGUARD_PILOT_STAGE_ROOT)
  : null;
const secret = "desktop-pilot-secret";
const secrets = new Map();
let root;
let workspaceRoot;
let databasePath;
let piSessionRoot;
let provider;
let host;

void runPilot();

async function runPilot() {
  try {
    root = await mkdtemp(join(tmpdir(), "scopeguard-desktop-pi-pilot-"));
    workspaceRoot = join(root, "workspace");
    databasePath = join(root, "scopeguard.db");
    piSessionRoot = join(root, "pi-sessions");
    await withTimeout(app.whenReady(), 15_000, "Electron app readiness timeout");
    console.log("[pi-runtime-pilot] Electron ready");
    await mkdir(workspaceRoot);
    provider = await startPiRuntimeFakeProvider(secret);
    host = await startHost();
  const workspace = await host.request("createWorkspace", { name: "Desktop Pilot", localRootPath: workspaceRoot });
  const profile = await host.request("saveProviderProfile", {
    name: "Pilot Provider",
    protocol: "openai-compatible",
    baseUrl: `${provider.baseUrl}/v1`,
    defaultModel: "desktop-pilot-model",
    apiKey: secret,
  });
  const agent = await host.request("createAgent", {
    workspaceId: workspace.id,
    name: "Pilot Agent",
    instructions: "Reply briefly and do not call tools.",
    providerProfileId: profile.id,
  });
  const conversation = await host.request("createConversation", {
    workspaceId: workspace.id,
    agentId: agent.id,
    title: "Restart proof",
  });
  const first = await host.request("startRun", { conversationId: conversation.id, prompt: "first-turn" });
  await host.waitForRun(first.id, "completed");
  const firstSnapshot = await host.request("getWorkspaceSnapshot");
  const firstLocator = firstSnapshot.conversations.find((item) => item.id === conversation.id)?.piSession;
  assert.ok(firstLocator?.sessionFile);
  assert.equal(firstLocator.piVersion, "0.84.2");
  const firstMessages = await host.request("listConversationMessages", conversation.id);
  assert.deepEqual(firstMessages.map((message) => message.role), ["user", "assistant"]);
  await host.stop();

  host = await startHost();
  const resumedSnapshot = await host.request("getWorkspaceSnapshot");
  const resumedLocator = resumedSnapshot.conversations.find((item) => item.id === conversation.id)?.piSession;
  assert.equal(resumedLocator.sessionId, firstLocator.sessionId);
  assert.equal(resumedLocator.sessionFile, firstLocator.sessionFile);
  const second = await host.request("startRun", { conversationId: conversation.id, prompt: "second-turn" });
  await host.waitForRun(second.id, "completed");
  const secondMessages = await host.request("listConversationMessages", conversation.id);
  assert.deepEqual(secondMessages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  const finalRequest = provider.requests.at(-1);
  assert.deepEqual(finalRequest.userTexts, ["first-turn", "second-turn"]);
  assert.equal(provider.requests.every((request) => request.authorized), true);
    console.log(JSON.stringify({
      checks: 10,
      piVersion: resumedLocator.piVersion,
      sessionId: resumedLocator.sessionId,
      messagesAfterRestart: secondMessages.length,
      providerObservedHistory: finalRequest.userTexts,
    }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await host?.stop().catch(() => {});
    await provider?.close().catch(() => {});
    if (root) {
      await rm(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
    app.exit(process.exitCode ?? 0);
  }
}

async function startHost() {
  const runtimeRoot = stageRoot ? join(stageRoot, "runtime") : null;
  const child = utilityProcess.fork(
    stageRoot ? join(stageRoot, "dist", "agent-host.js") : join(packageRoot, "dist", "agent-host.js"),
    [], {
    serviceName: "ScopeGuard Pi Runtime Pilot Host",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SCOPEGUARD_DB_PATH: databasePath,
      SCOPEGUARD_PI_SESSION_ROOT: piSessionRoot,
      ...(runtimeRoot ? {
        SCOPEGUARD_PI_CLI_PATH: join(
          runtimeRoot,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        ),
        SCOPEGUARD_PI_RUNTIME_ASSET_ROOT: runtimeRoot,
      } : {}),
    },
    stdio: "pipe",
    },
  );
  const pending = new Map();
  const runWaiters = new Map();
  const terminalRuns = new Map();
  let sequence = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  child.on("message", (message) => {
    if (message.type === "host-ready") {
      readyResolve();
    } else if (message.type === "host-response") {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      message.ok ? request.resolve(message.result) : request.reject(new Error(message.error?.message));
    } else if (message.type === "host-secret-request") {
      if (message.operation === "put") secrets.set(message.reference, message.secret);
      const response = {
        type: "host-secret-response",
        requestId: message.requestId,
        ok: true,
        ...(message.operation === "get" ? { secret: secrets.get(message.reference) ?? null } : {}),
        ...(message.operation === "put" ? { reference: message.reference } : {}),
      };
      if (message.operation === "delete") secrets.delete(message.reference);
      child.postMessage(response);
    } else if (message.type === "host-run-event" && message.event.type === "run-status") {
      const waiter = runWaiters.get(message.event.runId);
      if (["completed", "failed", "cancelled", "interrupted"].includes(message.event.status)) {
        terminalRuns.set(message.event.runId, message.event);
      }
      if (waiter && terminalRuns.has(message.event.runId)) {
        runWaiters.delete(message.event.runId);
        message.event.status === waiter.expected
          ? waiter.resolve(message.event)
          : waiter.reject(new Error(`Run ended ${message.event.status}: ${message.event.error ?? ""}`));
      }
    }
  });
  child.once("exit", (code) => {
    readyReject(new Error(`Pilot Agent host exited before ready: ${code}`));
    for (const request of pending.values()) request.reject(new Error(`Pilot Agent host exited: ${code}`));
    pending.clear();
  });
  await withTimeout(ready, 15_000, "Pilot Agent host readiness timeout");
  return {
    request(method, payload) {
      const requestId = `pilot-${++sequence}`;
      const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
      child.postMessage({ type: "host-request", requestId, method, payload });
      return withTimeout(result, 60_000, `Pilot request timed out: ${method}`);
    },
    waitForRun(runId, expected) {
      const terminal = terminalRuns.get(runId);
      if (terminal) {
        return terminal.status === expected
          ? Promise.resolve(terminal)
          : Promise.reject(new Error(`Run ended ${terminal.status}: ${terminal.error ?? ""}`));
      }
      const result = new Promise((resolve, reject) => runWaiters.set(runId, { expected, resolve, reject }));
      return withTimeout(result, 60_000, `Pilot Run timed out: ${runId}`);
    },
    async stop() {
      if (child.killed) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.postMessage({ type: "host-shutdown" });
      await withTimeout(exited, 10_000, "Pilot Agent host shutdown timeout").catch(() => child.kill());
    },
  };
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds)),
  ]);
}
