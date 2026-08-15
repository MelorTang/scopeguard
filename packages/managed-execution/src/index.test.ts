import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ManagedExecutionRouter,
  ManagedExecutionUnavailableError,
  UnavailableManagedExecutionAdapter,
  WindowsLpacManagedExecutionAdapter,
  type ManagedExecutionAdapter,
  type ManagedExecutionRequest,
  type ManagedExecutionResult,
  type NativeProcessInput,
  type NativeProcessResult,
  type NativeProcessRunner,
} from "./index.js";

const request: ManagedExecutionRequest = {
  executionId: "execution-1",
  projectId: "project-1",
  threadId: "thread-1",
  runId: "run-1",
  workspaceRoot: "C:\\work",
  command: "echo ready",
  timeoutMs: 30_000,
  environment: {},
};

test("routes both bounded profiles through the same adapter", async () => {
  const bounded = new RecordingAdapter("bounded");
  const fullAccess = new RecordingAdapter("full-access");
  const router = new ManagedExecutionRouter({ bounded, fullAccess });

  await router.execute("request-approval", request, context());
  await router.execute("auto-approve", request, context());

  assert.deepEqual(bounded.executions, [request, request]);
  assert.equal(fullAccess.executions.length, 0);
});

test("routes full access only through the ambient adapter", async () => {
  const bounded = new RecordingAdapter("bounded");
  const fullAccess = new RecordingAdapter("full-access");
  const router = new ManagedExecutionRouter({ bounded, fullAccess });

  const result = await router.execute("full-access", request, context());

  assert.equal(result.output, "full-access");
  assert.deepEqual(fullAccess.executions, [request]);
  assert.equal(bounded.executions.length, 0);
});

test("fails closed when bounded execution is unavailable", async () => {
  const router = new ManagedExecutionRouter({
    bounded: new UnavailableManagedExecutionAdapter(),
    fullAccess: new RecordingAdapter("full-access"),
  });

  await assert.rejects(
    router.execute("request-approval", request, context()),
    ManagedExecutionUnavailableError,
  );
});

test("runs and cleans a Windows LPAC lifecycle through the narrow service contract", async () => {
  const fixture = await windowsFixture();
  try {
    const stages: string[] = [];
    const result = await fixture.adapter.execute(fixture.request, {
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (!event.chunk) stages.push(event.stage);
      },
    });

    assert.equal(result.status, "exited");
    assert.equal(result.cleanup, "clean");
    assert.equal(result.output, "sandbox-ready\n");
    assert.deepEqual(stages, [
      "accepted",
      "provisioning",
      "running",
      "cleaning",
      "completed",
    ]);
    assert.deepEqual(fixture.runner.operations, [
      "profile",
      "service:prepare",
      "run",
      "service:cleanup",
      "delete",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("reports unknown effect when Windows cleanup cannot be confirmed", async () => {
  const fixture = await windowsFixture({ failCleanup: true });
  try {
    const result = await fixture.adapter.execute(fixture.request, context());
    assert.equal(result.status, "failed");
    assert.equal(result.cleanup, "failed");
    assert.equal(result.effect, "unknown");
    assert.match(result.error ?? "", /cleanup was not confirmed/);
  } finally {
    await fixture.cleanup();
  }
});

test("recovers a durable Broker Profile intent before accepting new work", async () => {
  const fixture = await windowsFixture();
  const orphanedId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    await writeFile(join(fixture.profileStateDirectory, `${orphanedId}.json`), JSON.stringify({
      schemaVersion: 1,
      executionId: orphanedId,
      profileName: `ScopeGuardExec_${orphanedId}`,
      state: "created",
      updatedAtUtc: new Date().toISOString(),
    }), "utf8");
    const result = await fixture.adapter.execute(fixture.request, context());
    assert.equal(result.status, "exited");
    assert.deepEqual(fixture.runner.operations.slice(0, 3), [
      "service:cleanup",
      "delete",
      "profile",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed on unknown Broker Profile recovery state", async () => {
  const fixture = await windowsFixture();
  try {
    await writeFile(join(fixture.profileStateDirectory, "unexpected.txt"), "unknown", "utf8");
    await assert.rejects(
      fixture.adapter.execute(fixture.request, context()),
      /Unknown Broker Profile intent state/,
    );
    assert.equal(fixture.runner.operations.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

class RecordingAdapter implements ManagedExecutionAdapter {
  readonly executions: ManagedExecutionRequest[] = [];

  constructor(readonly output: string) {}

  async execute(input: ManagedExecutionRequest): Promise<ManagedExecutionResult> {
    this.executions.push(input);
    return {
      executionId: input.executionId,
      status: "exited",
      exitCode: 0,
      output: this.output,
      outputTruncated: false,
      termination: "confirmed",
      cleanup: "clean",
      effect: "confirmed",
    };
  }

  async shutdown(): Promise<void> {}
}

function context() {
  return { signal: new AbortController().signal };
}

async function windowsFixture(options: { failCleanup?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-windows-adapter-"));
  const workspace = join(root, "workspace");
  const serviceClientPath = join(root, "scopeguard-provisioner-service.exe");
  const launcherPath = join(root, "scopeguard-appcontainer.exe");
  const lifetimeBrokerPath = join(root, "scopeguard-lifetime-broker.exe");
  await writeFile(serviceClientPath, "fixture", "utf8");
  await writeFile(launcherPath, "fixture", "utf8");
  await writeFile(lifetimeBrokerPath, "fixture", "utf8");
  await mkdir(workspace, { recursive: true });
  const profileStateDirectory = join(root, "profile-intents");
  await mkdir(profileStateDirectory, { recursive: true });
  const runner = new FakeWindowsRunner(options.failCleanup ?? false);
  const adapter = new WindowsLpacManagedExecutionAdapter({
    installationRoot: root,
    serviceClientPath,
    launcherPath,
    lifetimeBrokerPath,
    pipeName: "ScopeGuardProvisioner",
    diagnosticsDirectory: root,
    profileStateDirectory,
    platform: "win32",
    resolveWorkspaceId: () => "workspace.primary",
  }, runner);
  const managedRequest: ManagedExecutionRequest = {
    ...request,
    executionId: "0123456789abcdef0123456789abcdef",
    workspaceRoot: workspace,
  };
  return {
    adapter,
    request: managedRequest,
    runner,
    profileStateDirectory,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

class FakeWindowsRunner implements NativeProcessRunner {
  readonly operations: string[] = [];

  constructor(readonly failCleanup: boolean) {}

  async run(input: NativeProcessInput): Promise<NativeProcessResult> {
    const operation = input.args[0];
    if (operation === "profile") {
      this.operations.push("profile");
      return nativeResult("S-1-15-2-123\n");
    }
    if (operation === "--parent-pid" && input.args.includes("run")) {
      this.operations.push("run");
      input.onOutput?.("stdout", "sandbox-ready\n");
      return nativeResult("sandbox-ready\n");
    }
    if (operation === "delete") {
      this.operations.push("delete");
      return nativeResult("");
    }
    if (operation === "--client") {
      const payload = JSON.parse(input.stdin ?? "{}") as {
        operation: "prepare" | "cleanup";
        executionId: string;
        workspaceId?: string;
        runtimeId?: string;
      };
      this.operations.push(`service:${payload.operation}`);
      if (payload.operation === "cleanup" && this.failCleanup) {
        return nativeResult(JSON.stringify({
          ok: false,
          error: { message: "ACL cleanup failed" },
        }));
      }
      const result = payload.operation === "prepare"
        ? {
            executionId: payload.executionId,
            workspaceId: payload.workspaceId,
            runtimeId: payload.runtimeId,
            profileName: `ScopeGuardExec_${payload.executionId}`,
            packageSid: "S-1-15-2-123",
            profileCleanupRequired: true,
            runtime: {
              runtimeId: payload.runtimeId,
              executablePath: "C:\\Program Files\\ScopeGuard\\node.exe",
              capabilities: ["registryRead"],
            },
          }
        : { state: "cleaned" };
      return nativeResult(JSON.stringify({ ok: true, result }));
    }
    throw new Error(`Unexpected native operation: ${operation}`);
  }

  async shutdown(): Promise<void> {}
}

function nativeResult(stdout: string): NativeProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    outputTruncated: false,
    cancellation: null,
    terminationConfirmed: true,
  };
}
