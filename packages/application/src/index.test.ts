import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  AgentTool,
  ModelToolDefinition,
  ProviderAdapter,
  ProviderCredentials,
  ProviderStreamEvent,
  ProviderTurnRequest,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "@scopeguard/agent-runtime";
import type {
  ApprovalDecision,
  RunEvent,
} from "@scopeguard/domain";
import { ScopeGuardStore } from "@scopeguard/storage-sqlite";
import {
  HttpRemoteRuntimeClient,
  RemoteRuntimeRequestError,
  RemoteRuntimeService,
  type RemoteRunRecord,
  type RemoteRunSubmission,
} from "@scopeguard/remote-runtime";

import {
  type CliAgentRunner,
  type RemoteRuntimeClientFactory,
  ScopeGuardApplication,
  type SecretVault,
} from "./index.js";

test("stores provider secrets outside SQLite and reuses them for connection tests", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    const profile = await fixture.application.saveProviderProfile({
      name: "Company relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1/",
      defaultModel: "test-model",
      apiKey: "sk-secret-value",
    });

    assert.match(profile.apiKeyRef ?? "", new RegExp(`^provider:${profile.id}:`));
    assert.equal("apiKey" in profile, false);
    assert.equal(
      await fixture.vault.get(profile.apiKeyRef ?? ""),
      "sk-secret-value",
    );

    await fixture.application.testProviderConnection({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      defaultModel: profile.defaultModel,
    });
    assert.equal(fixture.provider.testedCredentials?.apiKey, "sk-secret-value");

    const cleared = await fixture.application.saveProviderProfile({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      defaultModel: profile.defaultModel,
      clearApiKey: true,
    });
    assert.equal(cleared.apiKeyRef, null);
    assert.equal(
      [...fixture.vault.values.values()].includes("sk-secret-value"),
      false,
    );
  } finally {
    fixture.store.close();
  }
});

test("enforces first-stage Workspace boundaries and keeps Runtime credentials out of snapshots", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    const first = fixture.application.createWorkspace({ name: "Operations" });
    const second = fixture.application.createWorkspace({ name: "Private" });
    const remote = await fixture.application.saveRuntimeNode({
      name: "Always-on host",
      kind: "remote",
      baseUrl: "https://runtime.example.com/api/",
      credential: "runtime-secret",
    });
    assert.equal(remote.baseUrl, "https://runtime.example.com/api");
    assert.equal(remote.hasCredential, true);
    const runtimeReference = fixture.store.getRuntimeCredentialRef(remote.id);
    assert.match(runtimeReference ?? "", new RegExp(`^runtime:${remote.id}:`));
    assert.equal(await fixture.vault.get(runtimeReference ?? ""), "runtime-secret");
    assert.equal(
      JSON.stringify(fixture.application.getWorkspaceSnapshot()).includes(
        "runtime-secret",
      ),
      false,
    );

    const researcher = fixture.application.createAgentDefinition({
      name: "Researcher",
      instructions: "Collect primary sources.",
    });
    const reviewer = fixture.application.createAgentDefinition({
      name: "Reviewer",
      instructions: "Verify every claim.",
    });
    const researcherInstance = fixture.application.createAgentInstance({
      workspaceId: first.id,
      agentDefinitionId: researcher.id,
      runtimeNodeId: remote.id,
    });
    const reviewerInstance = fixture.application.createAgentInstance({
      workspaceId: first.id,
      agentDefinitionId: reviewer.id,
      runtimeNodeId: remote.id,
    });
    const privateInstance = fixture.application.createAgentInstance({
      workspaceId: second.id,
      agentDefinitionId: reviewer.id,
      runtimeNodeId: remote.id,
    });
    const task = fixture.application.createTask({
      workspaceId: first.id,
      title: "Prepare an evidence brief",
    });
    const assignment = fixture.application.assignAgentToTask({
      taskId: task.id,
      agentInstanceId: researcherInstance.id,
      role: "research",
    });
    assert.throws(
      () => fixture.application.assignAgentToTask({
        taskId: task.id,
        agentInstanceId: privateInstance.id,
      }),
      /same Workspace/,
    );
    const artifact = fixture.application.createArtifact({
      workspaceId: first.id,
      taskId: task.id,
      assignmentId: assignment.id,
      agentInstanceId: researcherInstance.id,
      kind: "markdown",
      title: "Evidence",
      mimeType: "text/markdown",
      content: "# Evidence\n\nVerified source notes.",
    });
    const context = fixture.application.publishWorkspaceContext({
      workspaceId: first.id,
      scope: "task",
      taskId: task.id,
      title: "Approved evidence",
      content: "Use only the verified source notes.",
      sourceAgentInstanceId: researcherInstance.id,
      sourceArtifactId: artifact.id,
      publishedBy: "agent",
    });
    const handoff = fixture.application.createHandoff({
      workspaceId: first.id,
      taskId: task.id,
      fromAgentInstanceId: researcherInstance.id,
      toAgentInstanceId: reviewerInstance.id,
      contextRevisionId: context.id,
      summary: "Review the approved evidence.",
    });
    assert.equal(handoff.contextRevisionId, context.id);
    assert.throws(
      () => fixture.application.createHandoff({
        workspaceId: first.id,
        taskId: task.id,
        fromAgentInstanceId: researcherInstance.id,
        toAgentInstanceId: privateInstance.id,
        contextRevisionId: context.id,
        summary: "Invalid cross-workspace handoff.",
      }),
      /one Workspace/,
    );
  } finally {
    fixture.store.close();
  }
});

test("runs an API Agent without a local folder and exposes no file or command tools", async () => {
  const provider = new RecordingProvider();
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([new CountingTool()]),
  );
  try {
    const workspace = fixture.application.createWorkspace({
      name: "Knowledge workspace",
    });
    const providerProfile = await fixture.application.saveProviderProfile({
      name: "Direct model",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "general-model",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: workspace.id,
      name: "Researcher",
      instructions: "Prepare a concise evidence brief.",
      providerProfileId: providerProfile.id,
      toolPolicy: {
        readFiles: "allow",
        writeFiles: "allow",
        runCommands: "allow",
      },
    });
    const thread = fixture.application.createThread({
      projectId: workspace.id,
      agentProfileId: agent.id,
      title: "Evidence brief",
    });

    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Summarize the approved evidence.",
    });
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.configSnapshot.toolPolicy, {
      readFiles: "deny",
      writeFiles: "deny",
      runCommands: "deny",
    });
    assert.deepEqual(
      provider.request?.tools.map((tool) => tool.name),
      ["request_user_input"],
    );
    assert.equal(
      JSON.stringify(provider.request?.messages).includes("scopeguard://workspace"),
      false,
    );
    assert.equal(
      fixture.store.listArtifacts(workspace.id).some(
        (artifact) => artifact.runId === run.id,
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("completes an isolated three-Agent research, review, and writing workflow", async () => {
  const provider = new RecordingProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = fixture.application.createWorkspace({ name: "Briefing room" });
    const providerProfile = await fixture.application.saveProviderProfile({
      name: "Direct model",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "general-model",
    });
    const researcher = fixture.application.createAgentProfile({
      projectId: workspace.id,
      name: "Researcher",
      instructions: "Collect evidence.",
      providerProfileId: providerProfile.id,
    });
    const reviewer = fixture.application.createAgentProfile({
      projectId: workspace.id,
      name: "Reviewer",
      instructions: "Verify approved evidence only.",
      providerProfileId: providerProfile.id,
    });
    const writer = fixture.application.createAgentProfile({
      projectId: workspace.id,
      name: "Writer",
      instructions: "Write from verified context only.",
      providerProfileId: providerProfile.id,
    });
    const researchThread = fixture.application.createThread({
      projectId: workspace.id,
      agentProfileId: researcher.id,
      title: "Research",
    });
    const reviewThread = fixture.application.createThread({
      projectId: workspace.id,
      agentProfileId: reviewer.id,
      title: "Review",
    });
    const writingThread = fixture.application.createThread({
      projectId: workspace.id,
      agentProfileId: writer.id,
      title: "Final brief",
    });
    const researcherInstance = fixture.store.listAgentInstances(workspace.id).find(
      (instance) => instance.agentDefinitionId === researcher.id,
    );
    const reviewerInstance = fixture.store.listAgentInstances(workspace.id).find(
      (instance) => instance.agentDefinitionId === reviewer.id,
    );
    const writerInstance = fixture.store.listAgentInstances(workspace.id).find(
      (instance) => instance.agentDefinitionId === writer.id,
    );
    assert.ok(researcherInstance);
    assert.ok(reviewerInstance);
    assert.ok(writerInstance);

    const sourceRun = await fixture.application.startRun({
      threadId: researchThread.id,
      prompt: "PRIVATE_RESEARCH_TRANSCRIPT",
    });
    await fixture.application.waitForRun(sourceRun.id);
    const beforePublish = await fixture.application.startRun({
      threadId: reviewThread.id,
      prompt: "Review before sharing",
    });
    await fixture.application.waitForRun(beforePublish.id);
    assert.equal(
      JSON.stringify(provider.requests.at(-1)?.messages).includes(
        "PRIVATE_RESEARCH_TRANSCRIPT",
      ),
      false,
    );

    const artifact = fixture.store.listArtifacts(workspace.id).find(
      (item) => item.runId === sourceRun.id,
    );
    assert.ok(artifact);
    const context = fixture.application.publishWorkspaceContext({
      workspaceId: workspace.id,
      title: "Approved evidence",
      content: "APPROVED_SHARED_SUMMARY",
      scope: "workspace",
      sourceThreadId: researchThread.id,
      sourceRunId: sourceRun.id,
      sourceAgentInstanceId: researcherInstance.id,
      sourceArtifactId: artifact.id,
      publishedBy: "user",
    });
    const handoff = fixture.application.createHandoff({
      workspaceId: workspace.id,
      taskId: researchThread.id,
      fromAgentInstanceId: researcherInstance.id,
      toAgentInstanceId: reviewerInstance.id,
      sourceRunId: sourceRun.id,
      contextRevisionId: context.id,
      summary: "Verify the approved summary.",
    });
    fixture.application.publishWorkspaceContext({
      workspaceId: workspace.id,
      title: "Later unrelated context",
      content: "UNRELATED_LATER_CONTEXT",
      scope: "workspace",
      publishedBy: "user",
    });

    const afterPublish = await fixture.application.startRun({
      threadId: reviewThread.id,
      prompt: "Review the shared summary",
    });
    await fixture.application.waitForRun(afterPublish.id);
    const requestText = JSON.stringify(provider.requests.at(-1)?.messages);
    assert.equal(requestText.includes("APPROVED_SHARED_SUMMARY"), true);
    assert.equal(requestText.includes("UNRELATED_LATER_CONTEXT"), false);
    assert.equal(requestText.includes("PRIVATE_RESEARCH_TRANSCRIPT"), false);
    assert.equal(fixture.store.getRun(afterPublish.id)?.contextRevisionId, context.id);
    assert.equal(
      fixture.store.listHandoffs(workspace.id).find((item) => item.id === handoff.id)
        ?.status,
      "accepted",
    );

    const reviewArtifact = fixture.store.listArtifacts(workspace.id).find(
      (item) => item.runId === afterPublish.id,
    );
    assert.ok(reviewArtifact);
    const verifiedContext = fixture.application.publishWorkspaceContext({
      workspaceId: workspace.id,
      title: "Verified evidence",
      content: "VERIFIED_SHARED_SUMMARY",
      scope: "workspace",
      sourceThreadId: reviewThread.id,
      sourceRunId: afterPublish.id,
      sourceAgentInstanceId: reviewerInstance.id,
      sourceArtifactId: reviewArtifact.id,
      publishedBy: "user",
    });
    const writingHandoff = fixture.application.createHandoff({
      workspaceId: workspace.id,
      taskId: reviewThread.id,
      fromAgentInstanceId: reviewerInstance.id,
      toAgentInstanceId: writerInstance.id,
      sourceRunId: afterPublish.id,
      contextRevisionId: verifiedContext.id,
      summary: "Write the final Markdown brief from verified evidence.",
    });
    const writingRun = await fixture.application.startRun({
      threadId: writingThread.id,
      prompt: "Produce the final Markdown report",
    });
    await fixture.application.waitForRun(writingRun.id);
    const writingRequest = JSON.stringify(provider.requests.at(-1)?.messages);
    assert.equal(writingRequest.includes("VERIFIED_SHARED_SUMMARY"), true);
    assert.equal(writingRequest.includes("PRIVATE_RESEARCH_TRANSCRIPT"), false);
    assert.equal(
      fixture.store.listHandoffs(workspace.id).find(
        (item) => item.id === writingHandoff.id,
      )?.status,
      "accepted",
    );
    const finalArtifact = fixture.store.listArtifacts(workspace.id).find(
      (item) => item.runId === writingRun.id,
    );
    assert.equal(finalArtifact?.kind, "report");
    assert.equal(finalArtifact?.mimeType, "text/markdown");
    assert.equal(finalArtifact?.agentInstanceId, writerInstance.id);
    assert.equal(finalArtifact?.title, "Final brief");
  } finally {
    fixture.store.close();
  }
});

test("runs two Threads concurrently and cancels only the selected Run", async () => {
  const provider = new ControlledProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const secondAgent = fixture.application.createAgentProfile({
      projectId: workspace.project.id,
      name: "Second Agent",
      instructions: "Work independently.",
      providerProfileId: workspace.provider.id,
    });
    const secondThread = fixture.application.createThread({
      projectId: workspace.project.id,
      agentProfileId: secondAgent.id,
      title: "Second Thread",
    });

    const firstRun = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "First task",
    });
    const secondRun = await fixture.application.startRun({
      threadId: secondThread.id,
      prompt: "Second task",
    });
    await provider.waitForStarts(2);
    assert.equal(fixture.store.listActiveRuns().length, 2);

    const cancel = fixture.application.cancelRun(firstRun.id);
    provider.release("Second task");
    await Promise.all([
      cancel,
      fixture.application.waitForRun(secondRun.id),
    ]);

    assert.equal(fixture.store.getRun(firstRun.id)?.status, "cancelled");
    assert.equal(fixture.store.getRun(secondRun.id)?.status, "completed");
    assert.equal(fixture.store.getTask(secondThread.id)?.status, "completed");
    assert.equal(
      fixture.store.listArtifacts(workspace.project.id).some(
        (artifact) => artifact.runId === secondRun.id,
      ),
      true,
    );
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).some(
        (item) => item.runId === secondRun.id && item.kind === "task-completed",
      ),
      true,
    );
    assert.equal(
      messageText(fixture.store.listThreadMessages(workspace.thread.id)).includes(
        "Second task",
      ),
      false,
    );
    assert.equal(
      messageText(fixture.store.listThreadMessages(secondThread.id)).includes(
        "Second task",
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("pauses a Run for user input and resumes the same Run from the conversation", async () => {
  const provider = new InputRequestProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Prepare the report.",
    });
    await waitForCondition(
      () => fixture.store.getRun(run.id)?.status === "waiting-input",
      "Run did not wait for user input.",
    );

    const inputItem = fixture.store.listInboxItems(workspace.project.id).find(
      (item) => item.runId === run.id && item.kind === "input-required",
    );
    assert.equal(inputItem?.summary, "Which reporting period should I use?");
    assert.equal(fixture.store.getTask(workspace.thread.id)?.status, "waiting-input");
    assert.throws(
      () => fixture.application.resolveInboxItem(inputItem?.id ?? "missing"),
      /Reply in the Agent conversation/,
    );

    const resumed = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Use 2026 Q2.",
    });
    assert.equal(resumed.id, run.id);
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).find(
        (item) => item.id === inputItem?.id,
      )?.status,
      "resolved",
    );
    assert.equal(fixture.store.getTask(workspace.thread.id)?.status, "completed");
    assert.equal(
      messageText(fixture.store.listThreadMessages(workspace.thread.id)).includes(
        "Use 2026 Q2.",
      ),
      true,
    );
    assert.equal(provider.requests[1]?.messages.at(-1)?.role, "tool");
    assert.equal(provider.requests[1]?.messages.at(-1)?.content, "Use 2026 Q2.");
  } finally {
    fixture.store.close();
  }
});

test("resolves a stale input request when an interrupted Thread is continued", async () => {
  const provider = new InputRequestProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const firstRun = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Prepare the report.",
    });
    await waitForCondition(
      () => fixture.store.getRun(firstRun.id)?.status === "waiting-input",
      "Run did not wait for user input.",
    );
    const inputItem = fixture.store.listInboxItems(workspace.project.id).find(
      (item) => item.runId === firstRun.id && item.kind === "input-required",
    );

    await fixture.application.shutdown();
    assert.equal(fixture.store.getRun(firstRun.id)?.status, "interrupted");
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).find(
        (item) => item.id === inputItem?.id,
      )?.status,
      "unread",
    );

    const continued = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Use 2026 Q2 and continue.",
    });
    assert.notEqual(continued.id, firstRun.id);
    assert.equal((await fixture.application.waitForRun(continued.id)).status, "completed");
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).find(
        (item) => item.id === inputItem?.id,
      )?.status,
      "resolved",
    );
  } finally {
    fixture.store.close();
  }
});

test("persists a command approval and never executes after denial", async () => {
  const provider = new ToolCallingProvider();
  const command = new CountingTool();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([command]),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Run a command",
    });
    const approval = await waitForEvent(
      events,
      (event): event is Extract<RunEvent, { type: "approval-required" }> =>
        event.type === "approval-required",
    );

    assert.equal(fixture.store.getRun(run.id)?.status, "waiting-approval");
    const approvalInbox = fixture.store.listInboxItems(workspace.project.id).find(
      (item) => item.approvalId === approval.approval.id,
    );
    assert.equal(approvalInbox?.kind, "approval");
    await fixture.application.resolveApproval(approval.approval.id, "denied");
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(command.executeCount, 0);
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).find(
        (item) => item.id === approvalInbox?.id,
      )?.status,
      "resolved",
    );
    assert.equal(
      fixture.store.getApproval(approval.approval.id)?.status,
      "denied",
    );
    assert.equal(
      messageText(fixture.store.listThreadMessages(workspace.thread.id)).includes(
        "The user denied this tool call.",
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("registers a successful write_file result as a provenance-rich file Artifact", async () => {
  const provider = new WriteFileProvider();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([new SuccessfulWriteTool()]),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Write the report file.",
    });
    const approval = await waitForEvent(
      events,
      (event): event is Extract<RunEvent, { type: "approval-required" }> =>
        event.type === "approval-required",
    );
    await fixture.application.resolveApproval(approval.approval.id, "approved-once");
    assert.equal((await fixture.application.waitForRun(run.id)).status, "completed");

    const artifact = fixture.store.listArtifacts(workspace.project.id).find(
      (item) => item.runId === run.id && item.kind === "file",
    );
    assert.equal(artifact?.taskId, workspace.thread.id);
    assert.equal(artifact?.agentInstanceId != null, true);
    assert.equal(artifact?.title, "quarterly-report.md");
    assert.equal(artifact?.mimeType, "text/markdown");
    assert.equal(
      artifact?.filePath,
      resolve(
        workspace.project.rootPath,
        "reports",
        "quarterly-report.md",
      ),
    );
  } finally {
    fixture.store.close();
  }
});

test("expires a pending approval when its Run is cancelled", async () => {
  const provider = new ToolCallingProvider();
  const command = new CountingTool();
  const events: RunEvent[] = [];
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry([command]),
    (event) => events.push(event),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Run a command",
    });
    const approvalEvent = await waitForEvent(
      events,
      (event): event is Extract<RunEvent, { type: "approval-required" }> =>
        event.type === "approval-required",
    );

    await fixture.application.cancelRun(run.id);

    assert.equal(fixture.store.getRun(run.id)?.status, "cancelled");
    assert.equal(
      fixture.store.getApproval(approvalEvent.approval.id)?.status,
      "expired",
    );
    assert.equal(
      fixture.store.getToolCall(approvalEvent.toolCall.id)?.status,
      "cancelled",
    );
    assert.equal(fixture.store.listPendingApprovals().length, 0);
    assert.equal(command.executeCount, 0);

    const continued = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Continue after cancellation",
    });
    assert.equal(
      (await fixture.application.waitForRun(continued.id)).status,
      "completed",
    );
    const secondRequest = provider.requests.at(-1);
    const cancelledResult = secondRequest?.messages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "provider-command-1",
    );
    assert.equal(cancelledResult?.role, "tool");
    assert.match(cancelledResult?.content ?? "", /cancelled/i);
  } finally {
    fixture.store.close();
  }
});

test("rejects context provenance from another Project or Thread", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    const first = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: first.thread.id,
      prompt: "Create source material",
    });
    await fixture.application.waitForRun(run.id);

    const secondProject = fixture.application.addProject({
      name: "Other Project",
      rootPath: "/tmp/scopeguard-application-other-project",
    });
    const secondAgent = fixture.application.createAgentProfile({
      projectId: secondProject.id,
      name: "Other Agent",
      instructions: "",
      providerProfileId: first.provider.id,
    });
    const secondThread = fixture.application.createThread({
      projectId: secondProject.id,
      agentProfileId: secondAgent.id,
      title: "Other Thread",
    });

    assert.throws(
      () => fixture.application.updateProjectContext(
        secondProject.id,
        "Cross-project source",
        secondThread.id,
        run.id,
      ),
      /source Run belongs to a different Project/,
    );

    const siblingAgent = fixture.application.createAgentProfile({
      projectId: first.project.id,
      name: "Sibling Agent",
      instructions: "",
      providerProfileId: first.provider.id,
    });
    const siblingThread = fixture.application.createThread({
      projectId: first.project.id,
      agentProfileId: siblingAgent.id,
      title: "Sibling Thread",
    });
    const siblingRun = await fixture.application.startRun({
      threadId: siblingThread.id,
      prompt: "Sibling source material",
    });
    await fixture.application.waitForRun(siblingRun.id);

    assert.throws(
      () => fixture.application.updateProjectContext(
        first.project.id,
        "Mismatched source",
        first.thread.id,
        siblingRun.id,
      ),
      /source Run belongs to a different Thread/,
    );

    const firstArtifact = fixture.store.listArtifacts(first.project.id).find(
      (artifact) => artifact.runId === run.id,
    );
    const firstInstance = fixture.store.listAgentInstances(first.project.id).find(
      (instance) => instance.agentDefinitionId === first.agent.id,
    );
    const siblingInstance = fixture.store.listAgentInstances(first.project.id).find(
      (instance) => instance.agentDefinitionId === siblingAgent.id,
    );
    assert.ok(firstArtifact);
    assert.ok(firstInstance);
    assert.ok(siblingInstance);
    assert.throws(
      () => fixture.application.publishWorkspaceContext({
        workspaceId: first.project.id,
        title: "Forged attribution",
        content: "Invalid",
        sourceThreadId: first.thread.id,
        sourceRunId: run.id,
        sourceAgentInstanceId: siblingInstance.id,
        sourceArtifactId: firstArtifact.id,
        publishedBy: "user",
      }),
      /source Run does not belong to its source Agent/,
    );
    const validContext = fixture.application.publishWorkspaceContext({
      workspaceId: first.project.id,
      title: "Valid attribution",
      content: "Approved",
      sourceThreadId: first.thread.id,
      sourceRunId: run.id,
      sourceAgentInstanceId: firstInstance.id,
      sourceArtifactId: firstArtifact.id,
      publishedBy: "user",
    });
    assert.throws(
      () => fixture.application.createHandoff({
        workspaceId: first.project.id,
        taskId: first.thread.id,
        fromAgentInstanceId: firstInstance.id,
        toAgentInstanceId: siblingInstance.id,
        sourceRunId: siblingRun.id,
        contextRevisionId: validContext.id,
        summary: "Forged source Run",
      }),
      /source Run does not match/,
    );
  } finally {
    fixture.store.close();
  }
});

test("redacts an arbitrary provider API key before persisting a Run error", async () => {
  const events: RunEvent[] = [];
  const provider = new EchoingErrorProvider();
  const fixture = createApplicationFixture(
    provider,
    new FakeRegistry(),
    (event) => events.push(event),
  );
  const secret = "relay-key-without-a-standard-prefix";
  try {
    const savedProvider = await fixture.application.saveProviderProfile({
      name: "Echoing relay",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "test-model",
      apiKey: secret,
    });
    const project = fixture.application.addProject({
      name: "Project",
      rootPath: "/tmp/scopeguard-redaction-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "Agent",
      instructions: "",
      providerProfileId: savedProvider.id,
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "Thread",
    });

    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Trigger provider error",
    });
    const failed = await fixture.application.waitForRun(run.id);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.includes(secret), false);
    assert.match(failed.error ?? "", /REDACTED/);
    assert.equal(JSON.stringify(events).includes(secret), false);
  } finally {
    fixture.store.close();
  }
});

test("rolls back Provider metadata when SecretVault cleanup fails", async () => {
  const vault = new FailingVault();
  const store = new ScopeGuardStore(":memory:");
  const application = new ScopeGuardApplication({
    store,
    secrets: vault,
    providerFactory: () => new ImmediateProvider(),
    tools: new FakeRegistry(),
  });
  application.initialize();
  try {
    const profile = await application.saveProviderProfile({
      name: "Relay",
      protocol: "openai-compatible",
      baseUrl: "https://provider.example.com/v1",
      defaultModel: "model",
      apiKey: "old-key",
    });
    const originalReference = profile.apiKeyRef;
    assert.ok(originalReference);

    vault.failDeleteReference = originalReference;
    await assert.rejects(
      () => application.saveProviderProfile({
        id: profile.id,
        name: profile.name,
        protocol: profile.protocol,
        baseUrl: profile.baseUrl,
        defaultModel: profile.defaultModel,
        apiKey: "new-key",
      }),
      /Injected SecretVault delete failure/,
    );
    assert.equal(
      store.getProviderProfile(profile.id)?.apiKeyRef,
      originalReference,
    );
    assert.equal(await vault.get(originalReference), "old-key");
    assert.equal([...vault.values.values()].includes("new-key"), false);

    await assert.rejects(
      () => application.saveProviderProfile({
        id: profile.id,
        name: profile.name,
        protocol: profile.protocol,
        baseUrl: profile.baseUrl,
        defaultModel: profile.defaultModel,
        clearApiKey: true,
      }),
      /Injected SecretVault delete failure/,
    );
    assert.equal(
      store.getProviderProfile(profile.id)?.apiKeyRef,
      originalReference,
    );
  } finally {
    store.close();
  }
});

test("rejects plaintext custom headers and CLI environment values", async () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    await assert.rejects(
      () => fixture.application.saveProviderProfile({
        name: "Unsafe relay",
        protocol: "openai-compatible",
        baseUrl: "https://provider.example.com/v1",
        defaultModel: "test-model",
        customHeaders: { "X-Secret": "plaintext" },
      }),
      /Custom headers are disabled/,
    );

    const workspace = await createWorkspace(fixture.application);
    assert.throws(
      () => fixture.application.createAgentProfile({
        projectId: workspace.project.id,
        name: "CLI",
        runtimeKind: "local-cli",
        instructions: "",
        cliConfig: {
          command: "agent",
          args: [],
          cwd: null,
          env: { AGENT_TOKEN: "plaintext" },
        },
      }),
      /environment variables are disabled/,
    );
  } finally {
    fixture.store.close();
  }
});

test("runs and persists an optional local CLI Agent without a Provider", async () => {
  const cliRunner = new ImmediateCliRunner();
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    cliRunner,
  );
  try {
    const project = fixture.application.addProject({
      name: "CLI Project",
      rootPath: "/tmp/scopeguard-cli-application-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "Local CLI",
      runtimeKind: "local-cli",
      instructions: "Answer from the local CLI.",
      cliConfig: {
        command: "local-agent",
        args: ["--prompt", "{prompt}"],
        cwd: null,
        env: {},
      },
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
      title: "CLI Thread",
    });

    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Inspect the project",
    });
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.configSnapshot.runtimeKind, "local-cli");
    assert.equal(completed.configSnapshot.providerProfileId, null);
    assert.match(cliRunner.prompt, /Inspect the project/);
    assert.match(
      messageText(fixture.store.listThreadMessages(thread.id)),
      /CLI answer/,
    );
  } finally {
    fixture.store.close();
  }
});

test("rejects a local CLI Agent in a Workspace without a local folder", () => {
  const fixture = createApplicationFixture(new ImmediateProvider());
  try {
    const workspace = fixture.application.createWorkspace({
      name: "No-folder Workspace",
    });

    assert.throws(
      () => fixture.application.createAgentProfile({
        projectId: workspace.id,
        name: "Unavailable CLI",
        runtimeKind: "local-cli",
        instructions: "",
        cliConfig: {
          command: "local-agent",
          args: ["{prompt}"],
          cwd: null,
          env: {},
        },
      }),
      /require a Workspace with a local folder/,
    );
  } finally {
    fixture.store.close();
  }
});

test("marks an unreachable Runtime offline without leaking its credential", async () => {
  let reachable = false;
  const runtimeClientFactory: RemoteRuntimeClientFactory = ({ token }) => ({
    async health() {
      if (!reachable) {
        throw new Error(`Runtime rejected credential ${token}`);
      }
      return {
        service: "scopeguard-runtime",
        protocolVersion: 1,
        status: "online",
        capabilities: {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        },
        serverTime: new Date().toISOString(),
      };
    },
    async submitRun() {
      throw new Error("not used");
    },
    async getRun() {
      throw new Error("not used");
    },
    async cancelRun() {
      throw new Error("not used");
    },
  });
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    runtimeClientFactory,
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remote = await fixture.application.saveRuntimeNode({
      name: "Overseas Runtime",
      kind: "remote",
      baseUrl: "https://runtime.example.com",
      credential: "runtime-top-secret",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id)[0];
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remote.id);

    await assert.rejects(
      () => fixture.application.testRuntimeConnection(remote.id),
      /Runtime rejected credential \[REDACTED\]/,
    );
    assert.equal(fixture.store.getRuntimeNode(remote.id)?.status, "offline");
    const offlineItem = fixture.store.listInboxItems(workspace.project.id).find(
      (item) => item.kind === "runtime-offline",
    );
    assert.equal(offlineItem?.agentInstanceId, instance.id);
    assert.equal(offlineItem?.summary.includes("runtime-top-secret"), false);

    reachable = true;
    const result = await fixture.application.testRuntimeConnection(remote.id);
    assert.equal(result.status, "online");
    assert.equal(fixture.store.getRuntimeNode(remote.id)?.status, "online");
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).find(
        (item) => item.id === offlineItem?.id,
      )?.status,
      "resolved",
    );
  } finally {
    fixture.store.close();
  }
});

test("fails a malformed completed remote Run instead of polling forever", async () => {
  let remoteRun: RemoteRunRecord | null = null;
  const runtimeClientFactory: RemoteRuntimeClientFactory = () => ({
    async health() {
      return {
        service: "scopeguard-runtime",
        protocolVersion: 1,
        status: "online",
        capabilities: {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        },
        serverTime: new Date().toISOString(),
      };
    },
    async submitRun(input) {
      remoteRun = {
        id: "remote-run-without-artifact",
        clientRunId: input.clientRunId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        threadId: input.threadId,
        agentInstanceId: input.agentInstanceId,
        status: "completed",
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        lastSequence: 0,
        artifact: null,
      };
      return remoteRun;
    },
    async getRun() {
      assert.ok(remoteRun);
      return { run: remoteRun, events: [] };
    },
    async cancelRun() {
      assert.ok(remoteRun);
      return remoteRun;
    },
  });
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    runtimeClientFactory,
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remote = await fixture.application.saveRuntimeNode({
      name: "Malformed Runtime",
      kind: "remote",
      baseUrl: "https://runtime.example.com",
      credential: "runtime-token",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id)[0];
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remote.id);

    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Return a report",
    });
    const failed = await fixture.application.waitForRun(run.id);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Remote Runtime completed without an Artifact.");
    assert.equal(fixture.store.getTask(workspace.thread.id)?.status, "failed");
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).some(
        (item) => item.kind === "task-failed" && item.runId === run.id,
      ),
      true,
    );
  } finally {
    fixture.store.close();
  }
});

test("persists partial provider output when a Run fails", async () => {
  const fixture = createApplicationFixture(new PartialErrorProvider());
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Start a partial response",
    });
    const failed = await fixture.application.waitForRun(run.id);
    const partial = fixture.store.listThreadMessages(workspace.thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );

    assert.equal(failed.status, "failed");
    assert.equal(messageText(partial ? [partial] : []), "Partial answer");
  } finally {
    fixture.store.close();
  }
});

test("cancels a local CLI Run and persists its partial output", async () => {
  const cliRunner = new ControlledCliRunner();
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    cliRunner,
  );
  try {
    const project = fixture.application.addProject({
      rootPath: "/tmp/scopeguard-cli-cancel-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "CLI",
      runtimeKind: "local-cli",
      instructions: "",
      cliConfig: {
        command: "local-agent",
        args: [],
        cwd: null,
        env: {},
      },
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Long task",
    });
    await cliRunner.started;

    await fixture.application.cancelRun(run.id);

    assert.equal(fixture.store.getRun(run.id)?.status, "cancelled");
    const partial = fixture.store.listThreadMessages(thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );
    assert.equal(messageText(partial ? [partial] : []), "CLI started\n");
  } finally {
    fixture.store.close();
  }
});

test("interrupts active Runs and persists partial output during shutdown", async () => {
  const cliRunner = new ControlledCliRunner();
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    cliRunner,
  );
  try {
    const project = fixture.application.addProject({
      rootPath: "/tmp/scopeguard-cli-shutdown-test",
    });
    const agent = fixture.application.createAgentProfile({
      projectId: project.id,
      name: "CLI",
      runtimeKind: "local-cli",
      instructions: "",
      cliConfig: {
        command: "local-agent",
        args: [],
        cwd: null,
        env: {},
      },
    });
    const thread = fixture.application.createThread({
      projectId: project.id,
      agentProfileId: agent.id,
    });
    const run = await fixture.application.startRun({
      threadId: thread.id,
      prompt: "Long task",
    });
    await cliRunner.started;

    await fixture.application.shutdown();

    const interrupted = fixture.store.getRun(run.id);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(
      interrupted?.error,
      "The agent host stopped before this run completed.",
    );
    const partial = fixture.store.listThreadMessages(thread.id)
      .find((message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        message.status === "interrupted",
      );
    assert.equal(messageText(partial ? [partial] : []), "CLI started\n");
  } finally {
    fixture.store.close();
  }
});

test("reconciles Task, Assignment, and Inbox state after an unclean restart", async () => {
  const provider = new ControlledProvider();
  const fixture = createApplicationFixture(provider);
  try {
    const workspace = await createWorkspace(fixture.application);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Remain active until restart",
    });
    await provider.waitForStarts(1);
    const assignment = fixture.store.listTaskAssignments().find(
      (item) => item.threadId === workspace.thread.id,
    );
    assert.ok(assignment);
    fixture.store.createInboxItem({
      workspaceId: workspace.project.id,
      kind: "input-required",
      title: "等待补充信息",
      summary: "stale request",
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      runId: run.id,
      approvalId: null,
      agentInstanceId: assignment.agentInstanceId,
    });

    const recovered = new ScopeGuardApplication({
      store: fixture.store,
      secrets: fixture.vault,
      providerFactory: () => fixture.provider,
      tools: new FakeRegistry(),
    });
    assert.equal(recovered.initialize().interruptedRuns, 1);

    assert.equal(fixture.store.getRun(run.id)?.status, "interrupted");
    assert.equal(fixture.store.getTask(assignment.taskId)?.status, "blocked");
    assert.equal(
      fixture.store.listTaskAssignments().find((item) => item.id === assignment.id)
        ?.status,
      "failed",
    );
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).find(
        (item) => item.kind === "input-required" && item.runId === run.id,
      )?.status,
      "resolved",
    );
    assert.equal(
      fixture.store.listInboxItems(workspace.project.id).some(
        (item) => item.kind === "task-failed" && item.runId === run.id,
      ),
      true,
    );

    await fixture.application.shutdown();
  } finally {
    fixture.store.close();
  }
});

test("recovers a remote Run when the submit response is lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-submit-loss-"));
  const remoteService = new RemoteRuntimeService({
    databasePath: join(directory, "runtime.sqlite"),
    token: "runtime-token",
    port: 0,
    providerFactory: () => new ImmediateProvider(),
  });
  const { baseUrl } = await remoteService.start();
  let droppedSubmitResponse = false;
  let submitAttempts = 0;
  let submittedRemoteRunId: string | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && String(input).endsWith("/v1/runs")) {
      submitAttempts += 1;
    }
    const response = await fetch(input, init);
    if (
      !droppedSubmitResponse &&
      init?.method === "POST" &&
      String(input).endsWith("/v1/runs")
    ) {
      const body = JSON.parse(String(init.body)) as { remoteRunId: string };
      submittedRemoteRunId = body.remoteRunId;
      droppedSubmitResponse = true;
      await response.arrayBuffer();
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(
            new TypeError("Simulated body loss after server acceptance."),
          );
        },
      }), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    (input) => new HttpRemoteRuntimeClient({ ...input, fetchImpl }),
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remoteNode = await fixture.application.saveRuntimeNode({
      name: "Response-loss Runtime",
      kind: "remote",
      baseUrl,
      credential: "runtime-token",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id)[0];
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remoteNode.id);

    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Complete exactly once",
    });
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(droppedSubmitResponse, true);
    assert.equal(submitAttempts, 2);
    assert.equal(completed.status, "completed");
    assert.equal(
      fixture.store.getRemoteRunBinding(run.id)?.remoteRunId,
      submittedRemoteRunId,
    );
    assert.equal(
      fixture.store.listArtifacts(workspace.project.id).filter(
        (artifact) => artifact.runId === run.id,
      ).length,
      1,
    );
  } finally {
    await remoteService.close();
    fixture.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stops resubmitting full work when cancellation precedes submit confirmation", async () => {
  let submission: RemoteRunSubmission | null = null;
  let submitAttempts = 0;
  let cancelAttempts = 0;
  let resolveSubmitStarted!: () => void;
  let rejectSubmission!: () => void;
  const submitStarted = new Promise<void>((resolve) => {
    resolveSubmitStarted = resolve;
  });
  const runtimeClientFactory: RemoteRuntimeClientFactory = () => ({
    async health() {
      return {
        service: "scopeguard-runtime",
        protocolVersion: 1,
        status: "online",
        capabilities: {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        },
        serverTime: new Date().toISOString(),
      };
    },
    submitRun(input) {
      submitAttempts += 1;
      submission = input;
      resolveSubmitStarted();
      return new Promise<RemoteRunRecord>((_resolve, reject) => {
        rejectSubmission = () => reject(new RemoteRuntimeRequestError(null));
      });
    },
    async getRun() {
      throw new Error("getRun should not run after cancellation is confirmed.");
    },
    async cancelRun(remoteRunId) {
      cancelAttempts += 1;
      assert.ok(submission);
      return {
        id: remoteRunId,
        clientRunId: submission.clientRunId,
        workspaceId: submission.workspaceId,
        taskId: submission.taskId,
        threadId: submission.threadId,
        agentInstanceId: submission.agentInstanceId,
        status: "cancelled",
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: new Date().toISOString(),
        lastSequence: 0,
        artifact: null,
      };
    },
  });
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    runtimeClientFactory,
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remoteNode = await fixture.application.saveRuntimeNode({
      name: "Delayed submission Runtime",
      kind: "remote",
      baseUrl: "https://runtime.example.com",
      credential: "runtime-token",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id)[0];
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remoteNode.id);

    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Do not resend after cancellation",
    });
    await submitStarted;
    await fixture.application.cancelRun(run.id);
    rejectSubmission();
    const cancelled = await fixture.application.waitForRun(run.id);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(submitAttempts, 1);
    assert.equal(cancelAttempts, 1);
    assert.equal(fixture.store.listActiveRuns().length, 0);
  } finally {
    fixture.store.close();
  }
});

test("allows a remote Run to complete after cancellation loses the race", async () => {
  let remoteRun: RemoteRunRecord | null = null;
  let cancelObserved = false;
  let cancelAttempts = 0;
  const runtimeClientFactory: RemoteRuntimeClientFactory = () => ({
    async health() {
      return {
        service: "scopeguard-runtime",
        protocolVersion: 1,
        status: "online",
        capabilities: {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        },
        serverTime: new Date().toISOString(),
      };
    },
    async submitRun(input) {
      remoteRun = {
        id: input.remoteRunId,
        clientRunId: input.clientRunId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        threadId: input.threadId,
        agentInstanceId: input.agentInstanceId,
        status: "running",
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastSequence: 0,
        artifact: null,
      };
      return remoteRun;
    },
    async getRun() {
      assert.ok(remoteRun);
      if (!cancelObserved) {
        return { run: remoteRun, events: [] };
      }
      const completed: RemoteRunRecord = {
        ...remoteRun,
        status: "completed",
        completedAt: new Date().toISOString(),
        artifact: {
          id: "remote-artifact",
          runId: remoteRun.id,
          title: "Completed report",
          mimeType: "text/markdown",
          content: "The remote work completed before cancellation.",
          version: 1,
          createdAt: new Date().toISOString(),
        },
      };
      remoteRun = completed;
      return { run: completed, events: [] };
    },
    async cancelRun() {
      assert.ok(remoteRun);
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        throw new RemoteRuntimeRequestError(null);
      }
      cancelObserved = true;
      return remoteRun;
    },
  });
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    runtimeClientFactory,
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remoteNode = await fixture.application.saveRuntimeNode({
      name: "Race Runtime",
      kind: "remote",
      baseUrl: "https://runtime.example.com",
      credential: "runtime-token",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id)[0];
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remoteNode.id);
    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Finish near cancellation",
    });
    await waitForCondition(
      () => Boolean(fixture.store.getRemoteRunBinding(run.id)),
      "Remote binding was not created before cancellation.",
    );

    await fixture.application.cancelRun(run.id);
    const completed = await fixture.application.waitForRun(run.id);

    assert.equal(cancelObserved, true);
    assert.equal(cancelAttempts, 2);
    assert.equal(completed.status, "completed");
  } finally {
    fixture.store.close();
  }
});

test("fails a remote Run on a terminal poll response instead of blocking its Thread", async () => {
  const runtimeClientFactory: RemoteRuntimeClientFactory = () => ({
    async health() {
      return {
        service: "scopeguard-runtime",
        protocolVersion: 1,
        status: "online",
        capabilities: {
          nativeAgents: true,
          cliAgents: false,
          fileTools: false,
          commandTools: false,
          persistentRuns: true,
        },
        serverTime: new Date().toISOString(),
      };
    },
    async submitRun(input) {
      return {
        id: input.remoteRunId,
        clientRunId: input.clientRunId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        threadId: input.threadId,
        agentInstanceId: input.agentInstanceId,
        status: "running",
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastSequence: 0,
        artifact: null,
      };
    },
    async getRun() {
      throw new RemoteRuntimeRequestError(404);
    },
    async cancelRun() {
      throw new Error("not used");
    },
  });
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    runtimeClientFactory,
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remoteNode = await fixture.application.saveRuntimeNode({
      name: "Missing Run Runtime",
      kind: "remote",
      baseUrl: "https://runtime.example.com",
      credential: "runtime-token",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id)[0];
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remoteNode.id);

    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Find the missing remote Run",
    });
    const failed = await fixture.application.waitForRun(run.id);

    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /HTTP 404/);
    assert.equal(
      fixture.store.listActiveRuns().some((item) => item.threadId === workspace.thread.id),
      false,
    );
  } finally {
    fixture.store.close();
  }
});

test("reconnects a persisted remote Run after the desktop host shuts down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopeguard-app-remote-"));
  const remoteService = new RemoteRuntimeService({
    databasePath: join(directory, "runtime.sqlite"),
    token: "runtime-token",
    port: 0,
    providerFactory: () => new SlowRemoteProvider(),
  });
  const { baseUrl } = await remoteService.start();
  let injectMissingRun = false;
  let injectedMissingPolls = 0;
  const remoteClientFactory: RemoteRuntimeClientFactory = (input) => {
    const client = new HttpRemoteRuntimeClient(input);
    return {
      health: (signal) => client.health(signal),
      submitRun: (submission, signal) => client.submitRun(submission, signal),
      getRun: (remoteRunId, afterSequence, signal) => {
        if (injectMissingRun && injectedMissingPolls === 0) {
          injectedMissingPolls += 1;
          throw new RemoteRuntimeRequestError(404);
        }
        return client.getRun(remoteRunId, afterSequence, signal);
      },
      cancelRun: (remoteRunId, signal) => client.cancelRun(remoteRunId, signal),
    };
  };
  const fixture = createApplicationFixture(
    new ImmediateProvider(),
    new FakeRegistry(),
    undefined,
    undefined,
    remoteClientFactory,
  );
  try {
    const workspace = await createWorkspace(fixture.application);
    const remoteNode = await fixture.application.saveRuntimeNode({
      name: "Remote worker",
      kind: "remote",
      baseUrl,
      credential: "runtime-token",
    });
    const instance = fixture.store.listAgentInstances(workspace.project.id).find(
      (item) => item.agentDefinitionId === workspace.agent.id,
    );
    assert.ok(instance);
    fixture.application.updateAgentInstanceRuntime(instance.id, remoteNode.id);

    const run = await fixture.application.startRun({
      threadId: workspace.thread.id,
      prompt: "Complete this after the desktop closes",
    });
    await waitForCondition(
      () => Boolean(fixture.store.getRemoteRunBinding(run.id)),
      "Remote Run binding was not persisted.",
    );

    await fixture.application.shutdown();
    assert.equal(
      ["preparing", "running"].includes(fixture.store.getRun(run.id)?.status ?? ""),
      true,
      "desktop shutdown must not interrupt a bound remote Run",
    );

    injectMissingRun = true;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const resumedApplication = new ScopeGuardApplication({
      store: fixture.store,
      secrets: fixture.vault,
      providerFactory: () => fixture.provider,
      tools: new FakeRegistry(),
      remoteClientFactory,
    });
    assert.equal(resumedApplication.initialize().interruptedRuns, 0);
    assert.equal(resumedApplication.resumeRemoteRuns(), 1);
    const completed = await resumedApplication.waitForRun(run.id);

    assert.equal(completed.status, "completed");
    assert.equal(injectedMissingPolls, 1);
    assert.match(
      messageText(fixture.store.listThreadMessages(workspace.thread.id)),
      /Remote execution completed/,
    );
    const artifact = fixture.store.listArtifacts(workspace.project.id).find(
      (item) => item.runId === run.id,
    );
    assert.equal(artifact?.kind, "report");
    assert.match(artifact?.content ?? "", /Remote execution completed/);
    assert.ok(fixture.store.getRemoteRunBinding(run.id)?.resultImportedAt);
  } finally {
    await remoteService.close();
    fixture.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class MemoryVault implements SecretVault {
  readonly values = new Map<string, string>();

  async put(reference: string, secret: string): Promise<string> {
    this.values.set(reference, secret);
    return reference;
  }

  async get(reference: string): Promise<string | null> {
    return this.values.get(reference) ?? null;
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

class FailingVault extends MemoryVault {
  failDeleteReference: string | null = null;

  override async delete(reference: string): Promise<void> {
    if (reference === this.failDeleteReference) {
      throw new Error("Injected SecretVault delete failure.");
    }
    await super.delete(reference);
  }
}

class ImmediateProvider implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;
  testedCredentials: ProviderCredentials | null = null;

  async testConnection(credentials: ProviderCredentials) {
    this.testedCredentials = credentials;
    return {
      ok: true,
      latencyMs: 1,
      model: credentials.model,
      message: "ok",
    };
  }

  async *streamTurn(
    _request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", delta: "Done" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class SlowRemoteProvider extends ImmediateProvider {
  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", delta: "Remote execution " };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      request.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(request.signal.reason);
      }, { once: true });
    });
    yield { type: "text-delta", delta: "completed" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class RecordingProvider extends ImmediateProvider {
  request: ProviderTurnRequest | null = null;
  readonly requests: ProviderTurnRequest[] = [];

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.request = request;
    this.requests.push(request);
    yield* super.streamTurn(request);
  }
}

class ControlledProvider extends ImmediateProvider {
  readonly #startedPrompts: string[] = [];
  readonly #waiters: Array<() => void> = [];
  readonly #releases = new Map<string, () => void>();

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const prompt = [...request.messages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
    const gate = new Promise<void>((resolve, reject) => {
      const abort = () => reject(
        request.signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
      request.signal.addEventListener("abort", abort, { once: true });
      this.#releases.set(prompt, () => {
        request.signal.removeEventListener("abort", abort);
        resolve();
      });
      if (request.signal.aborted) {
        abort();
      }
    });
    this.#startedPrompts.push(prompt);
    this.#notifyWaiters();
    yield { type: "text-delta", delta: `Working on ${prompt}` };
    await gate;
    yield { type: "completed", finishReason: "stop" };
  }

  release(prompt: string): void {
    const release = this.#releases.get(prompt);
    if (!release) {
      throw new Error(`Provider prompt has not started: ${prompt}`);
    }
    this.#releases.delete(prompt);
    release();
  }

  async waitForStarts(count: number): Promise<void> {
    if (this.#startedPrompts.length >= count) {
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (this.#startedPrompts.length < count) {
      await this.waitForStarts(count);
    }
  }

  #notifyWaiters(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter();
    }
  }
}

class EchoingErrorProvider extends ImmediateProvider {
  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    throw new Error(`Provider echoed ${request.credentials.apiKey}`);
  }
}

class PartialErrorProvider extends ImmediateProvider {
  override async *streamTurn(): AsyncIterable<ProviderStreamEvent> {
    yield { type: "text-delta", delta: "Partial answer" };
    throw new Error("Provider disconnected.");
  }
}

class ToolCallingProvider extends ImmediateProvider {
  callCount = 0;
  readonly requests: ProviderTurnRequest[] = [];

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        type: "tool-call",
        toolCall: {
          id: "provider-command-1",
          name: "run_command",
          arguments: { command: "echo should-not-run" },
        },
      };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", delta: "The command was denied." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class InputRequestProvider extends ImmediateProvider {
  readonly requests: ProviderTurnRequest[] = [];

  override async *streamTurn(
    request: ProviderTurnRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: "tool-call",
        toolCall: {
          id: "provider-input-1",
          name: "request_user_input",
          arguments: { question: "Which reporting period should I use?" },
        },
      };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", delta: "Report prepared for 2026 Q2." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class WriteFileProvider extends ImmediateProvider {
  callCount = 0;

  override async *streamTurn(): AsyncIterable<ProviderStreamEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        type: "tool-call",
        toolCall: {
          id: "provider-write-1",
          name: "write_file",
          arguments: {
            path: "reports/quarterly-report.md",
            content: "# Quarterly report\n",
          },
        },
      };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", delta: "The report file is ready." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class CountingTool implements AgentTool {
  readonly permission = "runCommands" as const;
  readonly definition: ModelToolDefinition = {
    name: "run_command",
    description: "Run a command",
    inputSchema: { type: "object" },
  };
  executeCount = 0;

  describe(input: Record<string, unknown>): string {
    return `Run command: ${String(input.command ?? "")}`;
  }

  async execute(
    _input: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.executeCount += 1;
    return { output: "executed", isError: false };
  }
}

class SuccessfulWriteTool implements AgentTool {
  readonly permission = "writeFiles" as const;
  readonly definition: ModelToolDefinition = {
    name: "write_file",
    description: "Write a file",
    inputSchema: { type: "object" },
  };

  describe(input: Record<string, unknown>): string {
    return `Write ${String(input.path ?? "")}`;
  }

  async execute(): Promise<ToolExecutionResult> {
    return {
      output: "Wrote 19 bytes to reports/quarterly-report.md.",
      isError: false,
    };
  }
}

class FakeRegistry implements ToolRegistry {
  readonly #tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[] = []) {
    this.#tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  definitions(): ModelToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  get(name: string): AgentTool | null {
    return this.#tools.get(name) ?? null;
  }
}

function createApplicationFixture(
  provider: ImmediateProvider,
  tools: ToolRegistry = new FakeRegistry(),
  publish?: (event: RunEvent) => void,
  cliRunner?: CliAgentRunner,
  remoteClientFactory?: RemoteRuntimeClientFactory,
) {
  const store = new ScopeGuardStore(":memory:");
  const vault = new MemoryVault();
  const application = new ScopeGuardApplication({
    store,
    secrets: vault,
    providerFactory: () => provider,
    tools,
    publish,
    cliRunner,
    remoteClientFactory,
  });
  application.initialize();
  return { application, store, vault, provider };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(timeoutMessage);
}

class ImmediateCliRunner implements CliAgentRunner {
  prompt = "";

  async run(input: Parameters<CliAgentRunner["run"]>[0]) {
    this.prompt = input.prompt;
    input.onOutput({ stream: "stdout", chunk: "CLI answer" });
    return { stdout: "CLI answer", stderr: "" };
  }
}

class ControlledCliRunner implements CliAgentRunner {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  async run(input: Parameters<CliAgentRunner["run"]>[0]) {
    input.onOutput({ stream: "stdout", chunk: "CLI started\n" });
    this.#resolveStarted();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("CLI aborted.");
        Object.assign(error, { code: "CLI_AGENT_ABORTED" });
        reject(error);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) {
        abort();
      }
    });
    return { stdout: "", stderr: "" };
  }
}

async function createWorkspace(application: ScopeGuardApplication) {
  const provider = await application.saveProviderProfile({
    name: "Test provider",
    protocol: "openai-compatible",
    baseUrl: "https://provider.example.com/v1",
    defaultModel: "test-model",
  });
  const project = application.addProject({
    name: "Project",
    rootPath: "/tmp/scopeguard-application-test",
  });
  const agent = application.createAgentProfile({
    projectId: project.id,
    name: "General",
    instructions: "Be concise.",
    providerProfileId: provider.id,
  });
  const thread = application.createThread({
    projectId: project.id,
    agentProfileId: agent.id,
    title: "First Thread",
  });
  return { provider, project, agent, thread };
}

function messageText(messages: ReturnType<ScopeGuardStore["listThreadMessages"]>): string {
  return messages
    .flatMap((message) => message.content)
    .map((block) => block.type === "text"
      ? block.text
      : block.type === "tool-result"
        ? block.output
        : "")
    .join("\n");
}

async function waitForEvent<T extends RunEvent>(
  events: RunEvent[],
  predicate: (event: RunEvent) => event is T,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for application event.");
}
