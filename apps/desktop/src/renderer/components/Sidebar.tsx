import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderPlus,
  FileText,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  SquarePen,
} from "lucide-react";

import type { WorkspaceController } from "../useWorkspace.js";
import { formatRunStatus } from "../uiText.js";

export function Sidebar(props: {
  workspace: WorkspaceController;
  onNewAgent: () => void;
  onNewConversation: () => void;
  onNewWorkspace: () => void;
  onCaptureArtifact: () => void;
  onProviders: () => void;
}): JSX.Element {
  const { workspace } = props;
  const snapshot = workspace.snapshot;
  if (workspace.sidebarCollapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <div className="sidebar-brand sidebar-brand--collapsed" aria-label="ScopeGuard">
          S
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => workspace.setSidebarCollapsed(false)}
          title="展开侧边栏"
          aria-label="展开侧边栏"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={props.onNewWorkspace}
          title="新建工作区"
          aria-label="新建工作区"
        >
          <FolderPlus size={18} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={props.onNewConversation}
          title="新建对话"
          aria-label="新建对话"
        >
          <MessageSquare size={18} />
        </button>
        <div className="sidebar-spacer" />
        <button
          className="icon-button"
          type="button"
          onClick={props.onProviders}
          title="模型服务设置"
          aria-label="模型服务设置"
        >
          <Settings size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-brand">
        <div>
          <strong>ScopeGuard</strong>
          <span>Agent 控制台</span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => workspace.setSidebarCollapsed(true)}
          title="收起侧边栏"
          aria-label="收起侧边栏"
        >
          <PanelLeftClose size={18} />
        </button>
      </header>

      <div className="sidebar-primary">
        <button
          type="button"
          className="sidebar-new-task"
          onClick={props.onNewConversation}
        >
          <SquarePen size={15} />
          <span>新建对话</span>
        </button>
      </div>

      <div className="sidebar-section-heading">
        <span>工作区</span>
        <button
          className="icon-button icon-button--small"
          type="button"
          onClick={props.onNewWorkspace}
          title="新建工作区"
          aria-label="新建工作区"
        >
          <FolderPlus size={16} />
        </button>
      </div>

      <nav className="project-tree" aria-label="工作区和对话">
        {snapshot?.workspaces.map((project) => {
          const selected = workspace.selectedProject?.id === project.id;
          const conversations = snapshot.conversations.filter(
            (conversation) => conversation.workspaceId === project.id,
          );
          const artifacts = snapshot.artifacts.filter(
            (artifact) => artifact.workspaceId === project.id,
          );
          return (
            <section className="project-node" key={project.id}>
              <button
                type="button"
                className={`project-row ${selected ? "is-selected" : ""}`}
                onClick={() => workspace.selectProject(project.id)}
              >
                {selected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={16} />
                <span className="project-row__name">{project.name}</span>
              </button>
              {selected && (
                <div className="thread-tree">
                  <div className="tree-group-label">
                    <span>对话</span>
                    <button
                      type="button"
                      className="icon-button icon-button--small"
                      onClick={props.onNewConversation}
                      title="新建对话"
                      aria-label="新建对话"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {conversations.map((thread) => {
                    const agent = snapshot.agents.find(
                      (item) => item.id === thread.agentId,
                    );
                    const run = workspace.getRunForThread(thread.id);
                    const approvalCount = snapshot.pendingApprovals.filter(
                      (item) => item.approval.runId === run?.id,
                    ).length;
                    const visible = Boolean(thread && workspace.visibleThreads.some(
                      (item) => item.id === thread.id,
                    ));
                    const active = Boolean(
                      thread && workspace.activeThread?.id === thread.id,
                    );
                    return (
                      <button
                        type="button"
                        key={thread.id}
                        className={`thread-row ${
                          visible ? "is-visible" : ""
                        } ${
                          active ? "is-selected" : ""
                        }`}
                        aria-current={active ? "page" : undefined}
                        onClick={() => workspace.openThread(thread.id)}
                      >
                        <MessageSquare size={15} />
                        <span className="thread-row__content">
                          <span className="thread-row__title">{thread.title}</span>
                          <span className="thread-row__agent">
                            {agent?.name ?? "Agent"}
                          </span>
                        </span>
                        <ConversationStatus
                          status={run?.status ?? null}
                          approvalCount={approvalCount}
                        />
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="thread-row thread-row--new"
                    onClick={props.onNewAgent}
                  >
                    <Bot size={15} />
                    <span>新建 Agent</span>
                  </button>
                  <div className="tree-group-label tree-group-label--artifacts">
                    <span>成果</span>
                    <button
                      type="button"
                      className="icon-button icon-button--small"
                      onClick={props.onCaptureArtifact}
                      title="捕获成果"
                      aria-label="捕获成果"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {artifacts.map((artifact) => {
                    const active = workspace.centerState?.mode === "artifact-review" &&
                      workspace.centerState.artifactId === artifact.id;
                    const versionCount = snapshot.artifactVersions.filter(
                      ({ artifactId }) => artifactId === artifact.id,
                    ).length;
                    return (
                      <button
                        type="button"
                        key={artifact.id}
                        className={`thread-row artifact-row ${active ? "is-selected" : ""}`}
                        aria-current={active ? "page" : undefined}
                        onClick={() => void workspace.openArtifact(artifact.id)}
                      >
                        <FileText size={15} />
                        <span className="thread-row__content">
                          <span className="thread-row__title">{artifact.title}</span>
                          <span className="thread-row__agent">{versionCount} 个版本</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />
      <footer className="sidebar-footer">
        <button type="button" className="sidebar-command" onClick={props.onProviders}>
          <Settings size={16} />
          <span>模型服务</span>
          <span className="sidebar-count">
            {snapshot?.providerProfiles.length ?? 0}
          </span>
        </button>
      </footer>
    </aside>
  );
}

function ConversationStatus(props: {
  status: string | null;
  approvalCount: number;
}): JSX.Element | null {
  if (props.approvalCount > 0) {
    const label = `${props.approvalCount} 项待审批`;
    return (
      <span
        className="status-badge status-badge--approval"
        aria-label={label}
        title={label}
      >
        <CircleAlert size={12} aria-hidden="true" />
        <span>{props.approvalCount}</span>
      </span>
    );
  }
  if (!props.status) {
    return null;
  }
  if (props.status === "ready" || props.status === "draft") {
    return null;
  }
  if (props.status === "completed") {
    return (
      <span className="thread-status-icon thread-status-icon--completed" title="已完成">
        <Check size={13} aria-hidden="true" />
      </span>
    );
  }
  if (props.status === "cancelled" || props.status === "archived") {
    return null;
  }
  const tone = props.status === "failed" ||
      props.status === "blocked" ||
      props.status === "cancelling"
    ? "attention"
    : props.status === "waiting-approval" || props.status === "waiting-input"
      ? "waiting"
      : "running";
  const label = formatRunStatus(props.status);
  return (
    <span
      className={`status-dot status-dot--${tone}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
