import {
  Columns2,
  Columns3,
  Columns4,
  PanelRight,
  Plus,
  Square,
} from "lucide-react";

import type { WorkspaceController } from "../useWorkspace.js";

export function WorkspaceToolbar(props: {
  workspace: WorkspaceController;
  onNewTask: () => void;
}): JSX.Element {
  const { workspace } = props;
  const workspaceId = workspace.selectedWorkspace?.id;
  const taskCount = workspace.snapshot?.tasks.filter(
    (task) => task.workspaceId === workspaceId,
  ).length ?? 0;
  const agentCount = workspace.snapshot?.agentInstances.filter(
    (agent) => agent.workspaceId === workspaceId,
  ).length ?? 0;
  return (
    <header className="workspace-toolbar" aria-label="工作区工具栏">
      <div className="workspace-toolbar__drag-region" aria-hidden="true" />
      <div className="workspace-toolbar__identity">
        <strong>{workspace.selectedWorkspace?.name ?? "ScopeGuard"}</strong>
        <span>{taskCount} 项任务 · {agentCount} 个 Agent</span>
      </div>
      <div className="workbench-controls">
        <button
          type="button"
          className="button button--secondary button--compact"
          onClick={props.onNewTask}
          disabled={!workspace.selectedWorkspace}
        >
          <Plus size={14} />
          新建任务
        </button>
        <div
          className="segmented-icons"
          role="group"
          aria-label="并列布局"
        >
          <SplitButton
            count={1}
            active={workspace.effectiveSplitCount === 1}
            disabled={false}
            onClick={workspace.setRequestedSplitCount}
            icon={<Square size={15} />}
          />
          <SplitButton
            count={2}
            active={workspace.effectiveSplitCount === 2}
            disabled={workspace.maxSplitCount < 2}
            onClick={workspace.setRequestedSplitCount}
            icon={<Columns2 size={16} />}
          />
          <SplitButton
            count={3}
            active={workspace.effectiveSplitCount === 3}
            disabled={workspace.maxSplitCount < 3}
            onClick={workspace.setRequestedSplitCount}
            icon={<Columns3 size={16} />}
          />
          <SplitButton
            count={4}
            active={workspace.effectiveSplitCount === 4}
            disabled={workspace.maxSplitCount < 4}
            onClick={workspace.setRequestedSplitCount}
            icon={<Columns4 size={16} />}
          />
        </div>
        <button
          type="button"
          className={`icon-button ${workspace.inspectorOpen ? "is-active" : ""}`}
          onClick={() => workspace.setInspectorOpen(!workspace.inspectorOpen)}
          title="显示或隐藏侧边面板"
          aria-label="显示或隐藏侧边面板"
        >
          <PanelRight size={17} />
        </button>
      </div>
    </header>
  );
}

function SplitButton(props: {
  count: number;
  active: boolean;
  disabled: boolean;
  onClick: (count: number) => void;
  icon: JSX.Element;
}): JSX.Element {
  const label = `${props.count} 个对话窗格`;
  return (
    <button
      type="button"
      className={props.active ? "is-active" : ""}
      disabled={props.disabled}
      onClick={() => props.onClick(props.count)}
      title={label}
      aria-label={label}
      aria-pressed={props.active}
    >
      {props.icon}
    </button>
  );
}
