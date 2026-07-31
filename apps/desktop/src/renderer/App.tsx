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
import { RuntimeDialog } from "./components/RuntimeDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { ThreadPane } from "./components/ThreadPane.js";
import { TaskDialog } from "./components/TaskDialog.js";
import { WorkspaceToolbar } from "./components/WorkspaceToolbar.js";
import { WorkspaceDialog } from "./components/WorkspaceDialog.js";
import { useWorkspace } from "./useWorkspace.js";

export function App(): JSX.Element {
  const workspace = useWorkspace();
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);

  const openAgentDialog = () => {
    if (!workspace.selectedWorkspace) {
      setWorkspaceDialogOpen(true);
      return;
    }
    setAgentDialogOpen(true);
  };

  const openTaskDialog = () => {
    if (!workspace.selectedWorkspace) {
      setWorkspaceDialogOpen(true);
      return;
    }
    setTaskDialogOpen(true);
  };

  if (workspace.loading) {
    return (
      <main className="boot-screen">
        <LoaderCircle size={24} className="spin" />
        <span>正在打开工作区</span>
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
        onNewTask={openTaskDialog}
        onNewWorkspace={() => setWorkspaceDialogOpen(true)}
        onProviders={() => setProviderDialogOpen(true)}
        onRuntimes={() => setRuntimeDialogOpen(true)}
      />

      <main className="main-area">
        <WorkspaceToolbar workspace={workspace} onNewTask={openTaskDialog} />
        {workspace.error && (
          <div className="global-error" role="alert">
            <CircleAlert size={16} />
            <span>{workspace.error}</span>
            <button
              type="button"
              className="button button--secondary button--compact"
              onClick={() => void workspace.refresh()}
            >
              重试
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
            hasWorkspace={Boolean(workspace.selectedWorkspace)}
            hasProvider={(workspace.snapshot?.providerProfiles.length ?? 0) > 0}
            hasAgent={workspace.snapshot?.agentInstances.some(
              (instance) =>
                instance.workspaceId === workspace.selectedWorkspace?.id,
            ) ?? false}
            onWorkspace={() => setWorkspaceDialogOpen(true)}
            onProvider={() => setProviderDialogOpen(true)}
            onAgent={openAgentDialog}
            onTask={openTaskDialog}
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
      <WorkspaceDialog
        open={workspaceDialogOpen}
        workspace={workspace}
        onClose={() => setWorkspaceDialogOpen(false)}
      />
      <RuntimeDialog
        open={runtimeDialogOpen}
        workspace={workspace}
        onClose={() => setRuntimeDialogOpen(false)}
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
      <TaskDialog
        open={taskDialogOpen}
        workspace={workspace}
        onClose={() => setTaskDialogOpen(false)}
        onNewAgent={() => {
          setTaskDialogOpen(false);
          setAgentDialogOpen(true);
        }}
      />
    </div>
  );
}

function WorkspaceEmpty(props: {
  hasWorkspace: boolean;
  hasProvider: boolean;
  hasAgent: boolean;
  onWorkspace: () => void;
  onProvider: () => void;
  onAgent: () => void;
  onTask: () => void;
}): JSX.Element {
  if (!props.hasWorkspace) {
    return (
      <section className="workspace-empty">
        <span className="workspace-empty__icon"><FolderPlus size={22} /></span>
        <h1>创建工作区</h1>
        <p>集中管理 Agent、任务、共享上下文和成果。</p>
        <button
          type="button"
          className="button button--primary"
          onClick={props.onWorkspace}
        >
          <FolderPlus size={16} />
          新建工作区
        </button>
      </section>
    );
  }
  if (!props.hasProvider) {
    return (
      <section className="workspace-empty">
        <span className="workspace-empty__icon"><Network size={22} /></span>
        <h1>添加模型服务</h1>
        <p>连接可直连的模型接口，或配置你自己的中转服务。</p>
        <button
          type="button"
          className="button button--primary"
          onClick={props.onProvider}
        >
          <Plus size={16} />
          添加模型服务
        </button>
      </section>
    );
  }
  if (props.hasAgent) {
    return (
      <section className="workspace-empty">
        <span className="workspace-empty__icon"><Bot size={22} /></span>
        <h1>创建任务</h1>
        <p>选择一个 Agent，开始一项独立工作。</p>
        <button
          type="button"
          className="button button--primary"
          onClick={props.onTask}
        >
          <Plus size={16} />
          新建任务
        </button>
      </section>
    );
  }
  return (
    <section className="workspace-empty">
      <span className="workspace-empty__icon"><Bot size={22} /></span>
      <h1>创建 Agent</h1>
      <p>先创建一个职责明确的 Agent。</p>
      <button
        type="button"
        className="button button--primary"
        onClick={props.onAgent}
      >
        <Plus size={16} />
        新建 Agent
      </button>
    </section>
  );
}
