import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Files,
  FileText,
  Inbox,
  Save,
  Send,
  Share2,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { isDesktopRuntime } from "../bridge.js";
import { formatRunStatus, formatToolName } from "../uiText.js";
import type { WorkspaceController } from "../useWorkspace.js";
import { MarkdownText } from "./MarkdownText.js";

type InspectorTab = "inbox" | "artifacts" | "context" | "activity";

export function Inspector(props: {
  workspace: WorkspaceController;
  onClose: () => void;
}): JSX.Element {
  const { workspace } = props;
  const [tab, setTab] = useState<InspectorTab>("inbox");
  const [draft, setDraft] = useState(workspace.activeContext?.content ?? "");
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const workspaceId = workspace.selectedWorkspace?.id;
    if (!workspaceId) {
      setDraft("");
      setNotice(null);
      return;
    }
    const savedDraft = localStorage.getItem(contextDraftKey(workspaceId));
    setDraft(savedDraft ?? workspace.activeContext?.content ?? "");
    setNotice(null);
  }, [workspace.activeContext?.id, workspace.selectedWorkspace?.id]);

  const publish = async () => {
    setPublishing(true);
    setNotice(null);
    try {
      const revision = await workspace.updateContext(draft);
      if (workspace.selectedWorkspace) {
        localStorage.removeItem(contextDraftKey(workspace.selectedWorkspace.id));
      }
      setDraft(revision.content);
      setNotice(`已发布第 ${revision.version} 版。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <aside className="inspector">
      <header className="inspector-header">
        <div className="inspector-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "inbox"}
            className={tab === "inbox" ? "is-active" : ""}
            onClick={() => setTab("inbox")}
          >
            <Inbox size={15} />
            待办
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "artifacts"}
            className={tab === "artifacts" ? "is-active" : ""}
            onClick={() => setTab("artifacts")}
          >
            <Files size={15} />
            成果
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "context"}
            className={tab === "context" ? "is-active" : ""}
            onClick={() => setTab("context")}
          >
            <FileText size={15} />
            上下文
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "activity"}
            className={tab === "activity" ? "is-active" : ""}
            onClick={() => setTab("activity")}
          >
            <Activity size={15} />
            活动
          </button>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={props.onClose}
          title="关闭侧边面板"
          aria-label="关闭侧边面板"
        >
          <X size={17} />
        </button>
      </header>

      {tab === "inbox" && <InboxPanel workspace={workspace} />}
      {tab === "artifacts" && <ArtifactsPanel workspace={workspace} />}
      {tab === "context" && (
        <div className="inspector-content">
          <section className="inspector-section">
            <div className="section-title-row">
              <div>
                <h3>共享工作区上下文</h3>
                {!workspace.activeContext && <span>尚未发布</span>}
              </div>
              {workspace.activeContext && (
                <span className="revision-badge">
                  第 {workspace.activeContext.version} 版
                </span>
              )}
            </div>
            <textarea
              className="context-editor"
              value={draft}
              maxLength={200_000}
              onChange={(event) => {
                const nextDraft = event.target.value;
                setDraft(nextDraft);
                if (workspace.selectedWorkspace) {
                  localStorage.setItem(
                    contextDraftKey(workspace.selectedWorkspace.id),
                    nextDraft,
                  );
                }
                setNotice(null);
              }}
              placeholder="记录已确认的决策、约束、术语和事实"
              disabled={!workspace.selectedWorkspace}
              aria-label="共享工作区上下文"
            />
            <button
              type="button"
              className="button button--primary button--full"
              disabled={
                !workspace.selectedWorkspace ||
                publishing ||
                draft.trim() === (workspace.activeContext?.content ?? "").trim()
              }
              onClick={() => void publish()}
            >
              <Save size={15} />
              发布新版本
            </button>
            {notice && (
              <div className="context-notice" role="status">
                {notice.startsWith("已发布")
                  ? <Check size={14} />
                  : <CircleAlert size={14} />}
                <span>{notice}</span>
              </div>
            )}
          </section>

          <section className="inspector-section inspector-section--metadata">
            <h3>来源</h3>
            <dl>
              <div>
                <dt>工作区</dt>
                <dd title={workspace.selectedWorkspace?.id}>
                  {provenanceLabel(
                    workspace.selectedWorkspace?.name ?? "无",
                    workspace.selectedWorkspace?.id,
                    workspace.professionalMode,
                  )}
                </dd>
              </div>
              <div>
                <dt>发布时间</dt>
                <dd>
                  {workspace.activeContext
                    ? formatDate(workspace.activeContext.createdAt)
                    : "尚未发布"}
                </dd>
              </div>
              <div>
                <dt>来源对话</dt>
                <dd title={workspace.activeContext?.sourceThreadId ?? undefined}>
                  {provenanceLabel(
                    workspace.snapshot?.threads.find(
                    (thread) =>
                      thread.id === workspace.activeContext?.sourceThreadId,
                    )?.title ?? "手动编辑",
                    workspace.activeContext?.sourceThreadId,
                    workspace.professionalMode,
                  )}
                </dd>
              </div>
              <div>
                <dt>来源 Agent</dt>
                <dd
                  title={workspace.activeContext?.sourceAgentInstanceId ?? undefined}
                >
                  {provenanceLabel(
                    workspace.snapshot?.agentDefinitions.find((definition) => {
                      const instance = workspace.snapshot?.agentInstances.find(
                        (item) =>
                          item.id === workspace.activeContext?.sourceAgentInstanceId,
                      );
                      return definition.id === instance?.agentDefinitionId;
                    })?.name ?? "用户发布",
                    workspace.activeContext?.sourceAgentInstanceId,
                    workspace.professionalMode,
                  )}
                </dd>
              </div>
              <div>
                <dt>来源运行</dt>
                <dd title={workspace.activeContext?.sourceRunId ?? undefined}>
                  {workspace.professionalMode
                    ? workspace.activeContext?.sourceRunId ?? "无"
                    : shortId(workspace.activeContext?.sourceRunId) ?? "无"}
                </dd>
              </div>
              <div>
                <dt>来源成果</dt>
                <dd title={workspace.activeContext?.sourceArtifactId ?? undefined}>
                  {provenanceLabel(
                    workspace.snapshot?.artifacts.find(
                      (artifact) =>
                        artifact.id === workspace.activeContext?.sourceArtifactId,
                    )?.title ?? "无",
                    workspace.activeContext?.sourceArtifactId,
                    workspace.professionalMode,
                  )}
                </dd>
              </div>
            </dl>
          </section>
          <HandoffPanel workspace={workspace} />
        </div>
      )}
      {tab === "activity" && <ActivityPanel workspace={workspace} />}

      <footer className="inspector-footer">
        <div>
          <Settings2 size={15} />
          <span>显示技术信息</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={workspace.professionalMode}
          aria-label="显示技术信息"
          className={`switch ${workspace.professionalMode ? "is-on" : ""}`}
          onClick={() =>
            workspace.setProfessionalMode(!workspace.professionalMode)
          }
        >
          <span />
        </button>
      </footer>
    </aside>
  );
}

function InboxPanel(props: { workspace: WorkspaceController }): JSX.Element {
  const { snapshot } = props.workspace;
  const workspaceId = props.workspace.selectedWorkspace?.id;
  const threads = snapshot?.threads.filter(
    (thread) => thread.projectId === workspaceId,
  ) ?? [];
  const threadIds = new Set(threads.map((thread) => thread.id));
  const runs = [
    ...(snapshot?.activeRuns ?? []),
    ...(snapshot?.recentRuns ?? []),
  ].filter((run) => threadIds.has(run.threadId));
  const runIds = new Set(runs.map((run) => run.id));
  const approvals = snapshot?.pendingApprovals.filter(
    (item) => runIds.has(item.approval.runId),
  ) ?? [];
  const items = snapshot?.inboxItems.filter(
    (item) =>
      item.workspaceId === workspaceId &&
      item.status !== "resolved" &&
      item.kind !== "approval",
  ) ?? [];

  return (
    <div className="inspector-content">
      <section className="inspector-section">
        <div className="section-title-row">
          <div>
            <h3>待处理</h3>
            <span>{approvals.length + items.length} 项</span>
          </div>
        </div>
        <div className="activity-list">
          {approvals.map((item) => {
            const run = runs.find((candidate) => candidate.id === item.approval.runId);
            const thread = threads.find((candidate) => candidate.id === run?.threadId);
            return (
              <button
                type="button"
                className="activity-row activity-row--action"
                key={item.approval.id}
                disabled={!thread}
                onClick={() => {
                  if (thread) {
                    props.workspace.focusApproval(thread.id, item.approval.id);
                  }
                }}
              >
                <span className="activity-state activity-state--approval">
                  <CircleAlert size={14} />
                </span>
                <div>
                  <strong>{formatToolName(item.toolCall.name)}</strong>
                  <span>{thread?.title ?? "未知任务"} · 等待审批</span>
                </div>
              </button>
            );
          })}
          {items.map((item) => {
            const task = snapshot?.tasks.find((candidate) => candidate.id === item.taskId);
            const assignment = snapshot?.assignments.find(
              (candidate) =>
                candidate.id === item.assignmentId ||
                (!item.assignmentId && candidate.taskId === item.taskId),
            );
            const thread = threads.find(
              (candidate) => candidate.id === assignment?.threadId,
            );
            const waitingForInput = item.kind === "input-required" && runs.some(
              (run) => run.id === item.runId && run.status === "waiting-input",
            );
            return (
              <div className="activity-row" key={item.id}>
                <span className={`activity-state activity-state--${item.kind}`}>
                  {item.kind === "task-completed"
                    ? <Check size={14} />
                    : <CircleAlert size={14} />}
                </span>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {task ? `${task.title} · ${item.summary}` : item.summary}
                  </span>
                </div>
                {thread && (
                  <button
                    type="button"
                    className="icon-button icon-button--small"
                    onClick={() => props.workspace.openThread(thread.id)}
                    title={waitingForInput ? "打开任务并回答" : "打开任务"}
                    aria-label={`${item.title}：打开任务`}
                  >
                    <ArrowRight size={14} />
                  </button>
                )}
                {!waitingForInput && (
                  <button
                    type="button"
                    className="icon-button icon-button--small"
                    onClick={() => void props.workspace.resolveInboxItem(item.id)}
                    title="标记为已处理"
                    aria-label={`将${item.title}标记为已处理`}
                  >
                    <Check size={14} />
                  </button>
                )}
              </div>
            );
          })}
          {approvals.length === 0 && items.length === 0 && (
            <div className="activity-empty">
              <Check size={16} />
              <span>没有需要处理的事项</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ArtifactsPanel(props: { workspace: WorkspaceController }): JSX.Element {
  const artifacts = props.workspace.snapshot?.artifacts.filter(
    (artifact) => artifact.workspaceId === props.workspace.selectedWorkspace?.id,
  ) ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = artifacts.find((artifact) => artifact.id === selectedId)
    ?? artifacts[0]
    ?? null;
  const task = props.workspace.snapshot?.tasks.find(
    (item) => item.id === selected?.taskId,
  );
  const instance = props.workspace.snapshot?.agentInstances.find(
    (item) => item.id === selected?.agentInstanceId,
  );
  const agent = props.workspace.snapshot?.agentDefinitions.find(
    (item) => item.id === instance?.agentDefinitionId,
  );

  return (
    <div className="inspector-content">
      <section className="inspector-section">
        <div className="section-title-row">
          <div>
            <h3>成果</h3>
            <span>{artifacts.length} 项</span>
          </div>
        </div>
        <div className="artifact-list">
          {artifacts.map((artifact) => (
            <button
              type="button"
              key={artifact.id}
              className={selected?.id === artifact.id ? "is-selected" : ""}
              onClick={() => setSelectedId(artifact.id)}
            >
              <FileText size={15} />
              <span>
                <strong>{artifact.title}</strong>
                <small>第 {artifact.version} 版 · {formatDate(artifact.createdAt)}</small>
              </span>
            </button>
          ))}
          {artifacts.length === 0 && (
            <div className="activity-empty">
              <Files size={16} />
              <span>暂无成果</span>
            </div>
          )}
        </div>
      </section>
      {selected && (
        <section className="inspector-section artifact-preview">
          <div className="section-title-row">
            <div>
              <h3>{selected.title}</h3>
              <span>{task?.title ?? "任务成果"} · {agent?.name ?? "Agent"}</span>
            </div>
            {selected.content && (
              <button
                type="button"
                className="button button--secondary button--compact"
                disabled={publishingId === selected.id}
                onClick={() => {
                  setPublishingId(selected.id);
                  setNotice(null);
                  void props.workspace.publishArtifactToContext(selected.id)
                    .then((revision) => {
                      setNotice(`已发布为共享上下文第 ${revision.version} 版。`);
                    })
                    .catch((error: unknown) => {
                      setNotice(error instanceof Error ? error.message : String(error));
                    })
                    .finally(() => setPublishingId(null));
                }}
              >
                <Share2 size={14} />
                发布
              </button>
            )}
          </div>
          {notice && <div className="context-notice" role="status">{notice}</div>}
          <dl className="artifact-provenance">
            <div>
              <dt>类型</dt>
              <dd>{selected.kind} · {selected.mimeType}</dd>
            </div>
            <div>
              <dt>来源任务</dt>
              <dd title={selected.taskId}>
                {provenanceLabel(
                  task?.title ?? "未知任务",
                  selected.taskId,
                  props.workspace.professionalMode,
                )}
              </dd>
            </div>
            <div>
              <dt>来源 Agent</dt>
              <dd title={selected.agentInstanceId}>
                {provenanceLabel(
                  agent?.name ?? "未知 Agent",
                  selected.agentInstanceId,
                  props.workspace.professionalMode,
                )}
              </dd>
            </div>
            <div>
              <dt>来源分配</dt>
              <dd title={selected.assignmentId ?? undefined}>
                {props.workspace.professionalMode
                  ? selected.assignmentId ?? "无"
                  : shortId(selected.assignmentId) ?? "无"}
              </dd>
            </div>
            <div>
              <dt>来源运行</dt>
              <dd title={selected.runId ?? undefined}>
                {props.workspace.professionalMode
                  ? selected.runId ?? "手动创建"
                  : shortId(selected.runId) ?? "手动创建"}
              </dd>
            </div>
            <div>
              <dt>生成时间</dt>
              <dd>{formatDate(selected.createdAt)}</dd>
            </div>
            <div>
              <dt>当前版本</dt>
              <dd>第 {selected.version} 版</dd>
            </div>
          </dl>
          {selected.content
            ? <MarkdownText text={selected.content} />
            : <code>{selected.filePath}</code>}
        </section>
      )}
    </div>
  );
}

function HandoffPanel(props: { workspace: WorkspaceController }): JSX.Element {
  const { workspace } = props;
  const snapshot = workspace.snapshot;
  const workspaceId = workspace.selectedWorkspace?.id;
  const context = workspace.activeContext;
  const sourceArtifact = snapshot?.artifacts.find(
    (artifact) => artifact.id === context?.sourceArtifactId,
  );
  const fromAgentInstanceId = context?.sourceAgentInstanceId
    ?? sourceArtifact?.agentInstanceId
    ?? workspace.activeAgentInstance?.id
    ?? null;
  const targets = snapshot?.agentInstances.filter(
    (instance) =>
      instance.workspaceId === workspaceId && instance.id !== fromAgentInstanceId,
  ) ?? [];
  const handoffs = snapshot?.handoffs.filter(
    (handoff) => handoff.workspaceId === workspaceId,
  ) ?? [];
  const [targetId, setTargetId] = useState("");
  const [summary, setSummary] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setTargetId((current) =>
      targets.some((target) => target.id === current)
        ? current
        : targets[0]?.id ?? ""
    );
    setSummary(context?.title ?? "");
    setNotice(null);
  }, [context?.id, targets.map((target) => target.id).join(",")]);

  const send = async () => {
    if (!targetId || !summary.trim()) {
      return;
    }
    setSending(true);
    setNotice(null);
    try {
      await workspace.createHandoff(targetId, summary);
      setNotice("交接已发送。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="inspector-section handoff-section">
      <div className="section-title-row">
        <div>
          <h3>Agent 交接</h3>
          <span>{handoffs.length} 项</span>
        </div>
      </div>
      {context && targets.length > 0 && (
        <div className="handoff-form">
          <label>
            <span>接收 Agent</span>
            <select
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              {targets.map((target) => (
                <option value={target.id} key={target.id}>
                  {agentName(snapshot, target.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>交接摘要</span>
            <textarea
              rows={3}
              maxLength={20_000}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button button--primary button--full"
            disabled={sending || !targetId || !summary.trim()}
            onClick={() => void send()}
          >
            <Send size={14} />
            发送交接
          </button>
          {notice && <div className="context-notice" role="status">{notice}</div>}
        </div>
      )}
      <div className="handoff-list">
        {handoffs.map((handoff) => (
          <div className="handoff-row" key={handoff.id}>
            <div className="handoff-row__agents">
              <strong>{agentName(snapshot, handoff.fromAgentInstanceId)}</strong>
              <ArrowRight size={13} />
              <strong>{agentName(snapshot, handoff.toAgentInstanceId)}</strong>
            </div>
            <span>{handoff.summary}</span>
            <small>{handoff.status === "accepted" ? "已接收" : "等待接收"}</small>
          </div>
        ))}
        {handoffs.length === 0 && (
          <div className="activity-empty">
            <Send size={15} />
            <span>暂无交接</span>
          </div>
        )}
      </div>
    </section>
  );
}

function agentName(
  snapshot: WorkspaceController["snapshot"],
  agentInstanceId: string,
): string {
  const instance = snapshot?.agentInstances.find(
    (item) => item.id === agentInstanceId,
  );
  const definition = snapshot?.agentDefinitions.find(
    (item) => item.id === instance?.agentDefinitionId,
  );
  return instance?.nameOverride ?? definition?.name ?? "Agent";
}

function shortId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function provenanceLabel(
  label: string,
  id: string | null | undefined,
  showTechnical: boolean,
): string {
  return showTechnical && id ? `${label} · ${id}` : label;
}

function ActivityPanel(props: {
  workspace: WorkspaceController;
}): JSX.Element {
  const { snapshot } = props.workspace;
  const workspaceId = props.workspace.selectedWorkspace?.id;
  const projectThreads = snapshot?.threads.filter(
    (thread) => thread.projectId === workspaceId,
  ) ?? [];
  const projectThreadIds = new Set(projectThreads.map((thread) => thread.id));
  const activeRuns = snapshot?.activeRuns.filter(
    (run) => projectThreadIds.has(run.threadId),
  ) ?? [];
  const recentRuns = snapshot?.recentRuns.filter(
    (run) => projectThreadIds.has(run.threadId),
  ) ?? [];
  const projectRunIds = new Set(
    [...activeRuns, ...recentRuns].map((run) => run.id),
  );
  const approvals = snapshot?.pendingApprovals.filter((item) =>
    projectRunIds.has(item.approval.runId)
  ) ?? [];
  const agents = snapshot?.agentInstances.filter(
    (agent) => agent.workspaceId === workspaceId,
  ) ?? [];
  return (
    <div className="inspector-content">
      <section className="inspector-section">
        <div className="section-title-row">
          <div>
            <h3>当前运行</h3>
            <span>{activeRuns.length} 个进行中</span>
          </div>
          <span className={`runtime-badge ${isDesktopRuntime ? "" : "is-preview"}`}>
            {isDesktopRuntime ? "桌面端" : "网页预览"}
          </span>
        </div>
        <div className="activity-list">
          {activeRuns.length === 0 ? (
            <div className="activity-empty">
              <Check size={16} />
              <span>没有正在运行的任务</span>
            </div>
          ) : (
            activeRuns.map((run) => {
              const thread = projectThreads.find(
                (item) => item.id === run.threadId,
              );
              const assignment = snapshot?.assignments.find(
                (item) => item.threadId === thread?.id,
              );
              const task = snapshot?.tasks.find(
                (item) => item.id === assignment?.taskId,
              );
              const instance = snapshot?.agentInstances.find(
                (item) => item.id === assignment?.agentInstanceId,
              );
              const agent = snapshot?.agentDefinitions.find(
                (item) => item.id === instance?.agentDefinitionId,
              );
              return (
                <div className="activity-row" key={run.id}>
                  <span className={`activity-state activity-state--${run.status}`}>
                    <Clock3 size={14} />
                  </span>
                  <div>
                    <strong>{task?.title ?? thread?.title ?? "Agent 运行"}</strong>
                    <span>{agent?.name ?? "Agent"} · {formatRunStatus(run.status)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="inspector-section">
        <div className="section-title-row">
          <div>
            <h3>待审批</h3>
            <span>{approvals.length} 项</span>
          </div>
        </div>
        <div className="activity-list">
          {approvals.length === 0 ? (
            <div className="activity-empty">
              <Check size={16} />
              <span>没有待审批事项</span>
            </div>
          ) : (
            approvals.map((item) => {
              const run = activeRuns.find(
                (candidate) => candidate.id === item.approval.runId,
              ) ?? recentRuns.find(
                (candidate) => candidate.id === item.approval.runId,
              );
              const thread = projectThreads.find(
                (candidate) => candidate.id === run?.threadId,
              );
              return (
              <button
                type="button"
                className="activity-row activity-row--action"
                key={item.approval.id}
                disabled={!thread}
                onClick={() => {
                  if (thread) {
                    props.workspace.focusApproval(
                      thread.id,
                      item.approval.id,
                    );
                  }
                }}
                aria-label={
                  thread
                    ? `打开${thread.title}并审批${formatToolName(item.toolCall.name)}`
                    : `等待审批：${formatToolName(item.toolCall.name)}`
                }
              >
                <span className="activity-state activity-state--approval">
                  <CircleAlert size={14} />
                </span>
                <div>
                  <strong>{formatToolName(item.toolCall.name)}</strong>
                  <span>
                    {thread?.title ?? "未知对话"} · {item.approval.reason}
                  </span>
                </div>
              </button>
              );
            })
          )}
        </div>
      </section>

      <section className="inspector-section">
        <div className="section-title-row">
          <div>
            <h3>Agent</h3>
            <span>已配置 {agents.length} 个</span>
          </div>
        </div>
        <div className="activity-list">
          {agents.map((agent) => (
            <div className="activity-row" key={agent.id}>
              <span className="activity-state">
                <Bot size={14} />
              </span>
              <div>
                <strong>
                  {agent.nameOverride ?? snapshot?.agentDefinitions.find(
                    (item) => item.id === agent.agentDefinitionId,
                  )?.name ?? "Agent"}
                </strong>
                <span>
                  {props.workspace.professionalMode
                    ? snapshot?.runtimeNodes.find(
                        (item) => item.id === agent.runtimeNodeId,
                      )?.name ?? "Runtime"
                    : agent.status === "idle" ? "就绪" : agent.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function contextDraftKey(projectId: string): string {
  return `scopeguard.context-draft.${projectId}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
