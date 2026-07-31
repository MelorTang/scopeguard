import { FolderOpen, PanelsTopLeft, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

export function WorkspaceDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  onClose: () => void;
}): JSX.Element | null {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setName("");
    setError(null);
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const create = async () => {
    if (!name.trim()) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await props.workspace.createWorkspace(name);
      props.onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  };

  const openFolder = async () => {
    setCreating(true);
    setError(null);
    try {
      const project = await props.workspace.addProject();
      if (project) {
        props.onClose();
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal open title="新建工作区" onClose={props.onClose}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          <span>工作区名称</span>
          <div className="input-with-icon">
            <PanelsTopLeft size={15} />
            <input
              autoFocus
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：市场研究"
              required
            />
          </div>
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <footer className="dialog-actions dialog-actions--split">
          <button
            type="button"
            className="button button--secondary"
            disabled={creating}
            onClick={() => void openFolder()}
          >
            <FolderOpen size={15} />
            打开本地文件夹
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={creating || !name.trim()}
          >
            <Plus size={15} />
            {creating ? "正在创建…" : "创建"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
