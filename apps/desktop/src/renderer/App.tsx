import {
  Bot,
  CircleAlert,
  FolderPlus,
  LoaderCircle,
  Network,
  Plus,
} from "lucide-react";
import { useState, type CSSProperties } from "react";

import { AgentDialog } from "./components/AgentDialog.js";
import { Inspector } from "./components/Inspector.js";
import { ProviderDialog } from "./components/ProviderDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { TabStrip } from "./components/TabStrip.js";
import { ThreadPane } from "./components/ThreadPane.js";
import { useWorkspace } from "./useWorkspace.js";

export function App(): JSX.Element {
  const workspace = useWorkspace();
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);

  const openAgentDialog = () => {
    if (!workspace.selectedProject) {
      void workspace.addProject();
      return;
    }
    setAgentDialogOpen(true);
  };

  if (workspace.loading) {
    return (
      <main className="boot-screen">
        <LoaderCircle size={24} className="spin" />
        <span>Opening workspace</span>
      </main>
    );
  }

  return (
    <div
      className={`app-shell ${
        workspace.sidebarCollapsed ? "app-shell--sidebar-collapsed" : ""
      } ${workspace.inspectorOpen ? "app-shell--inspector-open" : ""}`}
    >
      <Sidebar
        workspace={workspace}
        onNewAgent={openAgentDialog}
        onProviders={() => setProviderDialogOpen(true)}
      />

      <main className="main-area">
        <TabStrip workspace={workspace} onNewAgent={openAgentDialog} />
        {workspace.error && (
          <div className="global-error" role="alert">
            <CircleAlert size={16} />
            <span>{workspace.error}</span>
            <button
              type="button"
              className="button button--secondary button--compact"
              onClick={() => void workspace.refresh()}
            >
              Retry
            </button>
          </div>
        )}
        {workspace.visibleThreads.length > 0 ? (
          <div
            className="workbench"
            style={{
              "--pane-count": workspace.effectiveSplitCount,
            } as CSSProperties}
          >
            {workspace.visibleThreads.map((thread, paneIndex) => (
              <ThreadPane
                key={thread.id}
                thread={thread}
                workspace={workspace}
                paneIndex={paneIndex}
                active={workspace.activePaneIndex === paneIndex}
                onActivate={() => workspace.selectPane(paneIndex)}
              />
            ))}
          </div>
        ) : (
          <WorkspaceEmpty
            hasProject={Boolean(workspace.selectedProject)}
            hasProvider={(workspace.snapshot?.providerProfiles.length ?? 0) > 0}
            onProject={() => void workspace.addProject()}
            onProvider={() => setProviderDialogOpen(true)}
            onAgent={openAgentDialog}
          />
        )}
      </main>

      {workspace.inspectorOpen && (
        <Inspector
          workspace={workspace}
          onClose={() => workspace.setInspectorOpen(false)}
        />
      )}

      <ProviderDialog
        open={providerDialogOpen}
        workspace={workspace}
        onClose={() => setProviderDialogOpen(false)}
      />
      <AgentDialog
        open={agentDialogOpen}
        workspace={workspace}
        onClose={() => setAgentDialogOpen(false)}
        onNeedProvider={() => {
          setAgentDialogOpen(false);
          setProviderDialogOpen(true);
        }}
      />
    </div>
  );
}

function WorkspaceEmpty(props: {
  hasProject: boolean;
  hasProvider: boolean;
  onProject: () => void;
  onProvider: () => void;
  onAgent: () => void;
}): JSX.Element {
  if (!props.hasProject) {
    return (
      <section className="workspace-empty">
        <span className="workspace-empty__icon"><FolderPlus size={22} /></span>
        <h1>Open a Project</h1>
        <p>Select a local folder for Agent files and project context.</p>
        <button
          type="button"
          className="button button--primary"
          onClick={props.onProject}
        >
          <FolderPlus size={16} />
          Open folder
        </button>
      </section>
    );
  }
  if (!props.hasProvider) {
    return (
      <section className="workspace-empty">
        <span className="workspace-empty__icon"><Network size={22} /></span>
        <h1>Add a Provider</h1>
        <p>Connect a direct model endpoint or your own relay.</p>
        <button
          type="button"
          className="button button--primary"
          onClick={props.onProvider}
        >
          <Plus size={16} />
          Add provider
        </button>
      </section>
    );
  }
  return (
    <section className="workspace-empty">
      <span className="workspace-empty__icon"><Bot size={22} /></span>
      <h1>Create an Agent</h1>
      <p>Start an independent Thread in this Project.</p>
      <button
        type="button"
        className="button button--primary"
        onClick={props.onAgent}
      >
        <Plus size={16} />
        New Agent
      </button>
    </section>
  );
}
