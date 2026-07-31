import { Bot, ListTodo } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

export function TaskDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  onClose: () => void;
  onNewAgent: () => void;
}): JSX.Element | null {
  const [title, setTitle] = useState("");
  const [agentInstanceId, setAgentInstanceId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = useMemo(() => {
    const snapshot = props.workspace.snapshot;
    const workspaceId = props.workspace.selectedWorkspace?.id;
    if (!snapshot || !workspaceId) {
      return [];
    }
    return snapshot.agentInstances
      .filter((instance) => instance.workspaceId === workspaceId)
      .flatMap((instance) => {
        const definition = snapshot.agentDefinitions.find(
          (item) => item.id === instance.agentDefinitionId,
        );
        const executable = snapshot.agentProfiles.some(
          (item) => item.id === definition?.id && item.projectId === workspaceId,
        );
        return definition && executable ? [{ instance, definition }] : [];
      });
  }, [props.workspace.selectedWorkspace?.id, props.workspace.snapshot]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setTitle("");
    setAgentInstanceId(agents[0]?.instance.id ?? "");
    setError(null);
  }, [agents, props.open]);

  if (!props.open) {
    return null;
  }

  const create = async () => {
    if (!title.trim() || !agentInstanceId) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await props.workspace.createTaskThread(agentInstanceId, title);
      props.onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal open title="新建任务" onClose={props.onClose}>
      {agents.length === 0 ? (
        <div className="dialog-empty">
          <Bot size={22} />
          <strong>当前工作区还没有 Agent</strong>
          <button
            type="button"
            className="button button--primary"
            onClick={props.onNewAgent}
          >
            新建 Agent
          </button>
        </div>
      ) : (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            <span>任务名称</span>
            <div className="input-with-icon">
              <ListTodo size={15} />
              <input
                autoFocus
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：整理本周行业动态"
                required
              />
            </div>
          </label>
          <label>
            <span>执行 Agent</span>
            <select
              value={agentInstanceId}
              onChange={(event) => setAgentInstanceId(event.target.value)}
              required
            >
              {agents.map(({ instance, definition }) => (
                <option key={instance.id} value={instance.id}>
                  {instance.nameOverride ?? definition.name}
                </option>
              ))}
            </select>
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <footer className="dialog-actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={props.onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={creating || !title.trim() || !agentInstanceId}
            >
              创建任务
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
