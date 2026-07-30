import {
  Columns2,
  Columns3,
  Columns4,
  PanelRight,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import type { WorkspaceController } from "../useWorkspace.js";

export function TabStrip(props: {
  workspace: WorkspaceController;
  onNewAgent: () => void;
}): JSX.Element {
  const { workspace } = props;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectTab = (threadId: string) => {
    workspace.openThread(threadId);
    requestAnimationFrame(() => tabRefs.current.get(threadId)?.focus());
  };
  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    threadId: string,
  ) => {
    const currentIndex = workspace.openThreads.findIndex(
      (thread) => thread.id === threadId,
    );
    if (currentIndex < 0) {
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % workspace.openThreads.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + workspace.openThreads.length) %
        workspace.openThreads.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = workspace.openThreads.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextThread = workspace.openThreads[nextIndex];
    if (nextThread) {
      selectTab(nextThread.id);
    }
  };
  return (
    <div className="tab-strip">
      <div className="tabs" role="tablist" aria-label="Open Agent Threads">
        {workspace.openThreads.map((thread) => {
          const run = workspace.getRunForThread(thread.id);
          return (
            <div
              key={thread.id}
              className={`tab ${
                workspace.activeThread?.id === thread.id ? "is-active" : ""
              }`}
            >
              <button
                ref={(element) => {
                  if (element) {
                    tabRefs.current.set(thread.id, element);
                  } else {
                    tabRefs.current.delete(thread.id);
                  }
                }}
                id={`thread-tab-${thread.id}`}
                type="button"
                role="tab"
                aria-selected={workspace.activeThread?.id === thread.id}
                aria-controls={
                  workspace.visibleThreads.some((item) => item.id === thread.id)
                    ? `thread-panel-${thread.id}`
                    : undefined
                }
                tabIndex={workspace.activeThread?.id === thread.id ? 0 : -1}
                onClick={() => workspace.openThread(thread.id)}
                onKeyDown={(event) => onTabKeyDown(event, thread.id)}
              >
                {run && (
                  <>
                    <span
                      className={`tab-run-dot tab-run-dot--${run.status}`}
                      aria-hidden="true"
                    />
                    <span className="sr-only">Run {formatStatus(run.status)}.</span>
                  </>
                )}
                <span>{thread.title}</span>
              </button>
              <button
                className="tab-close"
                type="button"
                onClick={() => workspace.closeThread(thread.id)}
                title="Close tab"
                aria-label={`Close ${thread.title}`}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="icon-button icon-button--small tab-add"
          onClick={props.onNewAgent}
          title="New Agent"
          aria-label="New Agent"
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="workbench-controls">
        <div
          className="segmented-icons"
          role="group"
          aria-label="Split view"
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
          title="Toggle inspector"
          aria-label="Toggle inspector"
        >
          <PanelRight size={17} />
        </button>
      </div>
    </div>
  );
}

function formatStatus(value: string): string {
  return value.replaceAll("-", " ");
}

function SplitButton(props: {
  count: number;
  active: boolean;
  disabled: boolean;
  onClick: (count: number) => void;
  icon: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      className={props.active ? "is-active" : ""}
      disabled={props.disabled}
      onClick={() => props.onClick(props.count)}
      title={`${props.count} pane${props.count > 1 ? "s" : ""}`}
      aria-label={`${props.count} pane${props.count > 1 ? "s" : ""}`}
      aria-pressed={props.active}
    >
      {props.icon}
    </button>
  );
}
