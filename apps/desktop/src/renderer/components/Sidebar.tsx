import {
  Bot,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
} from "lucide-react";

import type { WorkspaceController } from "../useWorkspace.js";

export function Sidebar(props: {
  workspace: WorkspaceController;
  onNewAgent: () => void;
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
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => void workspace.addProject()}
          title="Open project"
          aria-label="Open project"
        >
          <FolderPlus size={18} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={props.onNewAgent}
          title="New Agent"
          aria-label="New Agent"
        >
          <Plus size={18} />
        </button>
        <div className="sidebar-spacer" />
        <button
          className="icon-button"
          type="button"
          onClick={props.onProviders}
          title="Provider settings"
          aria-label="Provider settings"
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
          <span>Agent workspace</span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => workspace.setSidebarCollapsed(true)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={18} />
        </button>
      </header>

      <div className="sidebar-section-heading">
        <span>Projects</span>
        <button
          className="icon-button icon-button--small"
          type="button"
          onClick={() => void workspace.addProject()}
          title="Open project"
          aria-label="Open project"
        >
          <FolderPlus size={16} />
        </button>
      </div>

      <nav className="project-tree" aria-label="Projects and Agent Threads">
        {snapshot?.projects.map((project) => {
          const selected = workspace.selectedProject?.id === project.id;
          const threads = snapshot.threads.filter(
            (thread) => thread.projectId === project.id,
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
                  {threads.map((thread) => {
                    const agent = snapshot.agentProfiles.find(
                      (profile) => profile.id === thread.agentProfileId,
                    );
                    const run = workspace.getRunForThread(thread.id);
                    const approvalCount = snapshot.pendingApprovals.filter(
                      (item) => item.approval.runId === run?.id,
                    ).length;
                    return (
                      <button
                        type="button"
                        key={thread.id}
                        className={`thread-row ${
                          workspace.activeThread?.id === thread.id
                            ? "is-selected"
                            : ""
                        }`}
                        onClick={() => workspace.openThread(thread.id)}
                      >
                        <Bot size={15} />
                        <span className="thread-row__content">
                          <span className="thread-row__title">{thread.title}</span>
                          <span className="thread-row__agent">
                            {agent?.name ?? "Agent"}
                          </span>
                        </span>
                        <ThreadStatus
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
                    <Plus size={15} />
                    <span>New Agent</span>
                  </button>
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
          <span>Providers</span>
          <span className="sidebar-count">
            {snapshot?.providerProfiles.length ?? 0}
          </span>
        </button>
      </footer>
    </aside>
  );
}

function ThreadStatus(props: {
  status: string | null;
  approvalCount: number;
}): JSX.Element | null {
  if (props.approvalCount > 0) {
    return (
      <span className="status-badge status-badge--approval">
        {props.approvalCount}
      </span>
    );
  }
  if (!props.status) {
    return null;
  }
  return (
    <span
      className={`thread-status-dot thread-status-dot--${props.status}`}
      aria-label={props.status}
      title={props.status}
    />
  );
}
