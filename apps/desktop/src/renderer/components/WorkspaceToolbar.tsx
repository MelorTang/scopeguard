import {
  Check,
  Columns2,
  Columns3,
  Columns4,
  PanelRight,
  Plus,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { WorkspaceController } from "../useWorkspace.js";

const SPLIT_OPTIONS = [
  { count: 1, label: "单窗格", icon: <Square size={14} /> },
  { count: 2, label: "两个窗格", icon: <Columns2 size={14} /> },
  { count: 3, label: "三个窗格", icon: <Columns3 size={14} /> },
  { count: 4, label: "四个窗格", icon: <Columns4 size={14} /> },
] as const;

export function WorkspaceToolbar(props: {
  workspace: WorkspaceController;
  onNewTask: () => void;
}): JSX.Element {
  const { workspace } = props;
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceId = workspace.selectedWorkspace?.id;
  const taskCount = workspace.snapshot?.tasks.filter(
    (task) => task.workspaceId === workspaceId,
  ).length ?? 0;
  const agentCount = workspace.snapshot?.agentInstances.filter(
    (agent) => agent.workspaceId === workspaceId,
  ).length ?? 0;

  useEffect(() => {
    if (!layoutMenuOpen) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!layoutRef.current?.contains(event.target as Node)) {
        setLayoutMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [layoutMenuOpen]);

  // Move focus into the menu when it opens: the current layout if enabled,
  // otherwise the first available option.
  useEffect(() => {
    if (!layoutMenuOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const selected = layoutRef.current?.querySelector<HTMLButtonElement>(
        ".toolbar-menu button.is-selected:not([disabled])",
      );
      const first = layoutRef.current?.querySelector<HTMLButtonElement>(
        ".toolbar-menu button:not([disabled])",
      );
      (selected ?? first)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [layoutMenuOpen]);

  const closeLayoutMenu = (options?: { restoreFocus?: boolean }) => {
    setLayoutMenuOpen(false);
    if (options?.restoreFocus) {
      layoutButtonRef.current?.focus();
    }
  };

  const onLayoutKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!layoutMenuOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeLayoutMenu({ restoreFocus: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = [
      ...(layoutRef.current?.querySelectorAll<HTMLButtonElement>(
        ".toolbar-menu button:not([disabled])",
      ) ?? []),
    ];
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex = event.key === "ArrowDown"
      ? (currentIndex + 1) % items.length
      : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

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
          className="toolbar-menu-wrap"
          ref={layoutRef}
          onKeyDown={onLayoutKeyDown}
        >
          <button
            type="button"
            ref={layoutButtonRef}
            className={`icon-button ${layoutMenuOpen ? "is-active" : ""}`}
            onClick={() => setLayoutMenuOpen((current) => !current)}
            title="并列布局"
            aria-label={`并列布局，当前 ${workspace.effectiveSplitCount} 个窗格`}
            aria-haspopup="menu"
            aria-expanded={layoutMenuOpen}
          >
            <Columns2 size={17} />
          </button>
          {layoutMenuOpen && (
            <div className="toolbar-menu" role="menu" aria-label="并列布局">
              {SPLIT_OPTIONS.map((option) => {
                const disabled = workspace.maxSplitCount < option.count;
                const active = workspace.effectiveSplitCount === option.count;
                return (
                  <button
                    key={option.count}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={disabled}
                    className={active ? "is-selected" : ""}
                    onClick={() => {
                      workspace.setRequestedSplitCount(option.count);
                      closeLayoutMenu({ restoreFocus: true });
                    }}
                  >
                    {option.icon}
                    <span>{option.label}</span>
                    {active && <Check size={14} />}
                  </button>
                );
              })}
            </div>
          )}
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
