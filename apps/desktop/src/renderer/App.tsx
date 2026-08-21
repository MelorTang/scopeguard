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
import { ArtifactCaptureDialog } from "./components/ArtifactCaptureDialog.js";
import { ArtifactReview } from "./components/ArtifactReview.js";
import { ConversationDialog } from "./components/ConversationDialog.js";
import { ProviderDialog } from "./components/ProviderDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { ThreadPane } from "./components/ThreadPane.js";
import { PaneSplitter } from "./components/PaneSplitter.js";
import { WorkspaceToolbar } from "./components/WorkspaceToolbar.js";
import { WorkspaceDialog } from "./components/WorkspaceDialog.js";
import { useWorkspace } from "./useWorkspace.js";

export function App(): JSX.Element {
  const workspace = useWorkspace();
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [conversationDialogOpen, setConversationDialogOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [captureArtifactId, setCaptureArtifactId] = useState<string | undefined>(undefined);
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);

  const openCaptureDialog = (artifactId?: string) => {
    if (!workspace.selectedWorkspace) {
      setWorkspaceDialogOpen(true);
      return;
    }
    setCaptureArtifactId(artifactId);
    setCaptureDialogOpen(true);
  };

  const openAgentDialog = () => {
    if (!workspace.selectedWorkspace) {
      setWorkspaceDialogOpen(true);
      return;
    }
    setAgentDialogOpen(true);
  };

  const openConversationDialog = () => {
    if (!workspace.selectedWorkspace) {
      setWorkspaceDialogOpen(true);
      return;
    }
    setConversationDialogOpen(true);
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
      }`}
    >
      <Sidebar
        workspace={workspace}
        onNewAgent={openAgentDialog}
        onNewConversation={openConversationDialog}
        onNewWorkspace={() => setWorkspaceDialogOpen(true)}
        onCaptureArtifact={() => openCaptureDialog()}
        onProviders={() => setProviderDialogOpen(true)}
      />

      <main className="main-area">
        <WorkspaceToolbar
          workspace={workspace}
          onNewConversation={openConversationDialog}
        />
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
        {workspace.centerState?.mode === "artifact-review" ? (
          <ArtifactReview
            workspace={workspace}
            onCaptureNewVersion={(artifactId) => openCaptureDialog(artifactId)}
          />
        ) : workspace.visibleThreads.length > 0 ? (
          <div
            className="workbench"
            style={{
              gridTemplateColumns: workspace.paneWidths
                .flatMap((width, index) => index === workspace.paneWidths.length - 1
                  ? [`${width}px`]
                  : [`${width}px`, "8px"])
                .join(" "),
            } as CSSProperties}
          >
            {workspace.visibleThreads.flatMap((thread, paneIndex) => {
              const pane = (
                <ThreadPane
                  key={thread.id}
                  thread={thread}
                  workspace={workspace}
                  paneIndex={paneIndex}
                  active={workspace.activePaneIndex === paneIndex}
                  onActivate={() => workspace.selectPane(paneIndex)}
                />
              );
              const next = workspace.visibleThreads[paneIndex + 1];
              return next ? [
                pane,
                <PaneSplitter
                  key={`${thread.id}:${next.id}`}
                  index={paneIndex}
                  leftTitle={thread.title}
                  rightTitle={next.title}
                  leftWidth={workspace.paneWidths[paneIndex]!}
                  rightWidth={workspace.paneWidths[paneIndex + 1]!}
                  onResize={(deltaPixels) => workspace.resizePane(paneIndex, deltaPixels)}
                />,
              ] : [pane];
            })}
          </div>
        ) : (
          <WorkspaceEmpty
            hasWorkspace={Boolean(workspace.selectedWorkspace)}
            hasProvider={(workspace.snapshot?.providerProfiles.length ?? 0) > 0}
            hasAgent={workspace.snapshot?.agents.some(
              (agent) => agent.workspaceId === workspace.selectedProject?.id,
            ) ?? false}
            onWorkspace={() => setWorkspaceDialogOpen(true)}
            onProvider={() => setProviderDialogOpen(true)}
            onAgent={openAgentDialog}
            onConversation={openConversationDialog}
          />
        )}
      </main>

      <ProviderDialog
        open={providerDialogOpen}
        workspace={workspace}
        onClose={() => setProviderDialogOpen(false)}
      />
      <ArtifactCaptureDialog
        open={captureDialogOpen}
        workspace={workspace}
        artifactId={captureArtifactId}
        onClose={() => {
          setCaptureDialogOpen(false);
          setCaptureArtifactId(undefined);
        }}
      />
      <WorkspaceDialog
        open={workspaceDialogOpen}
        workspace={workspace}
        onClose={() => setWorkspaceDialogOpen(false)}
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
      <ConversationDialog
        open={conversationDialogOpen}
        workspace={workspace}
        onClose={() => setConversationDialogOpen(false)}
        onNewAgent={() => {
          setConversationDialogOpen(false);
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
  onConversation: () => void;
}): JSX.Element {
  if (!props.hasWorkspace) {
    return (
      <section className="workspace-empty">
        <span className="workspace-empty__icon"><FolderPlus size={22} /></span>
        <h1>创建工作区</h1>
        <p>集中管理 Agent、对话和本地工作文件。</p>
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
        <h1>创建对话</h1>
        <p>选择一个 Agent，开始一个独立上下文。</p>
        <button
          type="button"
          className="button button--primary"
          onClick={props.onConversation}
        >
          <Plus size={16} />
          新建对话
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
