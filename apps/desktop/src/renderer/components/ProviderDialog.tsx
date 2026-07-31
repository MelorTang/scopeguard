import {
  Check,
  CircleAlert,
  KeyRound,
  Network,
  Plus,
  Save,
  TestTube2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ProviderProfileView,
  SaveProviderProfileRequest,
} from "@scopeguard/ipc-contracts";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

type ProviderForm = {
  id?: string;
  name: string;
  protocol: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
  clearApiKey: boolean;
};

const EMPTY_FORM: ProviderForm = {
  name: "",
  protocol: "openai-compatible",
  baseUrl: "",
  defaultModel: "",
  apiKey: "",
  clearApiKey: false,
};

export function ProviderDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  onClose: () => void;
}): JSX.Element | null {
  const providers = props.workspace.snapshot?.providerProfiles ?? [];
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [status, setStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const formRevision = useRef(0);

  useEffect(() => {
    if (props.open && providers.length > 0 && !form.id && !creatingNew) {
      setForm(fromProvider(providers[0]!));
    }
    if (!props.open) {
      setStatus(null);
    }
  }, [props.open, providers, form.id, creatingNew]);

  const request = useMemo(() => ({
    value: {
      id: form.id,
      name: form.name,
      protocol: form.protocol,
      baseUrl: form.baseUrl,
      defaultModel: form.defaultModel,
      apiKey: form.apiKey || undefined,
      clearApiKey: form.clearApiKey || undefined,
      customHeaders: {},
    } satisfies SaveProviderProfileRequest,
    error: null,
  }), [form]);

  const updateForm = (
    update: (current: ProviderForm) => ProviderForm,
  ) => {
    formRevision.current += 1;
    setForm(update);
    setStatus(null);
  };

  const testConnection = async () => {
    if (!request.value) {
      setStatus({ kind: "error", message: request.error ?? "配置无效。" });
      return;
    }
    setTesting(true);
    setStatus(null);
    const testedRevision = formRevision.current;
    try {
      const result = await props.workspace.testProvider(request.value);
      if (testedRevision === formRevision.current) {
        setStatus({
          kind: "success",
          message: `连接成功，延迟 ${result.latencyMs} 毫秒。`,
        });
      }
    } catch (error) {
      if (testedRevision === formRevision.current) {
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!request.value) {
      setStatus({ kind: "error", message: request.error ?? "配置无效。" });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const saved = await props.workspace.saveProvider(request.value);
      setCreatingNew(false);
      setForm(fromProvider(saved));
      setStatus({ kind: "success", message: "模型服务已保存。" });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    formRevision.current += 1;
    setForm((current) => ({ ...current, apiKey: "" }));
    setStatus(null);
    props.onClose();
  };

  return (
    <Modal
      open={props.open}
      title="模型服务"
      width="large"
      onClose={close}
    >
      <div className="provider-layout">
        <aside className="provider-list">
          <button
            type="button"
            className="button button--secondary button--full"
            onClick={() => {
              formRevision.current += 1;
              setCreatingNew(true);
              setForm({ ...EMPTY_FORM });
              setStatus(null);
            }}
          >
            <Plus size={15} />
            添加模型服务
          </button>
          <div className="provider-list-items">
            {providers.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={provider.id === form.id ? "is-selected" : ""}
                onClick={() => {
                  formRevision.current += 1;
                  setCreatingNew(false);
                  setForm(fromProvider(provider));
                  setStatus(null);
                }}
              >
                <span className="provider-mark">
                  <Network size={15} />
                </span>
                <span>
                  <strong>{provider.name}</strong>
                  <small>{provider.defaultModel}</small>
                </span>
                {provider.hasApiKey && <KeyRound size={13} />}
              </button>
            ))}
          </div>
        </aside>

        <form
          className="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="form-grid form-grid--two">
            <label>
              <span>服务名称</span>
              <input
                value={form.name}
                maxLength={200}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="公司中转服务"
                required
              />
            </label>
            <fieldset className="form-fieldset">
              <legend>接口协议</legend>
              <div className="segmented-control">
                <button
                  type="button"
                  className={
                    form.protocol === "openai-compatible" ? "is-active" : ""
                  }
                  onClick={() =>
                    updateForm((current) => ({
                      ...current,
                      protocol: "openai-compatible",
                    }))
                  }
                >
                  OpenAI 兼容
                </button>
                <button
                  type="button"
                  className={
                    form.protocol === "anthropic-compatible" ? "is-active" : ""
                  }
                  onClick={() =>
                    updateForm((current) => ({
                      ...current,
                      protocol: "anthropic-compatible",
                    }))
                  }
                >
                  Anthropic 兼容
                </button>
              </div>
            </fieldset>
          </div>
          <label>
            <span>接口地址</span>
            <input
              type="url"
              value={form.baseUrl}
              maxLength={4096}
              onChange={(event) =>
                updateForm((current) => ({
                  ...current,
                  baseUrl: event.target.value,
                }))
              }
              placeholder="https://relay.example.com/v1"
              required
            />
          </label>
          <div className="form-grid form-grid--two">
            <label>
              <span>模型</span>
              <input
                value={form.defaultModel}
                maxLength={512}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    defaultModel: event.target.value,
                  }))
                }
                placeholder="model-name"
                required
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                maxLength={16_384}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    apiKey: event.target.value,
                    clearApiKey: false,
                  }))
                }
                placeholder={
                  form.id ? "留空则保留现有 Key" : "本地接口可以留空"
                }
                autoComplete="off"
              />
            </label>
          </div>
          {form.id && providers.find((provider) => provider.id === form.id)?.hasApiKey && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={form.clearApiKey}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    clearApiKey: event.target.checked,
                    apiKey: event.target.checked ? "" : current.apiKey,
                  }))
                }
              />
              <span>保存时删除现有 API Key</span>
            </label>
          )}

          <div className="provider-form-footer">
            <StatusNotice status={status} />
            <div>
              <button
                type="button"
                className="button button--secondary"
                disabled={testing || saving}
                onClick={() => void testConnection()}
              >
                <TestTube2 size={15} />
                {testing ? "正在测试…" : "测试连接"}
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={saving || testing}
              >
                <Save size={15} />
                {saving ? "正在保存…" : "保存模型服务"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function StatusNotice(props: {
  status: { kind: "success" | "error"; message: string } | null;
}): JSX.Element {
  if (!props.status) {
    return <span />;
  }
  return (
    <span className={`form-status form-status--${props.status.kind}`} role="status">
      {props.status.kind === "success"
        ? <Check size={14} />
        : <CircleAlert size={14} />}
      {props.status.message}
    </span>
  );
}

function fromProvider(provider: ProviderProfileView): ProviderForm {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKey: "",
    clearApiKey: false,
  };
}
