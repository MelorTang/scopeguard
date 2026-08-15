import {
  Bot,
  Braces,
  FileText,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  AgentToolPolicy,
  ConversationExecutionProfile,
  ToolPermission,
} from "@scopeguard/domain";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

const TEMPLATES = [
  {
    id: "general",
    name: "通用",
    icon: Sparkles,
    instructions:
      "谨慎处理用户请求，使用可用的工作区上下文，并报告具体结果。",
  },
  {
    id: "verification",
    name: "核验",
    icon: ShieldCheck,
    instructions:
      "核验已共享结论与来源，明确事实、疑点和证据缺口，不读取其他 Agent 的私有对话。",
  },
  {
    id: "research",
    name: "调研",
    icon: Search,
    instructions:
      "调查用户提出的问题，区分证据与假设，并给出有来源支持的简洁结论。",
  },
  {
    id: "documents",
    name: "文档",
    icon: FileText,
    instructions:
      "使用工作区术语和已确认事实，创建并修订清晰的业务文档。",
  },
  {
    id: "developer",
    name: "开发",
    icon: Braces,
    instructions:
      "编辑前先检查代码库，控制改动范围，执行相关验证，并报告剩余风险。",
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
  const [name, setName] = useState("通用");
  const [title, setTitle] = useState("首次对话");
  const [instructions, setInstructions] = useState<string>(
    TEMPLATES[0].instructions,
  );
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [modelOverride, setModelOverride] = useState("");
  const [policy, setPolicy] = useState<AgentToolPolicy>(DEFAULT_TOOL_POLICY);
  const [executionProfile, setExecutionProfile] =
    useState<ConversationExecutionProfile>("request-approval");
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
    setName("通用");
    setTitle("首次对话");
    setInstructions(TEMPLATES[0].instructions);
    setProviderId(providers[0]?.id ?? "");
    setModelOverride("");
    setPolicy({ ...DEFAULT_TOOL_POLICY });
    setExecutionProfile("request-approval");
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
    setTitle(`${template.name}对话`);
  };

  const create = async () => {
    if (!providerId) {
      props.onNeedProvider();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await props.workspace.createAgentThread(
        {
          name,
          runtimeKind: "native",
          instructions,
          providerProfileId: providerId,
          modelOverride: modelOverride.trim() || null,
          executionProfile,
          toolPolicy: policy,
          cliConfig: null,
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
      title="新建 Agent"
      width="large"
      onClose={props.onClose}
    >
      <div className="agent-dialog-layout">
        <aside className="template-list" aria-label="Agent 模板">
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
              <span>Agent 名称</span>
              <input
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              <span>首个对话</span>
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
            <summary>技术设置</summary>
            <div className="advanced-fields__content">
              <div className="form-grid form-grid--two">
                <label>
                  <span>模型服务</span>
                  <select
                    value={providerId}
                    onChange={(event) => setProviderId(event.target.value)}
                    required
                  >
                    <option value="" disabled>请选择模型服务</option>
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.name} · {provider.defaultModel}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>指定模型</span>
                  <input
                    value={modelOverride}
                    maxLength={512}
                    onChange={(event) => setModelOverride(event.target.value)}
                    placeholder="使用服务默认模型"
                  />
                </label>
              </div>

              <label>
                <span>系统指令</span>
                <textarea
                  rows={5}
                  maxLength={50_000}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>

              <fieldset className="form-fieldset">
                  <legend>执行权限</legend>
                  <div className="segmented-control segmented-control--three">
                    <button
                      type="button"
                      className={
                        executionProfile === "request-approval" ? "is-active" : ""
                      }
                      onClick={() => setExecutionProfile("request-approval")}
                    >
                      请求批准
                    </button>
                    <button
                      type="button"
                      className={
                        executionProfile === "auto-approve" ? "is-active" : ""
                      }
                      onClick={() => setExecutionProfile("auto-approve")}
                    >
                      自动审批
                    </button>
                    <button
                      type="button"
                      className={
                        executionProfile === "full-access" ? "is-active" : ""
                      }
                      onClick={() => setExecutionProfile("full-access")}
                    >
                      完全访问
                    </button>
                  </div>
              </fieldset>

              <fieldset className="permission-fields">
                  <legend>工具权限</legend>
                  <PermissionSelect
                    label="读取文件"
                    value={policy.readFiles}
                    onChange={(readFiles) =>
                      setPolicy((current) => ({ ...current, readFiles }))
                    }
                  />
                  <PermissionSelect
                    label="写入文件"
                    value={policy.writeFiles}
                    onChange={(writeFiles) =>
                      setPolicy((current) => ({ ...current, writeFiles }))
                    }
                  />
                  <PermissionSelect
                    label="运行命令"
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
              内置 Agent
            </span>
            <button
              type="submit"
              className="button button--primary"
              disabled={creating || !props.workspace.selectedWorkspace}
            >
              <Plus size={15} />
              {creating ? "正在创建…" : "创建 Agent"}
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
        <option value="allow">允许</option>
        <option value="ask">每次询问</option>
        <option value="deny">拒绝</option>
      </select>
    </label>
  );
}
