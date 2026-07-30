import {
  Bot,
  Braces,
  FileText,
  Plus,
  Search,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  AgentRuntimeKind,
  AgentToolPolicy,
  ToolPermission,
} from "@scopeguard/domain";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

const TEMPLATES = [
  {
    id: "general",
    name: "General",
    icon: Sparkles,
    instructions:
      "Handle the requested work carefully, use available project context, and report concrete results.",
  },
  {
    id: "research",
    name: "Research",
    icon: Search,
    instructions:
      "Investigate the request, distinguish evidence from assumptions, and produce a concise source-backed conclusion.",
  },
  {
    id: "documents",
    name: "Documents",
    icon: FileText,
    instructions:
      "Create and revise clear business documents using the project's terminology and reviewed facts.",
  },
  {
    id: "developer",
    name: "Developer",
    icon: Braces,
    instructions:
      "Inspect the codebase before editing, keep changes scoped, run relevant verification, and report remaining risks.",
  },
] as const;

const DEFAULT_TOOL_POLICY: AgentToolPolicy = {
  readFiles: "allow",
  writeFiles: "ask",
  runCommands: "ask",
};

export function AgentDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  onClose: () => void;
  onNeedProvider: () => void;
}): JSX.Element | null {
  const providers = props.workspace.snapshot?.providerProfiles ?? [];
  const [templateId, setTemplateId] = useState("general");
  const [name, setName] = useState("General");
  const [title, setTitle] = useState("New conversation");
  const [instructions, setInstructions] = useState<string>(
    TEMPLATES[0].instructions,
  );
  const [runtimeKind, setRuntimeKind] = useState<AgentRuntimeKind>("native");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [modelOverride, setModelOverride] = useState("");
  const [cliCommand, setCliCommand] = useState("");
  const [cliArgs, setCliArgs] = useState("{prompt}");
  const [policy, setPolicy] = useState<AgentToolPolicy>(DEFAULT_TOOL_POLICY);
  const [technicalOpen, setTechnicalOpen] = useState(
    props.workspace.professionalMode,
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setTemplateId("general");
    setName("General");
    setTitle("New conversation");
    setInstructions(TEMPLATES[0].instructions);
    setRuntimeKind("native");
    setProviderId(providers[0]?.id ?? "");
    setModelOverride("");
    setCliCommand("");
    setCliArgs("{prompt}");
    setPolicy({ ...DEFAULT_TOOL_POLICY });
    setTechnicalOpen(props.workspace.professionalMode);
    setError(null);
  }, [props.open, props.workspace.professionalMode]);

  useEffect(() => {
    if (props.open && !providerId && providers[0]) {
      setProviderId(providers[0].id);
    }
  }, [props.open, providerId, providers]);

  const selectTemplate = (id: string) => {
    const template = TEMPLATES.find((item) => item.id === id) ?? TEMPLATES[0];
    setTemplateId(template.id);
    setName(template.name);
    setInstructions(template.instructions);
    setTitle(`${template.name} conversation`);
  };

  const create = async () => {
    if (runtimeKind === "native" && !providerId) {
      props.onNeedProvider();
      return;
    }
    if (runtimeKind === "local-cli" && !cliCommand.trim()) {
      setTechnicalOpen(true);
      setError("Enter the Local CLI command.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await props.workspace.createAgentThread(
        {
          name,
          runtimeKind,
          instructions,
          providerProfileId: runtimeKind === "native" ? providerId : null,
          modelOverride:
            runtimeKind === "native" ? modelOverride.trim() || null : null,
          toolPolicy: policy,
          cliConfig: runtimeKind === "local-cli"
            ? {
                command: cliCommand.trim(),
                args: cliArgs
                  .split(/\r?\n/)
                  .map((argument) => argument.trim())
                  .filter(Boolean),
                cwd: null,
                env: {},
              }
            : null,
        },
        title,
      );
      props.onClose();
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : String(createError),
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title="New Agent"
      width="large"
      onClose={props.onClose}
    >
      <div className="agent-dialog-layout">
        <aside className="template-list" aria-label="Agent templates">
          {TEMPLATES.map((template) => {
            const Icon = template.icon;
            return (
              <button
                type="button"
                key={template.id}
                className={templateId === template.id ? "is-selected" : ""}
                onClick={() => selectTemplate(template.id)}
              >
                <span><Icon size={16} /></span>
                <strong>{template.name}</strong>
              </button>
            );
          })}
        </aside>

        <form
          className="agent-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="form-grid form-grid--two">
            <label>
              <span>Agent name</span>
              <input
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              <span>Thread title</span>
              <input
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            </label>
          </div>
          <details
            className="advanced-fields"
            open={technicalOpen}
            onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
          >
            <summary>Technical details</summary>
            <div className="advanced-fields__content">
              <fieldset className="form-fieldset">
                <legend>Runtime</legend>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={runtimeKind === "native" ? "is-active" : ""}
                    onClick={() => {
                      setRuntimeKind("native");
                      setError(null);
                    }}
                  >
                    <Bot size={14} />
                    Native API
                  </button>
                  <button
                    type="button"
                    className={runtimeKind === "local-cli" ? "is-active" : ""}
                    onClick={() => {
                      setRuntimeKind("local-cli");
                      setError(null);
                    }}
                  >
                    <Terminal size={14} />
                    Local CLI
                  </button>
                </div>
              </fieldset>

              {runtimeKind === "native" ? (
                <div className="form-grid form-grid--two">
                  <label>
                    <span>Provider</span>
                    <select
                      value={providerId}
                      onChange={(event) => setProviderId(event.target.value)}
                      required
                    >
                      <option value="" disabled>Select a provider</option>
                      {providers.map((provider) => (
                        <option value={provider.id} key={provider.id}>
                          {provider.name} · {provider.defaultModel}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Model override</span>
                    <input
                      value={modelOverride}
                      maxLength={512}
                      onChange={(event) => setModelOverride(event.target.value)}
                      placeholder="Use provider default"
                    />
                  </label>
                </div>
              ) : (
                <>
                  <label>
                    <span>Command</span>
                    <input
                      value={cliCommand}
                      maxLength={4096}
                      onChange={(event) => setCliCommand(event.target.value)}
                      placeholder="codex"
                      required
                    />
                  </label>
                  <label>
                    <span>Arguments · one per line</span>
                    <textarea
                      rows={4}
                      maxLength={65_536}
                      value={cliArgs}
                      onChange={(event) => setCliArgs(event.target.value)}
                      placeholder={"exec\n{prompt}\n--cd\n{projectRoot}"}
                    />
                    <small className="field-help">
                      Supports {"{prompt}"} and {"{projectRoot}"}. If prompt is
                      omitted, it is sent through stdin.
                    </small>
                  </label>
                </>
              )}

              <label>
                <span>Instructions</span>
                <textarea
                  rows={5}
                  maxLength={50_000}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>

              <fieldset className="permission-fields">
                <legend>Tool permissions</legend>
                <PermissionSelect
                  label="Read files"
                  value={policy.readFiles}
                  onChange={(readFiles) =>
                    setPolicy((current) => ({ ...current, readFiles }))
                  }
                />
                <PermissionSelect
                  label="Write files"
                  value={policy.writeFiles}
                  onChange={(writeFiles) =>
                    setPolicy((current) => ({ ...current, writeFiles }))
                  }
                />
                <PermissionSelect
                  label="Run commands"
                  value={policy.runCommands}
                  onChange={(runCommands) =>
                    setPolicy((current) => ({ ...current, runCommands }))
                  }
                />
              </fieldset>
            </div>
          </details>

          {error && <div className="form-error">{error}</div>}
          <footer className="agent-form-footer">
            <span className="runtime-label">
              <Bot size={14} />
              {runtimeKind === "native" ? "Native API Agent" : "Local CLI Agent"}
            </span>
            <button
              type="submit"
              className="button button--primary"
              disabled={creating || !props.workspace.selectedProject}
            >
              <Plus size={15} />
              {creating ? "Creating…" : "Create Agent"}
            </button>
          </footer>
        </form>
      </div>
    </Modal>
  );
}

function PermissionSelect(props: {
  label: string;
  value: ToolPermission;
  onChange: (value: ToolPermission) => void;
}): JSX.Element {
  return (
    <label>
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as ToolPermission)}
      >
        <option value="allow">Allow</option>
        <option value="ask">Ask every time</option>
        <option value="deny">Deny</option>
      </select>
    </label>
  );
}
