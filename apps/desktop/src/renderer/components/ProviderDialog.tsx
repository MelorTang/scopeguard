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

import type { ProviderProfile } from "@scopeguard/domain";
import type { SaveProviderProfileRequest } from "@scopeguard/ipc-contracts";

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
      setStatus({ kind: "error", message: request.error ?? "Invalid settings." });
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
          message: `${result.message} ${result.latencyMs} ms`,
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
      setStatus({ kind: "error", message: request.error ?? "Invalid settings." });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const saved = await props.workspace.saveProvider(request.value);
      setCreatingNew(false);
      setForm(fromProvider(saved));
      setStatus({ kind: "success", message: "Provider saved." });
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
      title="Providers"
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
            Add provider
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
                {provider.apiKeyRef && <KeyRound size={13} />}
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
              <span>Name</span>
              <input
                value={form.name}
                maxLength={200}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Company relay"
                required
              />
            </label>
            <fieldset className="form-fieldset">
              <legend>Protocol</legend>
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
                  OpenAI-compatible
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
                  Anthropic-compatible
                </button>
              </div>
            </fieldset>
          </div>
          <label>
            <span>Base URL</span>
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
              <span>Model</span>
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
                placeholder={form.id ? "Keep existing key" : "Optional for local endpoints"}
                autoComplete="off"
              />
            </label>
          </div>
          {form.id && providers.find((provider) => provider.id === form.id)?.apiKeyRef && (
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
              <span>Remove saved API key when saving</span>
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
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={saving || testing}
              >
                <Save size={15} />
                {saving ? "Saving…" : "Save provider"}
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

function fromProvider(provider: ProviderProfile): ProviderForm {
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
