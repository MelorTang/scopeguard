import { Bot, MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

export function ConversationDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  onClose: () => void;
  onNewAgent: () => void;
}): JSX.Element | null {
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = useMemo(() => {
    const snapshot = props.workspace.snapshot;
    const workspaceId = props.workspace.selectedProject?.id;
    return snapshot && workspaceId
      ? snapshot.agentProfiles.filter((agent) => agent.projectId === workspaceId)
      : [];
  }, [props.workspace.selectedProject?.id, props.workspace.snapshot]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setTitle("");
    setAgentId(agents[0]?.id ?? "");
    setError(null);
  }, [agents, props.open]);

  if (!props.open) {
    return null;
  }

  const create = async () => {
    if (!title.trim() || !agentId) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await props.workspace.createConversation(agentId, title);
      props.onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal open title="新建对话" onClose={props.onClose}>
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
            <span>对话名称</span>
            <div className="input-with-icon">
              <MessageSquarePlus size={15} />
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
            <span>Agent</span>
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              required
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
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
              disabled={creating || !title.trim() || !agentId}
            >
              创建对话
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
