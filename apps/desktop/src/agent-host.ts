import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  ScopeGuardApplication,
  type ScopeGuardCore,
  type SaveProviderProfileInput,
  type SecretVault,
} from "@scopeguard/application";
import {
  createProviderAdapter,
} from "@scopeguard/provider-adapters";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";
import {
  ScopeGuardToolRegistry,
} from "@scopeguard/tool-runtime";
import {
  CurrentUserManagedExecutionAdapter,
  ManagedExecutionRouter,
} from "@scopeguard/managed-execution";
import {
  toDesktopWorkspaceSnapshot,
  toProviderProfileView,
  type AgentHostRequest,
  type AgentHostResponse,
  type AgentHostSecretRequest,
  type AgentHostSecretResponse,
  type AgentHostManagedExecutionEvent,
  type AgentHostManagedExecutionResponse,
  type AgentHostToMainMessage,
  type MainToAgentHostMessage,
  type ResolveApprovalRequest,
  type UpdateProjectContextRequest,
} from "@scopeguard/ipc-contracts";
import type {
  CreateAgentProfileInput,
  CreateProjectInput,
  CreateThreadInput,
  CreateWorkspaceInput,
  Id,
  StartRunInput,
  UpdateThreadSettingsInput,
} from "@scopeguard/domain";

import { AgentHostManagedExecutionAdapter } from "./agent-host-managed-execution.js";

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

const store = new ScopeGuardStore(databasePath);
const secrets = new MainProcessSecretVault(parentPort);
const boundedExecution = new AgentHostManagedExecutionAdapter(parentPort);
const tools = new ScopeGuardToolRegistry(
  undefined,
  new ManagedExecutionRouter({
    bounded: boundedExecution,
    fullAccess: new CurrentUserManagedExecutionAdapter(),
  }),
);
const application: ScopeGuardCore = new ScopeGuardApplication({
  store,
  secrets,
  providerFactory: (protocol) => createProviderAdapter({ protocol }),
  tools,
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
  if (message?.type === "host-managed-execution-event") {
    boundedExecution.handleEvent(message as AgentHostManagedExecutionEvent);
    return;
  }
  if (message?.type === "host-managed-execution-response") {
    boundedExecution.handleResponse(message as AgentHostManagedExecutionResponse);
    return;
  }
  if (message?.type === "host-request") {
    void handleRequest(message);
  }
});

parentPort.postMessage({
  type: "host-ready",
  interruptedRuns: initialized.interruptedRuns,
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
    const runtimeShutdown = tools.shutdown();
    await Promise.allSettled([applicationShutdown, runtimeShutdown]);
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
    case "addProject":
      return core.addProject(request.payload as CreateProjectInput);
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
    case "createAgentProfile":
      return core.createAgentProfile(
        request.payload as CreateAgentProfileInput,
      );
    case "createThread":
      return core.createThread(request.payload as CreateThreadInput);
    case "updateThreadSettings":
      return core.updateThreadSettings(
        request.payload as UpdateThreadSettingsInput,
      );
    case "listThreadMessages":
      return core.listThreadMessages(request.payload as Id);
    case "startRun":
      return core.startRun(request.payload as StartRunInput);
    case "cancelRun":
      return core.cancelRun(request.payload as Id);
    case "resolveApproval": {
      const input = request.payload as ResolveApprovalRequest;
      return core.resolveApproval(input.approvalId, input.decision);
    }
    case "getProjectContext":
      return core.getProjectContext(request.payload as Id);
    case "updateProjectContext": {
      const input = request.payload as UpdateProjectContextRequest;
      return core.updateProjectContext(
        input.projectId,
        input.content,
        input.sourceThreadId,
        input.sourceRunId,
      );
    }
    default:
      return assertNever(request.method);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Agent host method: ${String(value)}`);
}
