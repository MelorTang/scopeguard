import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startFakeProvider } from "../fake-provider.mjs";
import { assertSuccess, filesBelow } from "../qualification/assertions.mjs";
import { Classification } from "../qualification/evidence.mjs";
import { classifyRpcRecord, RpcProcess } from "../rpc-process.mjs";

const execFileAsync = promisify(execFile);

export async function qualifyConcurrentInterrupt(harness) {
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      harness.startClient(`concurrent-${index}`),
    ),
  );
  assert.equal(new Set(concurrent.map(({ state }) => state.sessionId)).size, 4);
  const marks = concurrent.map(({ client }) => client.mark());
  await Promise.all([
    concurrent[0].client.send({
      type: "prompt",
      message: "[interrupt-effect]",
    }),
    ...concurrent.slice(1).map(({ client }, index) =>
      client.send({
        type: "prompt",
        message: `[slow-text] peer-${index + 1}`,
      }),
    ),
  ]);
  const approval = await concurrent[0].client.waitFor(
    (item) => item.type === "extension_ui_request" && item.method === "confirm",
    { after: marks[0], description: "interrupt Tool approval" },
  );
  concurrent[0].client.respondToExtension(approval, { confirmed: true });
  await concurrent[0].client.waitFor(
    (item) => item.type === "tool_execution_start",
    { after: marks[0], description: "interrupt target Tool start" },
  );
  const effectPath = path.join(harness.workspace, "effect-marker.txt");
  for (let attempt = 0; attempt < 50 && !existsSync(effectPath); attempt += 1) {
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
  assert.equal(await readFile(effectPath, "utf8"), "started");
  for (const { client } of concurrent.slice(1)) {
    assert.match(
      assertSuccess(
        await client.send({ type: "get_last_assistant_text" }),
        "get_last_assistant_text",
      ).text,
      /^slow-complete:/,
    );
  }
  for (const { client } of concurrent) await harness.closeClient(client);
  harness.record(
    "four-session-targeted-abort",
    Classification.EXACT,
    "four session ids stayed independent; only target stopped and three peers settled",
  );
  harness.record(
    "interrupted-tool-effect",
    Classification.LOSSY,
    "Pi reports an aborted run, but the partial file effect requires effect_unknown",
  );
}

async function forcedFailureCleanup(harness) {
  const failureSecret = "forced-failure-secret";
  const failureRoot = await mkdtemp(
    path.join(os.tmpdir(), "scopeguard-pi-rpc-forced-failure-"),
  );
  const profile = path.join(failureRoot, "profile");
  const workspace = path.join(failureRoot, "workspace");
  const sessions = path.join(failureRoot, "sessions");
  await Promise.all([mkdir(profile), mkdir(workspace), mkdir(sessions)]);
  const provider = await startFakeProvider({ expectedKey: failureSecret });
  const client = new RpcProcess({
    cwd: workspace,
    env: { ...process.env, SCOPEGUARD_PROTOCOL_FAILURE_SECRET: failureSecret },
    label: "forced-protocol-failure",
    command: process.execPath,
    commandArgs: [harness.protocolFailureFixturePath],
    redactValues: [failureSecret],
    maxStderrBytes: 2_048,
  });

  let observedFailure;
  let childExit;
  try {
    await client.start();
    observedFailure = await client.waitForProtocolFailure();
    throw observedFailure;
  } catch (error) {
    assert.equal(error, observedFailure);
    assert.match(error.message, /invalid JSONL stdout/);
    assert.doesNotMatch(error.message, new RegExp(failureSecret));
  } finally {
    childExit = await client.kill("SIGKILL").catch(() => client.exit);
    await provider.close();
    await rm(failureRoot, { recursive: true, force: true });
  }

  assert.ok(observedFailure);
  assert.ok(childExit);
  assert.equal(client.stderrTruncated, true);
  assert.ok(Buffer.byteLength(client.stderr, "utf8") <= 2_048);
  assert.equal(client.stderr.includes("\uFFFD"), false);
  assert.doesNotMatch(client.stderr, new RegExp(failureSecret));
  assert.match(client.stderr, /\[TRUNCATED\]/);
  assert.equal(provider.isListening(), false);
  for (const target of [profile, workspace, sessions, failureRoot]) {
    assert.equal(existsSync(target), false);
  }
}

export async function qualifyCompatibilityAndCleanup(harness) {
  const invalidModel = await execFileAsync(
    process.execPath,
    [
      harness.cliPath,
      "--mode",
      "rpc",
      "--provider",
      "scopeguard-fake",
      "--model",
      "definitely-missing-model",
      "--no-session",
      "--offline",
    ],
    { cwd: harness.workspace, env: harness.env, timeout: 5_000 },
  ).catch((error) => ({
    error,
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
  }));
  assert.ok(invalidModel.error, "invalid model unexpectedly started");
  assert.match(invalidModel.stderr, /model|resolve|not found/i);
  harness.record(
    "model-configuration-error",
    Classification.EXACT,
    "invalid model exits non-zero with stderr before RPC readiness",
  );

  assert.equal(
    classifyRpcRecord(harness.contract.syntheticUnknownRecord),
    "unknown",
  );
  assert.deepEqual(harness.contract.syntheticUnknownRecord.payload, {
    retained: true,
  });
  harness.record(
    "unknown-event-policy",
    Classification.UNSUPPORTED,
    "client preserves an unknown record but cannot assign product semantics without a versioned adapter update",
  );

  assert.ok(harness.provider.requests.length > 0);
  assert.ok(harness.provider.requests.every((request) => request.authOk));
  assert.ok(
    harness.provider.requests.every(
      (request) => request.model === "qualification-model",
    ),
  );
  for (const file of await filesBelow(harness.tempRoot)) {
    const content = await readFile(file).catch(() => Buffer.alloc(0));
    assert.equal(
      content.includes(Buffer.from(harness.secret)),
      false,
      `secret persisted in ${file}`,
    );
  }
  harness.record(
    "provider-credential-boundary",
    Classification.LOSSY,
    "env-injected fake key reached only the Provider and not temporary files",
  );

  await forcedFailureCleanup(harness);
  harness.record(
    "forced-failure-cleanup",
    Classification.EXACT,
    "multibyte stderr stayed within the UTF-8 byte cap; protocol failure propagated redacted and all temporary state was removed",
  );
}
