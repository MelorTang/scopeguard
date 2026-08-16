import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ScopeGuardApplication } from "@scopeguard/application";
import { createProviderAdapter } from "@scopeguard/provider-adapters";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";
import { ScopeGuardToolRegistry } from "@scopeguard/tool-runtime";

class MemorySecretVault {
  #values = new Map();

  async put(reference, secret) {
    this.#values.set(reference, secret);
    return reference;
  }

  async get(reference) {
    return this.#values.get(reference) ?? null;
  }

  async delete(reference) {
    this.#values.delete(reference);
  }
}

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../..");
const profileDirectory = await mkdtemp(join(tmpdir(), "scopeguard-local-pilot-"));
const writableWorkspaceRoot = join(profileDirectory, "writable-workspace");
const databasePath = join(profileDirectory, "scopeguard.db");
const apiKey = "sg-fake-desktop-validation-key";
const port = await findAvailablePort();
const providerProcess = spawn(
  process.execPath,
  [join(desktopRoot, "scripts/mock-provider.mjs")],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SCOPEGUARD_MOCK_PROVIDER_PORT: String(port),
      SCOPEGUARD_MOCK_PROVIDER_KEY: apiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let application;
let store;
let tools;
let providerDiagnostics = "";
providerProcess.stderr.setEncoding("utf8");
providerProcess.stderr.on("data", (chunk) => {
  providerDiagnostics += chunk;
});

try {
  await waitForProvider(providerProcess, port);
  await mkdir(writableWorkspaceRoot, { recursive: true });
  await writeFile(
    join(writableWorkspaceRoot, "package.json"),
    JSON.stringify({ name: "scopeguard-pilot-workspace", private: true }, null, 2),
    "utf8",
  );

  const vault = new MemorySecretVault();
  ({ application, store, tools } = createApplication(databasePath, vault));
  assert.equal(application.initialize().interruptedRuns, 0);

  const providerInput = {
    name: "Local Pilot Provider",
    protocol: "openai-compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    defaultModel: "pilot-model",
    apiKey,
  };
  const connection = await application.testProviderConnection(providerInput);
  assert.equal(connection.ok, true);
  const provider = await application.saveProviderProfile(providerInput);

  const projectWorkspace = application.createWorkspace({
    name: "ScopeGuard source",
    localRootPath: repositoryRoot,
  });
  const projectAgent = application.createAgent({
    workspaceId: projectWorkspace.id,
    name: "Source reader",
    instructions: "Inspect the selected project without modifying it.",
    providerProfileId: provider.id,
    executionProfile: "request-approval",
    toolPolicy: {
      readFiles: "allow",
      writeFiles: "deny",
      runCommands: "deny",
    },
  });
  const sourceConversation = application.createConversation({
    workspaceId: projectWorkspace.id,
    agentId: projectAgent.id,
    title: "Read source",
  });
  const parallelConversation = application.createConversation({
    workspaceId: projectWorkspace.id,
    agentId: projectAgent.id,
    title: "Parallel work",
  });

  const readRun = await application.startRun({
    conversationId: sourceConversation.id,
    prompt: "[tool:read] Read the project package metadata.",
  });
  assert.equal((await application.waitForRun(readRun.id)).status, "completed");
  assert.match(
    store.listToolCallsForRun(readRun.id)[0]?.output ?? "",
    /"name"\s*:\s*"scopeguard"/,
  );

  const slowRun = await application.startRun({
    conversationId: sourceConversation.id,
    prompt: "[slow] Keep this Conversation busy.",
  });
  const fastRun = await application.startRun({
    conversationId: parallelConversation.id,
    prompt: "Finish independently while the other Conversation is running.",
  });
  assert.equal((await application.waitForRun(fastRun.id)).status, "completed");
  await application.cancelRun(slowRun.id);
  assert.equal((await application.waitForRun(slowRun.id)).status, "cancelled");

  const privateMarker = "PRIVATE_CONVERSATION_MARKER_7f3d";
  const privateRun = await application.startRun({
    conversationId: sourceConversation.id,
    prompt: `Remember ${privateMarker} only in this Conversation.`,
  });
  assert.equal((await application.waitForRun(privateRun.id)).status, "completed");
  const isolatedRun = await application.startRun({
    conversationId: parallelConversation.id,
    prompt: "Check transcript isolation.",
  });
  assert.equal((await application.waitForRun(isolatedRun.id)).status, "completed");
  assert.equal(manifestText(store, isolatedRun.id).includes(privateMarker), false);

  const sharedMarker = "SHARED_WORKSPACE_CONTEXT_91ac";
  application.updateWorkspaceContext(
    projectWorkspace.id,
    sharedMarker,
    sourceConversation.id,
    privateRun.id,
  );
  const contextRun = await application.startRun({
    conversationId: parallelConversation.id,
    prompt: "Read the explicitly shared Workspace Context.",
  });
  assert.equal((await application.waitForRun(contextRun.id)).status, "completed");
  assert.equal(manifestText(store, contextRun.id).includes(sharedMarker), true);
  assert.equal(manifestText(store, contextRun.id).includes(privateMarker), false);

  const writableWorkspace = application.createWorkspace({
    name: "Approval workspace",
    localRootPath: writableWorkspaceRoot,
  });
  const writerAgent = application.createAgent({
    workspaceId: writableWorkspace.id,
    name: "Approval writer",
    instructions: "Write only after the configured approval policy allows it.",
    providerProfileId: provider.id,
    executionProfile: "request-approval",
    toolPolicy: {
      readFiles: "allow",
      writeFiles: "ask",
      runCommands: "deny",
    },
  });
  const writerConversation = application.createConversation({
    workspaceId: writableWorkspace.id,
    agentId: writerAgent.id,
    title: "Approval flow",
  });

  const deniedRun = await application.startRun({
    conversationId: writerConversation.id,
    prompt: "[tool:write] Attempt the denied write.",
  });
  const deniedApproval = await waitForApproval(store, deniedRun.id);
  await application.resolveApproval(deniedApproval.id, "denied");
  assert.equal((await application.waitForRun(deniedRun.id)).status, "completed");
  await assert.rejects(access(join(writableWorkspaceRoot, "scopeguard-write-smoke.txt")));
  assert.equal(store.listToolCallsForRun(deniedRun.id)[0]?.status, "denied");

  const approvedRun = await application.startRun({
    conversationId: writerConversation.id,
    prompt: "[tool:write] Retry the write with approval.",
  });
  const approvedApproval = await waitForApproval(store, approvedRun.id);
  await application.resolveApproval(approvedApproval.id, "approved-once");
  assert.equal((await application.waitForRun(approvedRun.id)).status, "completed");
  assert.equal(
    await readFile(join(writableWorkspaceRoot, "scopeguard-write-smoke.txt"), "utf8"),
    "ScopeGuard write_file smoke test.\n",
  );
  assert.equal(store.listToolCallsForRun(approvedRun.id)[0]?.status, "succeeded");

  const inputRun = await application.startRun({
    conversationId: writerConversation.id,
    prompt: "[tool:input] Ask for the reporting period.",
  });
  await waitForRunStatus(store, inputRun.id, "waiting-input");
  const resumedRun = await application.startRun({
    conversationId: writerConversation.id,
    prompt: "2026 Q2",
  });
  assert.equal(resumedRun.id, inputRun.id);
  assert.equal((await application.waitForRun(inputRun.id)).status, "completed");

  const partialRun = await application.startRun({
    conversationId: writerConversation.id,
    prompt: "[slow-partial] Produce partial output before restart.",
  });
  await waitForCondition(
    () => Boolean(store.getRunPartial(partialRun.id)),
    "Partial output was not checkpointed.",
  );
  await application.shutdown();
  await tools.shutdown();
  store.close();
  application = undefined;
  tools = undefined;
  store = undefined;

  ({ application, store, tools } = createApplication(databasePath, vault));
  assert.equal(application.initialize().interruptedRuns, 0);
  assert.equal(store.getRun(partialRun.id)?.status, "interrupted");
  assert.match(conversationText(store, writerConversation.id), /Partial response before restart/);
  const recoveryRun = await application.startRun({
    conversationId: writerConversation.id,
    prompt: "Continue after the verified restart.",
  });
  assert.equal((await application.waitForRun(recoveryRun.id)).status, "completed");

  const tables = store.listSchemaTables();
  assert.deepEqual(tables, [
    "agents",
    "conversation_messages",
    "conversations",
    "provider_profiles",
    "run_events",
    "run_partials",
    "run_request_manifests",
    "run_usage_records",
    "runs",
    "schema_metadata",
    "tool_approvals",
    "tool_calls",
    "workspace_context_revisions",
    "workspaces",
  ]);

  await application.shutdown();
  await tools.shutdown();
  store.close();
  application = undefined;
  tools = undefined;
  store = undefined;
  assert.equal(await filesContain(profileDirectory, "scopeguard.db", apiKey), false);

  process.stdout.write(`${JSON.stringify({
    passed: true,
    checks: {
      providerConnection: true,
      realProjectRead: true,
      parallelConversationCancellation: true,
      conversationIsolation: true,
      explicitWorkspaceContext: true,
      approvalDeniedWithoutEffect: true,
      approvalGrantedOnce: true,
      sameRunInputContinuation: true,
      interruptedPartialRecovery: true,
      freshV1TablesOnly: true,
      providerKeyAbsentFromSqlite: true,
    },
  }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n${providerDiagnostics}`);
  process.exitCode = 1;
} finally {
  await application?.shutdown().catch(() => {});
  await tools?.shutdown().catch(() => {});
  store?.close();
  providerProcess.kill("SIGTERM");
  if (process.env.SCOPEGUARD_KEEP_PILOT !== "1") {
    await rm(profileDirectory, { recursive: true, force: true });
  } else {
    process.stderr.write(`Pilot profile retained at ${profileDirectory}\n`);
  }
}

function createApplication(path, vault) {
  const nextStore = new ScopeGuardStore(path);
  const nextTools = new ScopeGuardToolRegistry();
  const nextApplication = new ScopeGuardApplication({
    store: nextStore,
    secrets: vault,
    providerFactory: (protocol) => createProviderAdapter({ protocol }),
    tools: nextTools,
  });
  return { application: nextApplication, store: nextStore, tools: nextTools };
}

function manifestText(currentStore, runId) {
  return JSON.stringify(currentStore.listRunRequestManifests(runId));
}

function conversationText(currentStore, conversationId) {
  return currentStore.listConversationMessages(conversationId)
    .flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .join("\n");
}

async function waitForApproval(currentStore, runId) {
  await waitForCondition(
    () => currentStore.listPendingApprovals().some((approval) => approval.runId === runId),
    `Run ${runId} did not request approval.`,
  );
  const approval = currentStore.listPendingApprovals().find(
    (candidate) => candidate.runId === runId,
  );
  assert.ok(approval);
  return approval;
}

async function waitForRunStatus(currentStore, runId, status) {
  await waitForCondition(
    () => currentStore.getRun(runId)?.status === status,
    `Run ${runId} did not reach ${status}.`,
  );
}

async function waitForCondition(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(message);
}

async function findAvailablePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolvePromise, reject) =>
    probe.close((error) => error ? reject(error) : resolvePromise())
  );
  return address.port;
}

function waitForProvider(child, expectedPort) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Mock Provider did not become ready."));
    }, 5_000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(`127.0.0.1:${expectedPort}/v1`)) {
        cleanup();
        resolvePromise();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Mock Provider exited before readiness (${code}).`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function filesContain(directory, prefix, value) {
  const names = (await readdir(directory)).filter((name) => name.startsWith(prefix));
  const needle = Buffer.from(value, "utf8");
  for (const name of names) {
    if ((await readFile(join(directory, name))).includes(needle)) return true;
  }
  return false;
}
