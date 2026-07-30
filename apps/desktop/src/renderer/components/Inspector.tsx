import {
  Activity,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  Save,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { isDesktopRuntime } from "../bridge.js";
import type { WorkspaceController } from "../useWorkspace.js";

type InspectorTab = "context" | "activity";

export function Inspector(props: {
  workspace: WorkspaceController;
  onClose: () => void;
}): JSX.Element {
  const { workspace } = props;
  const [tab, setTab] = useState<InspectorTab>("context");
  const [draft, setDraft] = useState(workspace.activeContext?.content ?? "");
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const projectId = workspace.selectedProject?.id;
    if (!projectId) {
      setDraft("");
      setNotice(null);
      return;
    }
    const savedDraft = localStorage.getItem(contextDraftKey(projectId));
    setDraft(savedDraft ?? workspace.activeContext?.content ?? "");
    setNotice(null);
  }, [workspace.activeContext?.id, workspace.selectedProject?.id]);

  const publish = async () => {
    setPublishing(true);
    setNotice(null);
    try {
      const revision = await workspace.updateContext(draft);
      if (workspace.selectedProject) {
        localStorage.removeItem(contextDraftKey(workspace.selectedProject.id));
      }
      setDraft(revision.content);
      setNotice(`Published revision ${revision.version}.`);
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
            aria-selected={tab === "context"}
            className={tab === "context" ? "is-active" : ""}
            onClick={() => setTab("context")}
          >
            <FileText size={15} />
            Context
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "activity"}
            className={tab === "activity" ? "is-active" : ""}
            onClick={() => setTab("activity")}
          >
            <Activity size={15} />
            Activity
          </button>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={props.onClose}
          title="Close inspector"
          aria-label="Close inspector"
        >
          <X size={17} />
        </button>
      </header>

      {tab === "context" ? (
        <div className="inspector-content">
          <section className="inspector-section">
            <div className="section-title-row">
              <div>
                <h3>Shared project context</h3>
                <span>
                  {workspace.activeContext
                    ? `Revision ${workspace.activeContext.version}`
                    : "No published revision"}
                </span>
              </div>
              {workspace.activeContext && (
                <span className="revision-badge">
                  v{workspace.activeContext.version}
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
                if (workspace.selectedProject) {
                  localStorage.setItem(
                    contextDraftKey(workspace.selectedProject.id),
                    nextDraft,
                  );
                }
                setNotice(null);
              }}
              placeholder="Project decisions, constraints, terminology, and reviewed facts"
              disabled={!workspace.selectedProject}
              aria-label="Shared project context"
            />
            <button
              type="button"
              className="button button--primary button--full"
              disabled={
                !workspace.selectedProject ||
                publishing ||
                draft.trim() === (workspace.activeContext?.content ?? "").trim()
              }
              onClick={() => void publish()}
            >
              <Save size={15} />
              Publish revision
            </button>
            {notice && (
              <div className="context-notice" role="status">
                {notice.startsWith("Published")
                  ? <Check size={14} />
                  : <CircleAlert size={14} />}
                <span>{notice}</span>
              </div>
            )}
          </section>

          <section className="inspector-section inspector-section--metadata">
            <h3>Source</h3>
            <dl>
              <div>
                <dt>Project</dt>
                <dd>{workspace.selectedProject?.name ?? "None"}</dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>
                  {workspace.activeContext
                    ? formatDate(workspace.activeContext.createdAt)
                    : "Not yet"}
                </dd>
              </div>
              <div>
                <dt>Source Thread</dt>
                <dd>
                  {workspace.snapshot?.threads.find(
                    (thread) =>
                      thread.id === workspace.activeContext?.sourceThreadId,
                  )?.title ?? "Manual"}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      ) : (
        <ActivityPanel workspace={workspace} />
      )}

      <footer className="inspector-footer">
        <div>
          <Settings2 size={15} />
          <span>Technical details</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={workspace.professionalMode}
          aria-label="Show technical details"
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

function ActivityPanel(props: {
  workspace: WorkspaceController;
}): JSX.Element {
  const { snapshot } = props.workspace;
  const projectId = props.workspace.selectedProject?.id;
  const projectThreads = snapshot?.threads.filter(
    (thread) => thread.projectId === projectId,
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
  const agents = snapshot?.agentProfiles.filter(
    (agent) => agent.projectId === projectId,
  ) ?? [];
  return (
    <div className="inspector-content">
      <section className="inspector-section">
        <div className="section-title-row">
          <div>
            <h3>Current Runs</h3>
            <span>{activeRuns.length} active</span>
          </div>
          <span className={`runtime-badge ${isDesktopRuntime ? "" : "is-preview"}`}>
            {isDesktopRuntime ? "Desktop" : "Preview"}
          </span>
        </div>
        <div className="activity-list">
          {activeRuns.length === 0 ? (
            <div className="activity-empty">
              <Check size={16} />
              <span>No active Runs</span>
            </div>
          ) : (
            activeRuns.map((run) => {
              const thread = projectThreads.find(
                (item) => item.id === run.threadId,
              );
              const agent = snapshot?.agentProfiles.find(
                (item) => item.id === thread?.agentProfileId,
              );
              return (
                <div className="activity-row" key={run.id}>
                  <span className={`activity-state activity-state--${run.status}`}>
                    <Clock3 size={14} />
                  </span>
                  <div>
                    <strong>{thread?.title ?? "Agent Run"}</strong>
                    <span>{agent?.name ?? "Agent"} · {formatStatus(run.status)}</span>
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
            <h3>Approvals</h3>
            <span>{approvals.length} pending</span>
          </div>
        </div>
        <div className="activity-list">
          {approvals.length === 0 ? (
            <div className="activity-empty">
              <Check size={16} />
              <span>No pending approvals</span>
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
                    ? `Open ${thread.title} to review ${humanize(item.toolCall.name)}`
                    : `Pending approval for ${humanize(item.toolCall.name)}`
                }
              >
                <span className="activity-state activity-state--approval">
                  <CircleAlert size={14} />
                </span>
                <div>
                  <strong>{humanize(item.toolCall.name)}</strong>
                  <span>
                    {thread?.title ?? "Unknown Thread"} · {item.approval.reason}
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
            <h3>Agents</h3>
            <span>{agents.length} configured</span>
          </div>
        </div>
        <div className="activity-list">
          {agents.map((agent) => (
            <div className="activity-row" key={agent.id}>
              <span className="activity-state">
                <Bot size={14} />
              </span>
              <div>
                <strong>{agent.name}</strong>
                <span>
                  {props.workspace.professionalMode
                    ? agent.runtimeKind === "native"
                      ? "Native API"
                      : "Local CLI"
                    : "Ready"}
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
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatStatus(value: string): string {
  return humanize(value.replaceAll("-", "_"));
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
