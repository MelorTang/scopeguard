import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  ScopeGuardApplication,
  ArtifactWorkflow,
  type ScopeGuardCore,
  type SaveProviderProfileInput,
  type SecretVault,
} from "@scopeguard/application";
import { PiRuntimeSupervisor } from "@scopeguard/pi-runtime";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";
import {
  toDesktopWorkspaceSnapshot,
  toProviderProfileView,
  type AgentHostRequest,
  type AgentHostResponse,
  type AgentHostSecretRequest,
  type AgentHostSecretResponse,
  type AgentHostToMainMessage,
  type MainToAgentHostMessage,
  type ResolveApprovalRequest,
  type UpdateWorkspaceContextRequest,
  parseCaptureWorkspaceFileRequest,
  parseExportArtifactVersionRequest,
  parseId,
  parseSetArtifactCurrentVersionRequest,
  parseWorkspaceCenterStateRequest,
} from "@scopeguard/ipc-contracts";
import type {
  CreateAgentInput,
  CreateConversationInput,
  CreateDispatchInput,
  CreateWorkspaceInput,
  HandoffPromptRequest,
  Id,
  StartRunInput,
  UpdateConversationSettingsInput,
  WorkspaceLayout,
} from "@scopeguard/domain";

class MainProcessSecretVault implements SecretVault {
  readonly #port: Electron.ParentPort;
  readonly #pending = new Map<
    string,
    {
      resolve: (response: AgentHostSecretResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(port: Electron.ParentPort) {
    this.#port = port;
  }

  async put(reference: string, secret: string): Promise<string> {
    const response = await this.#request({
      operation: "put",
      reference,
      secret,
    });
    return response.reference ?? reference;
  }

  async get(reference: string): Promise<string | null> {
    const response = await this.#request({
      operation: "get",
      reference,
    });
    return response.secret ?? null;
  }

  async delete(reference: string): Promise<void> {
    await this.#request({
      operation: "delete",
      reference,
    });
  }

  handleResponse(response: AgentHostSecretResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    if (response.ok) {
      pending.resolve(response);
    } else {
      pending.reject(new Error(response.error ?? "Secret operation failed."));
    }
  }

  #request(
    input: Omit<AgentHostSecretRequest, "type" | "requestId">,
  ): Promise<AgentHostSecretResponse> {
    const requestId = randomUUID();
    const request: AgentHostSecretRequest = {
      type: "host-secret-request",
      requestId,
      ...input,
    };
    const response = new Promise<AgentHostSecretResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(requestId)) {
          return;
        }
        reject(new Error("Secret operation timed out."));
      }, 15_000);
      this.#pending.set(requestId, { resolve, reject, timeout });
    });
    this.#port.postMessage(request satisfies AgentHostToMainMessage);
    return response;
  }
}

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("ScopeGuard agent host must run as an Electron utility process.");
}

const databasePath = process.env.SCOPEGUARD_DB_PATH;
if (!databasePath) {
  throw new Error("SCOPEGUARD_DB_PATH is required.");
}
const piSessionRoot = process.env.SCOPEGUARD_PI_SESSION_ROOT;
if (!piSessionRoot) {
  throw new Error("SCOPEGUARD_PI_SESSION_ROOT is required.");
}
const artifactRoot = process.env.SCOPEGUARD_ARTIFACT_ROOT;
if (!artifactRoot) {
  throw new Error("SCOPEGUARD_ARTIFACT_ROOT is required.");
}

const store = new ScopeGuardStore(databasePath);
const secrets = new MainProcessSecretVault(parentPort);
const runtime = new PiRuntimeSupervisor({
  sessionRoot: piSessionRoot,
  cliPath: process.env.SCOPEGUARD_PI_CLI_PATH,
  assetRoot: process.env.SCOPEGUARD_PI_RUNTIME_ASSET_ROOT,
});
const artifacts = new ArtifactWorkflow({ store, artifactRoot });
await artifacts.initialize();
const application: ScopeGuardCore = new ScopeGuardApplication({
  store,
  secrets,
  runtime,
  artifacts,
  publish: (event) => {
    parentPort.postMessage({
      type: "host-run-event",
      event,
    } satisfies AgentHostToMainMessage);
  },
});
const initialized = application.initialize();

parentPort.on("message", (messageEvent) => {
  const message = messageEvent.data as MainToAgentHostMessage;
  if (message?.type === "host-shutdown") {
    void shutdown();
    return;
  }
  if (message?.type === "host-secret-response") {
    secrets.handleResponse(message);
    return;
  }
  if (message?.type === "host-request") {
    void handleRequest(message);
  }
});

parentPort.postMessage({
  type: "host-ready",
  interruptedRuns: initialized.interruptedRuns,
  interruptedDispatches: initialized.interruptedDispatches,
} satisfies AgentHostToMainMessage);

let shuttingDown = false;
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    const applicationShutdown = application.shutdown();
    await applicationShutdown;
  } finally {
    store.close();
    process.exit(0);
  }
}

async function handleRequest(request: AgentHostRequest): Promise<void> {
  const response: AgentHostResponse = {
    type: "host-response",
    requestId: request.requestId,
    ok: true,
  };
  try {
    response.result = await dispatch(application, request);
  } catch (error) {
    response.ok = false;
    response.error = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort.postMessage(response satisfies AgentHostToMainMessage);
}

async function dispatch(
  core: Pick<ScopeGuardCore, AgentHostRequest["method"]>,
  request: AgentHostRequest,
): Promise<unknown> {
  switch (request.method) {
    case "getWorkspaceSnapshot":
      return toDesktopWorkspaceSnapshot(core.getWorkspaceSnapshot());
    case "createWorkspace":
      return core.createWorkspace(request.payload as CreateWorkspaceInput);
    case "saveProviderProfile":
      return toProviderProfileView(
        await core.saveProviderProfile(
          request.payload as SaveProviderProfileInput,
        ),
      );
    case "deleteProviderProfile":
      return core.deleteProviderProfile(request.payload as Id);
    case "testProviderConnection":
      return core.testProviderConnection(
        request.payload as SaveProviderProfileInput,
      );
    case "createAgent":
      return core.createAgent(
        request.payload as CreateAgentInput,
      );
    case "createConversation":
      return core.createConversation(request.payload as CreateConversationInput);
    case "updateConversationSettings":
      return core.updateConversationSettings(
        request.payload as UpdateConversationSettingsInput,
      );
    case "getWorkspaceLayout":
      return core.getWorkspaceLayout(request.payload as Id);
    case "saveWorkspaceLayout":
      return core.saveWorkspaceLayout(request.payload as WorkspaceLayout);
    case "listConversationMessages":
      return core.listConversationMessages(request.payload as Id);
    case "startRun":
      return core.startRun(request.payload as StartRunInput);
    case "cancelRun":
      return core.cancelRun(request.payload as Id);
    case "resolveApproval": {
      const input = request.payload as ResolveApprovalRequest;
      return core.resolveApproval(input.approvalId, input.decision);
    }
    case "createDispatch":
      return core.createDispatch(request.payload as CreateDispatchInput);
    case "listDispatches":
      return core.listDispatches(request.payload as Id);
    case "executeDispatch":
      return core.executeDispatch(request.payload as Id);
    case "generateHandoffPrompt":
      return core.generateHandoffPrompt(request.payload as HandoffPromptRequest);
    case "getWorkspaceContext":
      return core.getWorkspaceContext(request.payload as Id);
    case "updateWorkspaceContext": {
      const input = request.payload as UpdateWorkspaceContextRequest;
      return core.updateWorkspaceContext(
        input.workspaceId,
        input.content,
        input.sourceConversationId,
        input.sourceRunId,
      );
    }
    case "captureWorkspaceFile":
      return core.captureWorkspaceFile(
        parseCaptureWorkspaceFileRequest(request.payload),
      );
    case "exportArtifactVersion":
      return core.exportArtifactVersion(
        parseExportArtifactVersionRequest(request.payload),
      );
    case "prepareArtifactVersionOpen":
      return core.prepareArtifactVersionOpen(parseId(request.payload, "versionId"));
    case "setArtifactCurrentVersion": {
      const input = parseSetArtifactCurrentVersionRequest(request.payload);
      return core.setArtifactCurrentVersion(input.artifactId, input.versionId);
    }
    case "saveWorkspaceCenterState":
      return core.saveWorkspaceCenterState(
        parseWorkspaceCenterStateRequest(request.payload),
      );
    default:
      return assertNever(request.method);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Agent host method: ${String(value)}`);
}
