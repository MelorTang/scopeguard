import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startFakeProvider } from "./fake-provider.mjs";
import { classifyRpcRecord, RpcProcess } from "./rpc-process.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(
  here,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const packageJsonPath = path.join(
  here,
  "node_modules/@earendil-works/pi-coding-agent/package.json",
);
const contractPath = path.join(here, "fixtures/expected-contract.json");
const approvalExtensionPath = path.join(here, "approval-extension.ts");
const protocolFailureFixturePath = path.join(
  here,
  "fixtures/protocol-failure-child.mjs",
);
const SECRET = "qualification-secret-never-persist";
const Classification = Object.freeze({
  EXACT: "exact",
  LOSSY: "lossy",
  UNSUPPORTED: "unsupported",
});
const classifications = new Set(Object.values(Classification));

const results = [];
const clients = new Set();
let tempRoot;
let provider;

function record(name, classification, evidence) {
  assert.ok(
    classifications.has(classification),
    `invalid evidence classification: ${classification}`,
  );
  results.push({ name, classification, evidence });
  process.stdout.write(`PASS ${name}: ${evidence}\n`);
}

function assertSuccess(response, command) {
  assert.equal(response.type, "response");
  assert.equal(response.command, command);
  assert.equal(response.success, true, response.error);
  return response.data;
}

function eventKey(record) {
  if (record.type !== "message_update") return record.type;
  return `message_update:${record.assistantMessageEvent?.type ?? "unknown"}`;
}

function assertSubsequence(actual, expected) {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) index += 1;
  }
  assert.equal(
    index,
    expected.length,
    `missing ordered event ${expected[index]} in ${actual.join(", ")}`,
  );
}

async function runPrompt(client, message, timeoutMs = 20_000) {
  const mark = client.mark();
  assertSuccess(
    await client.send({ type: "prompt", message }, 10_000),
    "prompt",
  );
  await client.waitForSettled(mark, timeoutMs);
  return client.records.slice(mark);
}

function cleanEnvironment(configDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    if (/^(HTTP|HTTPS|ALL)_PROXY$/i.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PI_CODING_AGENT_DIR: configDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    SCOPEGUARD_PI_FAKE_KEY: SECRET,
    NO_PROXY: "127.0.0.1,localhost",
  };
}

function clientArgs(sessionDir, extra = []) {
  return [
    "--provider",
    "scopeguard-fake",
    "--model",
    "qualification-model",
    "--session-dir",
    sessionDir,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension",
    approvalExtensionPath,
    "--no-approve",
    "--offline",
    "--tools",
    "read,bash",
    ...extra,
  ];
}

async function startClient(label, env, workspace, sessionDir, extra = []) {
  await mkdir(sessionDir, { recursive: true });
  const client = new RpcProcess({
    cliPath,
    cwd: workspace,
    env,
    args: clientArgs(sessionDir, extra),
    label,
    redactValues: [SECRET],
  });
  clients.add(client);
  await client.start();
  const state = assertSuccess(
    await client.send({ type: "get_state" }),
    "get_state",
  );
  assert.equal(state.model.provider, "scopeguard-fake");
  assert.equal(state.model.id, "qualification-model");
  assertSuccess(
    await client.send({ type: "set_auto_retry", enabled: false }),
    "set_auto_retry",
  );
  assertSuccess(
    await client.send({ type: "set_auto_compaction", enabled: false }),
    "set_auto_compaction",
  );
  return { client, state };
}

async function closeClient(client) {
  if (!clients.has(client)) return null;
  const exit = await client.gracefulShutdown();
  clients.delete(client);
  return exit;
}

async function filesBelow(root) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) found.push(target);
    }
  }
  await visit(root);
  return found;
}

function contentText(content) {
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
    : "";
}

function authoritativeToolCall(records) {
  const event = records.find(
    (item) =>
      item.type === "message_update" &&
      item.assistantMessageEvent?.type === "toolcall_end",
  );
  assert.ok(
    event?.assistantMessageEvent?.toolCall,
    "missing authoritative toolcall_end payload",
  );
  return event.assistantMessageEvent.toolCall;
}

function persistedToolResult(entries, toolCallId) {
  const entry = entries.find(
    (candidate) =>
      candidate.type === "message" &&
      candidate.message?.role === "toolResult" &&
      candidate.message?.toolCallId === toolCallId,
  );
  assert.ok(entry, `missing persisted toolResult for ${toolCallId}`);
  return entry.message;
}

async function approvalCase({ env, workspace, sessions, scenario, response }) {
  const started = await startClient(
    `approval-${scenario}`,
    env,
    workspace,
    path.join(sessions, `approval-${scenario}`),
  );
  const mark = started.client.mark();
  assertSuccess(
    await started.client.send({
      type: "prompt",
      message: `[approval:${scenario}]`,
    }),
    "prompt",
  );
  const request = await started.client.waitFor(
    (item) => item.type === "extension_ui_request" && item.method === "confirm",
    { after: mark, description: `${scenario} approval request` },
  );
  assert.match(request.id, /^[0-9a-f-]{36}$/i);
  const requestPayload = JSON.parse(request.message);
  assert.equal(requestPayload.toolCallId, `call-approval-${scenario}`);
  assert.equal(requestPayload.toolName, "bash");
  assert.equal(requestPayload.scenario, scenario);
  const effectPath = path.join(workspace, `approval-${scenario}.txt`);
  assert.equal(
    existsSync(effectPath),
    false,
    `${scenario} effect occurred before host approval`,
  );

  let sentResponse;
  if (response) {
    sentResponse = started.client.respondToExtension(request, response);
    assert.equal(sentResponse.id, request.id);
  } else {
    assert.equal(scenario, "timeout");
    assert.equal(request.timeout, 150);
  }

  await started.client.waitForSettled(mark, 20_000);
  const records = started.client.records.slice(mark);
  const toolEnd = records.find(
    (item) =>
      item.type === "tool_execution_end" &&
      item.toolCallId === `call-approval-${scenario}`,
  );
  assert.ok(toolEnd);
  const entries = assertSuccess(
    await started.client.send({ type: "get_entries" }),
    "get_entries",
  ).entries;
  const persisted = persistedToolResult(entries, `call-approval-${scenario}`);
  const approved = response?.confirmed === true;

  if (approved) {
    assert.equal(existsSync(effectPath), true);
    assert.equal(await readFile(effectPath, "utf8"), "executed");
    assert.equal(toolEnd.isError, false);
    assert.equal(persisted.isError, false);
  } else {
    assert.equal(existsSync(effectPath), false);
    assert.equal(toolEnd.isError, true);
    assert.equal(persisted.isError, true);
    const expectedReason = `SCOPEGUARD_BLOCKED:${scenario}:call-approval-${scenario}`;
    assert.match(
      contentText(toolEnd.result.content),
      new RegExp(expectedReason),
    );
    assert.match(contentText(persisted.content), new RegExp(expectedReason));
  }

  await closeClient(started.client);
  return { requestId: request.id, persisted, toolEnd };
}

async function forcedFailureCleanupScenario() {
  const failureSecret = "forced-failure-secret";
  const failureRoot = await mkdtemp(
    path.join(os.tmpdir(), "scopeguard-pi-rpc-forced-failure-"),
  );
  const profile = path.join(failureRoot, "profile");
  const workspace = path.join(failureRoot, "workspace");
  const sessions = path.join(failureRoot, "sessions");
  await Promise.all([mkdir(profile), mkdir(workspace), mkdir(sessions)]);
  const failureProvider = await startFakeProvider({
    expectedKey: failureSecret,
  });
  const failureClient = new RpcProcess({
    cwd: workspace,
    env: { ...process.env, SCOPEGUARD_PROTOCOL_FAILURE_SECRET: failureSecret },
    label: "forced-protocol-failure",
    command: process.execPath,
    commandArgs: [protocolFailureFixturePath],
    redactValues: [failureSecret],
    maxStderrBytes: 2_048,
  });

  let observedFailure;
  let childExit;
  try {
    await failureClient.start();
    observedFailure = await failureClient.waitForProtocolFailure();
    throw observedFailure;
  } catch (error) {
    assert.equal(error, observedFailure);
    assert.match(error.message, /invalid JSONL stdout/);
    assert.doesNotMatch(error.message, new RegExp(failureSecret));
  } finally {
    childExit = await failureClient
      .kill("SIGKILL")
      .catch(() => failureClient.exit);
    await failureProvider.close();
    await rm(failureRoot, { recursive: true, force: true });
  }

  assert.ok(observedFailure);
  assert.ok(childExit);
  assert.equal(failureClient.stderrTruncated, true);
  assert.ok(Buffer.byteLength(failureClient.stderr, "utf8") <= 2_100);
  assert.doesNotMatch(failureClient.stderr, new RegExp(failureSecret));
  assert.match(failureClient.stderr, /\[TRUNCATED\]/);
  assert.equal(failureProvider.isListening(), false);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(workspace), false);
  assert.equal(existsSync(sessions), false);
  assert.equal(existsSync(failureRoot), false);
}

async function main() {
  assert.ok(existsSync(cliPath), `Pi CLI missing: ${cliPath}`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  assert.equal(packageJson.name, contract.package);
  assert.equal(packageJson.version, contract.version);
  assert.equal(packageJson.license, "MIT");

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "scopeguard-pi-rpc-"));
  const configDir = path.join(tempRoot, "config");
  const workspace = path.join(tempRoot, "workspace");
  const sessions = path.join(tempRoot, "sessions");
  await Promise.all([mkdir(configDir), mkdir(workspace), mkdir(sessions)]);

  provider = await startFakeProvider({ expectedKey: SECRET });
  await writeFile(
    path.join(configDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "scopeguard-fake": {
            baseUrl: `${provider.baseUrl}/v1`,
            api: "openai-completions",
            apiKey: "$SCOPEGUARD_PI_FAKE_KEY",
            authHeader: true,
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
            models: [
              {
                id: "qualification-model",
                name: "ScopeGuard Qualification Model",
                reasoning: false,
                input: ["text"],
                contextWindow: 16_384,
                maxTokens: 1_024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(configDir, "settings.json"),
    `${JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1_000 } }, null, 2)}\n`,
  );
  const env = cleanEnvironment(configDir);

  const version = (
    await execFileAsync(process.execPath, [cliPath, "--version"], { env })
  ).stdout.trim();
  assert.equal(version, contract.version);

  async function scenarioProcessLifecycle() {
    const ready = await startClient(
      "ready",
      env,
      workspace,
      path.join(sessions, "ready"),
    );
    const initialReadySessionId = ready.state.sessionId;
    const versionProbe = await ready.client.send({
      type: "get_protocol_version",
    });
    assert.equal(versionProbe.success, false);
    assert.match(versionProbe.error, /Unknown command/);
    const createdSession = assertSuccess(
      await ready.client.send({ type: "new_session" }),
      "new_session",
    );
    assert.equal(createdSession.cancelled, false);
    const createdState = assertSuccess(
      await ready.client.send({ type: "get_state" }),
      "get_state",
    );
    assert.notEqual(createdState.sessionId, initialReadySessionId);
    const readyExit = await closeClient(ready.client);
    assert.deepEqual(
      { code: readyExit.code, signal: readyExit.signal },
      { code: 0, signal: null },
    );
    record(
      "process-ready-shutdown",
      Classification.LOSSY,
      `CLI ${version}; readiness is get_state because RPC has no handshake/version command; stdin EOF exits 0`,
    );
    record(
      "session-create",
      Classification.EXACT,
      "new_session returned cancelled=false and get_state exposed a new sessionId",
    );

    const terminated = await startClient(
      "terminated",
      env,
      workspace,
      path.join(sessions, "terminated"),
    );
    const terminatedExit = await terminated.client.kill("SIGTERM");
    clients.delete(terminated.client);
    assert.equal(terminatedExit.code, 143);
    assert.equal(terminatedExit.signal, null);
    record(
      "host-termination",
      Classification.LOSSY,
      "Pi handles SIGTERM as numeric exit 143 without a shutdown acknowledgement",
    );

    const crash = await startClient(
      "crash",
      env,
      workspace,
      path.join(sessions, "crash"),
    );
    const crashExit = await crash.client.kill("SIGKILL");
    clients.delete(crash.client);
    assert.equal(crashExit.code, null);
    assert.equal(crashExit.signal, "SIGKILL");
    record(
      "unexpected-crash",
      Classification.EXACT,
      "transport distinguishes SIGKILL from normal exit and retains sanitized stderr",
    );
  }
  await scenarioProcessLifecycle();

  async function scenarioStreamingAndToolMapping() {
    const stream = await startClient(
      "stream",
      env,
      workspace,
      path.join(sessions, "stream"),
    );
    const streamRecords = await runPrompt(
      stream.client,
      "[stream] hello\u2028world",
    );
    const streamKeys = streamRecords
      .filter((item) => item.type !== "response")
      .map(eventKey);
    assertSubsequence(streamKeys, contract.knownTextOrder);
    const streamedText = streamRecords
      .filter(
        (item) =>
          item.type === "message_update" &&
          item.assistantMessageEvent?.type === "text_delta",
      )
      .map((item) => item.assistantMessageEvent.delta)
      .join("");
    assert.equal(streamedText, "echo:[stream] hello\u2028world");
    await closeClient(stream.client);
    record(
      "streaming-text-order",
      Classification.EXACT,
      "strict LF JSONL preserved U+2028 and ordered start/delta/end/settled events",
    );

    for (const scenario of [
      { label: "tool-success", prompt: "[tool-success]", expectedError: false },
      { label: "tool-error", prompt: "[tool-error]", expectedError: true },
    ]) {
      const started = await startClient(
        scenario.label,
        env,
        workspace,
        path.join(sessions, scenario.label),
      );
      const providerRequestMark = provider.requests.length;
      const toolRecords = await runPrompt(started.client, scenario.prompt);
      assertSubsequence(toolRecords.map(eventKey), contract.knownToolCallOrder);
      const toolStart = toolRecords.find(
        (item) => item.type === "tool_execution_start",
      );
      const toolEnd = toolRecords.find(
        (item) => item.type === "tool_execution_end",
      );
      const toolCall = authoritativeToolCall(toolRecords);
      assert.ok(toolStart);
      assert.ok(toolEnd);
      assert.equal(toolCall.id, toolStart.toolCallId);
      assert.equal(toolCall.name, toolStart.toolName);
      assert.deepEqual(toolCall.arguments, toolStart.args);
      assert.equal(toolEnd.toolCallId, toolStart.toolCallId);
      assert.equal(toolEnd.isError, scenario.expectedError);
      assert.ok(Array.isArray(toolEnd.result?.content));
      const resultText = contentText(toolEnd.result.content);
      assert.match(
        resultText,
        scenario.expectedError
          ? /definitely-missing|ENOENT|not found/i
          : /tool-ok/,
      );
      const entries = assertSuccess(
        await started.client.send({ type: "get_entries" }),
        "get_entries",
      ).entries;
      const persisted = persistedToolResult(entries, toolStart.toolCallId);
      assert.equal(persisted.toolName, toolStart.toolName);
      assert.equal(persisted.isError, scenario.expectedError);
      assert.deepEqual(persisted.content, toolEnd.result.content);
      assert.equal(
        Object.hasOwn(persisted, "details"),
        Object.hasOwn(toolEnd.result, "details"),
      );
      assert.deepEqual(persisted.details, toolEnd.result.details);
      assert.match(
        contentText(persisted.content),
        scenario.expectedError
          ? /definitely-missing|ENOENT|not found/i
          : /tool-ok/,
      );
      assert.ok(
        provider.requests
          .slice(providerRequestMark)
          .some((request) => request.toolMessageCount > 0),
      );
      await closeClient(started.client);
      record(
        scenario.label,
        Classification.EXACT,
        `${toolStart.toolName} correlated by ${toolStart.toolCallId}; result isError=${toolEnd.isError}`,
      );
    }
  }
  await scenarioStreamingAndToolMapping();

  async function scenarioExtensionApprovalBridge() {
    const approved = await approvalCase({
      env,
      workspace,
      sessions,
      scenario: "approve",
      response: { confirmed: true },
    });
    const rejected = await approvalCase({
      env,
      workspace,
      sessions,
      scenario: "reject",
      response: { confirmed: false },
    });
    const cancelled = await approvalCase({
      env,
      workspace,
      sessions,
      scenario: "cancel",
      response: { cancelled: true },
    });
    const timedOut = await approvalCase({
      env,
      workspace,
      sessions,
      scenario: "timeout",
    });
    assert.equal(
      new Set([
        approved.requestId,
        rejected.requestId,
        cancelled.requestId,
        timedOut.requestId,
      ]).size,
      4,
    );
    record(
      "extension-approval-policy",
      Classification.EXACT,
      "pre-execution confirm approved one effect; reject, cancel, and timeout blocked with persisted correlated results",
    );

    const concurrentApprovals = await Promise.all([
      approvalCase({
        env,
        workspace,
        sessions,
        scenario: "concurrent-approve",
        response: { confirmed: true },
      }),
      approvalCase({
        env,
        workspace,
        sessions,
        scenario: "concurrent-reject",
        response: { confirmed: false },
      }),
    ]);
    assert.notEqual(
      concurrentApprovals[0].requestId,
      concurrentApprovals[1].requestId,
    );
    assert.equal(
      existsSync(path.join(workspace, "approval-concurrent-approve.txt")),
      true,
    );
    assert.equal(
      existsSync(path.join(workspace, "approval-concurrent-reject.txt")),
      false,
    );
    record(
      "multi-process-approval-correlation",
      Classification.EXACT,
      "two RPC processes used distinct request IDs; approve/reject responses affected only their owning Conversation",
    );

    const extensionError = await startClient(
      "approval-extension-error",
      env,
      workspace,
      path.join(sessions, "approval-extension-error"),
    );
    const extensionErrorRecords = await runPrompt(
      extensionError.client,
      "[approval:extension-error]",
    );
    assert.equal(
      existsSync(path.join(workspace, "approval-extension-error.txt")),
      false,
    );
    const extensionErrorEnd = extensionErrorRecords.find(
      (item) =>
        item.type === "tool_execution_end" &&
        item.toolCallId === "call-approval-extension-error",
    );
    assert.ok(extensionErrorEnd);
    assert.equal(extensionErrorEnd.isError, true);
    assert.match(
      contentText(extensionErrorEnd.result.content),
      /SCOPEGUARD_EXTENSION_ERROR/,
    );
    const extensionErrorEntries = assertSuccess(
      await extensionError.client.send({ type: "get_entries" }),
      "get_entries",
    ).entries;
    const persistedExtensionError = persistedToolResult(
      extensionErrorEntries,
      "call-approval-extension-error",
    );
    assert.equal(persistedExtensionError.isError, true);
    assert.match(
      contentText(persistedExtensionError.content),
      /SCOPEGUARD_EXTENSION_ERROR/,
    );
    await closeClient(extensionError.client);
    record(
      "extension-error-fail-closed",
      Classification.EXACT,
      "a thrown tool_call extension error produced a persisted error result and no side effect",
    );

    const disconnected = await startClient(
      "approval-host-disconnect",
      env,
      workspace,
      path.join(sessions, "approval-host-disconnect"),
    );
    const disconnectedMark = disconnected.client.mark();
    assertSuccess(
      await disconnected.client.send({
        type: "prompt",
        message: "[approval:host-disconnect]",
      }),
      "prompt",
    );
    await disconnected.client.waitFor(
      (item) =>
        item.type === "extension_ui_request" && item.method === "confirm",
      {
        after: disconnectedMark,
        description: "host disconnect approval request",
      },
    );
    const disconnectedExit = await closeClient(disconnected.client);
    assert.equal(disconnectedExit.code, 0);
    assert.equal(
      existsSync(path.join(workspace, "approval-host-disconnect.txt")),
      false,
    );
    record(
      "approval-host-disconnect",
      Classification.EXACT,
      "closing RPC stdin during a pending confirmation exited cleanly without executing the Tool effect",
    );
  }
  await scenarioExtensionApprovalBridge();

  async function scenarioProviderFailure() {
    const providerError = await startClient(
      "provider-error",
      env,
      workspace,
      path.join(sessions, "provider-error"),
    );
    const errorRecords = await runPrompt(
      providerError.client,
      "[http-error]",
      20_000,
    );
    const errorMessage = errorRecords.find(
      (item) =>
        item.type === "message_end" &&
        item.message?.role === "assistant" &&
        item.message?.stopReason === "error",
    );
    assert.ok(
      errorMessage,
      "provider HTTP failure did not become an assistant error message",
    );
    assert.match(
      errorMessage.message.errorMessage ?? "",
      /503|qualification protocol failure/,
    );
    await closeClient(providerError.client);
    record(
      "provider-protocol-error",
      Classification.EXACT,
      "accepted prompt fails through assistant error event and still reaches agent_settled",
    );
  }
  await scenarioProviderFailure();

  async function scenarioSessionResumeAndCompaction() {
    const persisted = await startClient(
      "persist",
      env,
      workspace,
      path.join(sessions, "persist"),
    );
    await runPrompt(persisted.client, "[persist-marker]");
    const persistedState = assertSuccess(
      await persisted.client.send({ type: "get_state" }),
      "get_state",
    );
    assert.ok(persistedState.sessionFile);
    assert.ok(existsSync(persistedState.sessionFile));
    const sessionLocator = persistedState.sessionFile;
    const sessionId = persistedState.sessionId;
    const sessionHeader = JSON.parse(
      (await readFile(sessionLocator, "utf8")).split("\n", 1)[0],
    );
    assert.equal(sessionHeader.version, 3);
    await closeClient(persisted.client);

    const resumed = await startClient(
      "resume",
      env,
      workspace,
      path.join(sessions, "persist"),
      ["--session", sessionLocator],
    );
    const resumedState = assertSuccess(
      await resumed.client.send({ type: "get_state" }),
      "get_state",
    );
    assert.equal(resumedState.sessionId, sessionId);
    await runPrompt(resumed.client, "[resume-check]");
    const resumedText = assertSuccess(
      await resumed.client.send({ type: "get_last_assistant_text" }),
      "get_last_assistant_text",
    ).text;
    assert.equal(resumedText, "resume-ok");
    record(
      "session-resume",
      Classification.EXACT,
      "opaque sessionFile/sessionId and Pi session format v3 survived process exit; prior history reached the provider",
    );

    await runPrompt(resumed.client, "[long-context] one");
    await runPrompt(resumed.client, "[long-context] two");
    const compactMark = resumed.client.mark();
    const compactResponse = await resumed.client.send(
      { type: "compact", customInstructions: "SCOPEGUARD_COMPACT_SUMMARY" },
      20_000,
    );
    const compactResult = assertSuccess(compactResponse, "compact");
    const compactRecords = resumed.client.records.slice(compactMark);
    assert.ok(compactRecords.some((item) => item.type === "compaction_start"));
    const compactionEnd = compactRecords.find(
      (item) => item.type === "compaction_end",
    );
    assert.ok(compactionEnd);
    assert.equal(compactionEnd.aborted, false);
    assert.match(compactResult.summary, /QUALIFICATION_COMPACTION_SUMMARY/);
    const entries = assertSuccess(
      await resumed.client.send({ type: "get_entries" }),
      "get_entries",
    ).entries;
    assert.ok(entries.some((entry) => entry.type === "compaction"));
    await closeClient(resumed.client);

    const compacted = await startClient(
      "post-compaction-resume",
      env,
      workspace,
      path.join(sessions, "persist"),
      ["--session", sessionLocator],
    );
    await runPrompt(compacted.client, "[after-compaction]");
    const afterCompaction = assertSuccess(
      await compacted.client.send({ type: "get_last_assistant_text" }),
      "get_last_assistant_text",
    ).text;
    assert.equal(afterCompaction, "after-compaction-ok");
    await closeClient(compacted.client);
    record(
      "manual-compaction-resume",
      Classification.EXACT,
      "compaction_start/end and Pi compaction entry persisted; process restart by opaque locator continued successfully",
    );
  }
  await scenarioSessionResumeAndCompaction();

  async function scenarioConcurrentInterrupt() {
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        startClient(
          `concurrent-${index}`,
          env,
          workspace,
          path.join(sessions, `concurrent-${index}`),
        ),
      ),
    );
    const ids = new Set(concurrent.map(({ state }) => state.sessionId));
    assert.equal(ids.size, 4);
    const marks = concurrent.map(({ client }) => client.mark());
    await Promise.all([
      concurrent[0].client.send({
        type: "prompt",
        message: "[interrupt-effect]",
      }),
      ...concurrent
        .slice(1)
        .map(({ client }, index) =>
          client.send({
            type: "prompt",
            message: `[slow-text] peer-${index + 1}`,
          }),
        ),
    ]);
    await concurrent[0].client.waitFor(
      (item) => item.type === "tool_execution_start",
      {
        after: marks[0],
        description: "interrupt target tool start",
      },
    );
    const effectPath = path.join(workspace, "effect-marker.txt");
    for (
      let attempt = 0;
      attempt < 50 && !existsSync(effectPath);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      existsSync(effectPath),
      "effect marker was not created before abort",
    );
    assertSuccess(await concurrent[0].client.send({ type: "abort" }), "abort");
    await Promise.all(
      concurrent.map(({ client }, index) =>
        client.waitForSettled(marks[index], 25_000),
      ),
    );
    const effectContent = await readFile(effectPath, "utf8");
    assert.equal(effectContent, "started");
    for (const { client } of concurrent.slice(1)) {
      const peerText = assertSuccess(
        await client.send({ type: "get_last_assistant_text" }),
        "get_last_assistant_text",
      ).text;
      assert.match(peerText, /^slow-complete:/);
    }
    for (const { client } of concurrent) await closeClient(client);
    record(
      "four-session-targeted-abort",
      Classification.EXACT,
      "four session ids stayed independent; only target stopped and three peers settled",
    );
    record(
      "interrupted-tool-effect",
      Classification.LOSSY,
      "Pi reports an aborted run, but the observed partial file effect proves absence/completion cannot be inferred; map to effect_unknown",
    );
  }
  await scenarioConcurrentInterrupt();

  async function scenarioCompatibilityCredentialsAndCleanup() {
    const invalidModel = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "--mode",
        "rpc",
        "--provider",
        "scopeguard-fake",
        "--model",
        "definitely-missing-model",
        "--no-session",
        "--offline",
      ],
      { cwd: workspace, env, timeout: 5_000 },
    ).catch((error) => ({
      error,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }));
    assert.ok(invalidModel.error, "invalid model unexpectedly started");
    assert.match(invalidModel.stderr, /model|resolve|not found/i);
    record(
      "model-configuration-error",
      Classification.EXACT,
      "invalid model exits non-zero with stderr before RPC readiness",
    );

    assert.equal(classifyRpcRecord(contract.syntheticUnknownRecord), "unknown");
    assert.deepEqual(contract.syntheticUnknownRecord.payload, {
      retained: true,
    });
    record(
      "unknown-event-policy",
      Classification.UNSUPPORTED,
      "client preserves an unknown record but cannot assign product semantics without a versioned adapter update",
    );

    assert.ok(provider.requests.length > 0);
    assert.ok(provider.requests.every((request) => request.authOk));
    assert.ok(
      provider.requests.every(
        (request) => request.model === "qualification-model",
      ),
    );
    const files = await filesBelow(tempRoot);
    for (const file of files) {
      const content = await readFile(file).catch(() => Buffer.alloc(0));
      assert.equal(
        content.includes(Buffer.from(SECRET)),
        false,
        `secret persisted in ${file}`,
      );
    }
    record(
      "provider-credential-boundary",
      Classification.LOSSY,
      "env-injected fake key reached only the provider; temp config/session files contained no secret",
    );

    await forcedFailureCleanupScenario();
    record(
      "forced-failure-cleanup",
      Classification.EXACT,
      "invalid JSONL propagated as a sanitized bounded error; child, Provider, profile, Workspace, and Sessions were removed",
    );
  }
  await scenarioCompatibilityCredentialsAndCleanup();

  await provider.close();
  provider = null;
  await rm(tempRoot, { recursive: true, force: true });
  assert.equal(existsSync(tempRoot), false);
  record(
    "temporary-state-cleanup",
    Classification.EXACT,
    "all child processes, provider, profile, workspace, and sessions removed",
  );

  const summary = {
    package: `${packageJson.name}@${packageJson.version}`,
    license: packageJson.license,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    checks: results.length,
    exact: results.filter(
      (item) => item.classification === Classification.EXACT,
    ).length,
    lossy: results.filter(
      (item) => item.classification === Classification.LOSSY,
    ).length,
    unsupported: results.filter(
      (item) => item.classification === Classification.UNSUPPORTED,
    ).length,
    result: "qualification-complete",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`FAIL pi-rpc-qualification: ${error.stack ?? error}\n`);
  for (const client of clients) {
    await client.kill("SIGKILL").catch(() => {});
  }
  if (provider) await provider.close().catch(() => {});
  if (tempRoot)
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});
