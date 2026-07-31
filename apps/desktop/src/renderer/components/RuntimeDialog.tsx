import {
  Check,
  CircleAlert,
  Cloud,
  Laptop,
  LoaderCircle,
  Plus,
  Server,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { RuntimeNode } from "@scopeguard/domain";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

const NEW_RUNTIME_ID = "__new_runtime__";

export function RuntimeDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  onClose: () => void;
}): JSX.Element | null {
  const runtimes = props.workspace.snapshot?.runtimeNodes ?? [];
  const [selectedId, setSelectedId] = useState(NEW_RUNTIME_ID);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const selected = useMemo(
    () => runtimes.find((runtime) => runtime.id === selectedId) ?? null,
    [runtimes, selectedId],
  );

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const firstRemote = runtimes.find((runtime) => runtime.kind === "remote");
    selectRuntime(firstRemote ?? null);
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const selectRuntime = (runtime: RuntimeNode | null) => {
    setSelectedId(runtime?.id ?? NEW_RUNTIME_ID);
    setName(runtime?.kind === "remote" ? runtime.name : "");
    setBaseUrl(runtime?.kind === "remote" ? runtime.baseUrl ?? "" : "");
    setCredential("");
    setStatus(null);
  };

  const save = async (): Promise<RuntimeNode> => {
    if (!name.trim() || !baseUrl.trim()) {
      throw new Error("名称和 URL 不能为空。");
    }
    const runtime = await props.workspace.saveRuntime({
      id: selected?.kind === "remote" ? selected.id : undefined,
      name: name.trim(),
      kind: "remote",
      baseUrl: baseUrl.trim(),
      credential: credential.trim() || undefined,
    });
    setSelectedId(runtime.id);
    setCredential("");
    return runtime;
  };

  const saveOnly = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await save();
      setStatus({ kind: "success", message: "已保存" });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const runtime = await save();
      const result = await props.workspace.testRuntime(runtime.id);
      setStatus({
        kind: "success",
        message: `连接成功 · ${result.latencyMs} ms`,
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal open={props.open} title="运行节点" width="large" onClose={props.onClose}>
      <div className="provider-layout">
        <aside className="provider-list" aria-label="运行节点列表">
          <button
            type="button"
            className="button button--secondary button--compact button--full"
            onClick={() => selectRuntime(null)}
          >
            <Plus size={14} />
            添加远端节点
          </button>
          <div className="provider-list-items">
            {runtimes.map((runtime) => (
              <button
                type="button"
                key={runtime.id}
                className={selectedId === runtime.id ? "is-selected" : ""}
                onClick={() => selectRuntime(runtime)}
              >
                <span className="provider-mark">
                  {runtime.kind === "local" ? <Laptop size={15} /> : <Cloud size={15} />}
                </span>
                <span>
                  <strong>{runtime.name}</strong>
                  <small>
                    {runtime.kind === "local"
                      ? "本机"
                      : runtime.status === "online"
                        ? "已连接"
                        : runtime.status === "offline"
                          ? "离线"
                          : "未验证"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {selected?.kind === "local" ? (
          <section className="provider-form runtime-local-panel">
            <div className="section-title-row">
              <div>
                <h3>{selected.name}</h3>
                <span>本机 Runtime</span>
              </div>
              <span className="runtime-badge">在线</span>
            </div>
            <RuntimeCapabilities runtime={selected} />
          </section>
        ) : (
          <form
            className="provider-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveOnly();
            }}
          >
            <label>
              <span>节点名称</span>
              <input
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：海外常驻节点"
                required
              />
            </label>
            <label>
              <span>Runtime URL</span>
              <input
                value={baseUrl}
                maxLength={4096}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://runtime.example.com"
                inputMode="url"
                required
              />
            </label>
            <label>
              <span>访问令牌</span>
              <input
                type="password"
                value={credential}
                maxLength={16384}
                onChange={(event) => setCredential(event.target.value)}
                placeholder={selected?.hasCredential ? "已保存，留空则保持不变" : "输入访问令牌"}
                autoComplete="off"
              />
            </label>

            {selected?.kind === "remote" && <RuntimeCapabilities runtime={selected} />}

            <footer className="provider-form-footer">
              <div
                className={`form-status ${
                  status?.kind === "success"
                    ? "form-status--success"
                    : status?.kind === "error"
                      ? "form-status--error"
                      : ""
                }`}
                role={status?.kind === "error" ? "alert" : "status"}
              >
                {status?.kind === "success" && <Check size={14} />}
                {status?.kind === "error" && <CircleAlert size={14} />}
                <span>{status?.message ?? ""}</span>
              </div>
              <div>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={saving || testing}
                  onClick={() => void testConnection()}
                >
                  {testing ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}
                  测试连接
                </button>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={saving || testing || !name.trim() || !baseUrl.trim()}
                >
                  {saving && <LoaderCircle size={14} className="spin" />}
                  保存
                </button>
              </div>
            </footer>
          </form>
        )}
      </div>
    </Modal>
  );
}

function RuntimeCapabilities(props: { runtime: RuntimeNode }): JSX.Element {
  const capabilities = [
    ["原生 Agent", props.runtime.capabilities.nativeAgents],
    ["持久任务", props.runtime.capabilities.persistentRuns],
    ["文件工具", props.runtime.capabilities.fileTools],
    ["命令工具", props.runtime.capabilities.commandTools],
  ] as const;
  return (
    <div className="runtime-capabilities" aria-label="节点能力">
      {capabilities.map(([label, enabled]) => (
        <span key={label} className={enabled ? "is-enabled" : ""}>
          <Server size={13} />
          {label}
        </span>
      ))}
    </div>
  );
}
