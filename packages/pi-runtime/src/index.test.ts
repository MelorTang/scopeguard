import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { classifyToolPolicy } from "./approval-policy.js";
import {
  buildExtensionConfirmation,
  PiProtocolError,
  PiRpcProcess,
} from "./rpc-process.js";
import { PiRuntimeSupervisor, type PiApprovalRequest } from "./index.js";

test("Tool policy allows only resolved Workspace reads and requires approval for side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-read-policy-"));
  const file = join(root, "readme.md");
  await writeFile(file, "safe");
  assert.equal(classifyToolPolicy("read", { path: "readme.md" }, root).action, "allow");
  assert.equal(classifyToolPolicy("read", { path: "readme.md" }, root, "ask").action, "approve");
  assert.equal(classifyToolPolicy("read", { path: "readme.md" }, root, "deny").action, "block");
  assert.equal(classifyToolPolicy("read", { path: "../secret" }, root).action, "block");
  assert.equal(classifyToolPolicy("read", { path: "missing.md" }, root).action, "block");
  assert.equal(classifyToolPolicy("bash", { command: "pwd" }, "/workspace").action, "approve");
  assert.equal(classifyToolPolicy("write", { path: "a" }, "/workspace").action, "approve");
  assert.equal(classifyToolPolicy("edit", { path: "a" }, "/workspace").action, "approve");
  assert.equal(classifyToolPolicy("unknown", {}, "/workspace").action, "block");
  await rm(root, { recursive: true, force: true });
});

test("extension response type and request id cannot be supplied by callers", () => {
  const request = { type: "extension_ui_request", method: "confirm", id: "request-1" };
  assert.deepEqual(buildExtensionConfirmation(request, true), {
    confirmed: true,
    type: "extension_ui_response",
    id: "request-1",
  });
  assert.throws(() => buildExtensionConfirmation({ ...request, id: "" }, true), PiProtocolError);
  assert.throws(() => buildExtensionConfirmation({ ...request, method: "input" }, true), PiProtocolError);
});

test("protocol corruption fails closed with bounded redacted diagnostics", async () => {
  const secret = "runtime-secret";
  const rpc = new PiRpcProcess({
    command: process.execPath,
    args: ["-e", `setTimeout(()=>process.stdout.write('not-json ${secret}\\n'),200);setInterval(()=>{},1000)`],
    cwd: process.cwd(),
    env: process.env,
    processId: "protocol-fixture",
    redactions: [secret],
  });
  await rpc.start();
  await assert.rejects(rpc.waitFor(() => true), /Invalid Pi RPC JSONL/);
  assert.doesNotMatch(rpc.stderr, new RegExp(secret));
  await rpc.kill();
});

test("startup crash is explicit and stderr is UTF-8 byte bounded", async () => {
  const rpc = new PiRpcProcess({
    command: process.execPath,
    args: ["-e", "process.stderr.write('密'.repeat(20000));process.exit(7)"],
    cwd: process.cwd(),
    env: process.env,
    processId: "crash-fixture",
  });
  await assert.rejects(rpc.start(), /code=7/);
  assert.ok(Buffer.byteLength(rpc.stderr, "utf8") <= 16_384);
});

test("locator validation rejects missing, corrupt, incompatible, and mismatched Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-runtime-locator-"));
  const conversationId = "conversation-1";
  const sessionDirectory = join(root, conversationId);
  await mkdir(sessionDirectory);
  const runtime = new PiRuntimeSupervisor({ sessionRoot: root });
  const base = {
    sessionFile: join(sessionDirectory, "session.jsonl"),
    sessionId: "session-1",
    piVersion: "0.84.2" as const,
    sessionVersion: 3 as const,
  };
  try {
    assert.throws(() => runtime.validateLocator(conversationId, base), /missing/);
    await writeFile(base.sessionFile, "not-json\n");
    assert.throws(() => runtime.validateLocator(conversationId, base));
    await writeFile(base.sessionFile, `${JSON.stringify({
      type: "session", version: 3, id: "different", timestamp: new Date().toISOString(), cwd: root,
    })}\n`);
    assert.throws(() => runtime.validateLocator(conversationId, base), /does not match/);
    assert.throws(() => runtime.validateLocator(conversationId, { ...base, piVersion: "0.84.1" as "0.84.2" }), /version mismatch/);
    assert.throws(() => runtime.validateLocator(conversationId, { ...base, sessionVersion: 2 as 3 }), /schema version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production extension binds approval to canonical input and blocks rejected effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-runtime-approval-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "readme.md"), "read-only");
  const provider = await startToolProvider("approval-key");
  const runtime = new PiRuntimeSupervisor({ sessionRoot: join(root, "sessions") });
  try {
    const approvals: PiApprovalRequest[] = [];
    const readyLocators: Array<{ sessionId: string }> = [];
    const rejected = await runtime.run({
      conversationId: "approval-reject",
      prompt: "reject-effect",
      workspaceRoot: workspace,
      instructions: "Use the requested tool.",
      provider: {
        protocol: "openai-compatible",
        baseUrl: `${provider.baseUrl}/v1`,
        apiKey: "approval-key",
        model: "approval-model",
      },
      locator: null,
      readPermission: "allow",
      signal: AbortSignal.timeout(20_000),
      onSessionReady: (locator) => { readyLocators.push(locator); },
      onApproval: async (request) => {
        approvals.push(request);
        return false;
      },
    });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, "bash");
    assert.match(approvals[0].canonicalInputSha256, /^[0-9a-f]{64}$/);
    assert.match(String(approvals[0].canonicalInput.command), /rejected-effect\.txt/);
    assert.equal(existsSync(join(workspace, "rejected-effect.txt")), false);
    assert.equal(rejected.effect, "none");
    assert.equal(readyLocators[0]?.sessionId, rejected.locator.sessionId);
    const approved = await runtime.run({
      conversationId: "approval-approve",
      prompt: "approve-effect",
      workspaceRoot: workspace,
      instructions: "Use the requested tool.",
      provider: {
        protocol: "openai-compatible",
        baseUrl: `${provider.baseUrl}/v1`,
        apiKey: "approval-key",
        model: "approval-model",
      },
      locator: null,
      readPermission: "allow",
      signal: AbortSignal.timeout(20_000),
      onApproval: async (request) => {
        approvals.push(request);
        return true;
      },
    });
    assert.equal(approvals.length, 2);
    assert.match(String(approvals[1].canonicalInput.command), /approved-effect\.txt/);
    assert.equal(existsSync(join(workspace, "approved-effect.txt")), true);
    assert.equal(approved.effect, "confirmed");
    const read = await runtime.run({
      conversationId: "approval-read",
      prompt: "read-effect",
      workspaceRoot: workspace,
      instructions: "Use the requested tool.",
      provider: {
        protocol: "openai-compatible",
        baseUrl: `${provider.baseUrl}/v1`,
        apiKey: "approval-key",
        model: "approval-model",
      },
      locator: null,
      readPermission: "ask",
      signal: AbortSignal.timeout(20_000),
      onApproval: async (request) => {
        approvals.push(request);
        return true;
      },
    });
    assert.equal(approvals[2]?.toolName, "read");
    assert.equal(read.effect, "none");
  } finally {
    await runtime.shutdown();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest hash drift blocks readiness before Pi can start", async () => {
  const dist = dirname(fileURLToPath(import.meta.url));
  const extension = join(dist, "approval-extension.js");
  const original = await readFile(extension);
  const root = await mkdtemp(join(tmpdir(), "scopeguard-runtime-manifest-"));
  try {
    await writeFile(extension, Buffer.concat([original, Buffer.from("\n// drift\n")]));
    const runtime = new PiRuntimeSupervisor({ sessionRoot: root });
    await assert.rejects(runtime.run({
      conversationId: "manifest-test",
      prompt: "hello",
      workspaceRoot: null,
      instructions: "help",
      provider: { protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: null, model: "model" },
      locator: null,
      readPermission: "deny",
      signal: AbortSignal.timeout(2_000),
      onApproval: async () => false,
    }), /hash mismatch/);
  } finally {
    await writeFile(extension, original);
    await rm(root, { recursive: true, force: true });
  }
});

async function startToolProvider(expectedKey: string) {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages: Array<{ role: string }>;
    };
    if (request.headers.authorization !== `Bearer ${expectedKey}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (body.messages.at(-1)?.role === "tool") {
      sendChunk(response, { role: "assistant", content: "" });
      sendChunk(response, { content: "blocked effect observed" });
      sendChunk(response, {}, "stop");
      response.end("data: [DONE]\n\n");
      return;
    }
    const serialized = JSON.stringify(body.messages);
    const target = serialized.includes("approve-effect")
      ? "approved-effect.txt"
      : "rejected-effect.txt";
    const command = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('${target}','effect')"`;
    sendChunk(response, { role: "assistant", content: "" });
    sendChunk(response, {
      tool_calls: [{
        index: 0,
        id: "approval-tool-call",
        type: "function",
        function: serialized.includes("read-effect")
          ? { name: "read", arguments: JSON.stringify({ path: "readme.md" }) }
          : { name: "bash", arguments: JSON.stringify({ command }) },
      }],
    });
    sendChunk(response, {}, "tool_calls");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendChunk(
  response: http.ServerResponse,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): void {
  response.write(`data: ${JSON.stringify({
    id: "approval-provider",
    object: "chat.completion.chunk",
    created: 0,
    model: "approval-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}
