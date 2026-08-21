import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  ListTodo,
  Play,
  Plus,
  RotateCcw,
  Send,
  Share2,
  ShieldCheck,
  Square,
  Terminal,
  Unlock,
  X,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  Conversation,
  Dispatch,
  ApprovalDecision,
  ConversationExecutionProfile,
  MessageContentBlock,
  PendingApprovalItem,
  ConversationMessage,
} from "@scopeguard/domain";
import type { WorkspaceFileSelection } from "@scopeguard/ipc-contracts";

import type { WorkspaceController } from "../useWorkspace.js";
import { formatRunStatus, formatToolName } from "../uiText.js";
import { MarkdownText } from "./MarkdownText.js";

export function ThreadPane(props: {
  thread: Conversation;
  workspace: WorkspaceController;
  paneIndex: number;
  active: boolean;
  onActivate: () => void;
  onClose?: () => void;
  ariaLabel?: string;
  variant?: "workbench" | "artifact-review";
}): JSX.Element {
  const { thread, workspace } = props;
  const snapshot = workspace.snapshot;
  const agent = snapshot?.agents.find(
    (profile) => profile.id === thread.agentId,
  );
  const provider = snapshot?.providerProfiles.find(
    (profile) => profile.id === agent?.providerProfileId,
  );
  const run = workspace.getRunForThread(thread.id);
  const waitingForInput = run?.status === "waiting-input";
  const latestRun = workspace.getLatestRunForThread(thread.id);
  const messages = workspace.messagesByThread[thread.id] ?? [];
  const stream = workspace.streamingByThread[thread.id] ?? "";
  const toolResults = useMemo(() => {
    const map = new Map<
      string,
      Extract<MessageContentBlock, { type: "tool-result" }>
    >();
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === "tool-result") {
          map.set(block.toolCallId, block);
        }
      }
    }
    return map;
  }, [messages]);
  const toolCallIds = useMemo(() => {
    const set = new Set<string>();
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === "tool-call") {
          set.add(block.toolCallId);
        }
      }
    }
    return set;
  }, [messages]);
  const approvals = snapshot?.pendingApprovals.filter(
    (item) => item.approval.runId === run?.id,
  ) ?? [];
  const approvalFocus = workspace.approvalFocus?.conversationId === thread.id
    ? workspace.approvalFocus
    : null;
  const focusedApprovalAvailable = Boolean(
    approvalFocus &&
    approvals.some((item) => item.approval.id === approvalFocus.approvalId),
  );
  const [draft, setDraft] = useState(
    () => localStorage.getItem(`scopeguard.draft.${thread.id}`) ?? "",
  );
  const [sending, setSending] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const [attachments, setAttachments] = useState<WorkspaceFileSelection[]>([]);
  const [openMenu, setOpenMenu] = useState<"access" | "model" | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const currentModel = thread.modelOverride ?? provider?.defaultModel ?? "未配置模型";
  const settingsDisabled = Boolean(run) || sending || settingsBusy;
  const canAddWorkspaceFiles = Boolean(
    workspace.selectedWorkspace?.localRootPath && !run && !sending,
  );

  const updateDraft = (value: string) => {
    setDraft(value);
    const storageKey = `scopeguard.draft.${thread.id}`;
    if (value) {
      localStorage.setItem(storageKey, value);
    } else {
      localStorage.removeItem(storageKey);
    }
  };

  useEffect(() => {
    const element = conversationRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < 180 || stream) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, stream, approvals]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!approvalFocus || !focusedApprovalAvailable || !conversation) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(
        `approval-${approvalFocus.approvalId}`,
      );
      if (!card) {
        return;
      }
      const cardBox = card.getBoundingClientRect();
      const conversationBox = conversation.getBoundingClientRect();
      const centeredTop =
        conversation.scrollTop +
        cardBox.top -
        conversationBox.top -
        Math.max(0, (conversation.clientHeight - cardBox.height) / 2);
      conversation.scrollTop = Math.max(0, centeredTop);
      card?.querySelector<HTMLButtonElement>("button")?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    approvalFocus?.approvalId,
    approvalFocus?.sequence,
    focusedApprovalAvailable,
  ]);

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [openMenu]);

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || (run && !waitingForInput) || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await workspace.sendMessage(
        thread.id,
        appendWorkspaceFileReferences(prompt, attachments),
      );
      updateDraft("");
      setAttachments([]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  };

  const updateSettings = async (
    input: {
      modelOverride?: string | null;
      executionProfile?: ConversationExecutionProfile;
    },
  ) => {
    setSettingsBusy(true);
    setError(null);
    try {
      await workspace.updateConversationSettings({ conversationId: thread.id, ...input });
      setOpenMenu(null);
    } catch (settingsError) {
      setError(
        settingsError instanceof Error ? settingsError.message : String(settingsError),
      );
    } finally {
      setSettingsBusy(false);
    }
  };

  const addWorkspaceFiles = async () => {
    setOpenMenu(null);
    setAddingFiles(true);
    setError(null);
    try {
      const selected = await workspace.chooseWorkspaceFiles();
      if (selected.length > 0) {
        setAttachments((current) => deduplicateWorkspaceFiles([
          ...current,
          ...selected,
        ]));
      }
    } catch (selectionError) {
      setError(
        selectionError instanceof Error ? selectionError.message : String(selectionError),
      );
    } finally {
      setAddingFiles(false);
    }
  };

  return (
    <section
      id={`thread-panel-${thread.id}`}
      className={`thread-pane ${
        props.variant === "artifact-review" ? "thread-pane--artifact-review" : ""
      } ${props.active ? "is-active" : ""} ${
        messages.length === 0 && !stream ? "thread-pane--empty" : ""
      }`}
      role="region"
      aria-label={props.ariaLabel ?? `${thread.title}，第 ${props.paneIndex + 1} 个窗格`}
      onPointerDownCapture={props.onActivate}
      onFocusCapture={props.onActivate}
    >
      <header className="thread-pane-header">
        <div className="agent-avatar" aria-hidden="true">
          <ListTodo size={16} />
        </div>
        <div className="thread-pane-heading">
          <strong>{thread.title}</strong>
          <span>
            {agent?.name ?? "Agent"}
            {workspace.professionalMode && provider
              ? ` · 本机 · ${agent?.modelOverride ?? provider.defaultModel}`
              : ""}
          </span>
        </div>
        <RunState status={run?.status ?? null} />
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={() => setHandoffOpen((current) => !current)}
          aria-label="Handoff 与 Agent Dispatch"
          title="Handoff 与 Agent Dispatch"
        >
          <Share2 size={14} />
        </button>
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={props.onClose ?? (() => workspace.closePane(thread.id))}
          aria-label={`关闭 ${thread.title} 窗格`}
          title="关闭窗格"
        >
          <X size={14} />
        </button>
      </header>

      <div className="conversation" ref={conversationRef}>
        {messages.length === 0 && !stream ? (
          <div className="thread-empty">
            <Bot size={22} />
            <strong>{agent?.name ?? "Agent"}</strong>
            <span>输入任务要求，Agent 的工作只进入当前上下文。</span>
          </div>
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              showTechnicalDetails={workspace.professionalMode}
              toolResults={toolResults}
              toolCallIds={toolCallIds}
            />
          ))
        )}
        {stream && (
          <div className="message message--assistant message--streaming">
            <div className="message-text">{stream}</div>
            <span className="stream-caret" aria-hidden="true" />
          </div>
        )}
        {approvals.map((item) => (
          <ApprovalCard
            key={item.approval.id}
            item={item}
            onDecision={(decision) =>
              workspace.resolveApproval(item.approval.id, decision)
            }
          />
        ))}
        {(snapshot?.dispatches ?? [])
          .filter((dispatch) =>
            dispatch.sourceConversationId === thread.id ||
            dispatch.targetConversationId === thread.id
          )
          .map((dispatch) => (
            <DispatchCard
              key={dispatch.id}
              dispatch={dispatch}
              currentConversationId={thread.id}
              conversations={snapshot?.conversations ?? []}
            />
          ))}
        <div className="sr-only" aria-live="polite">
          {run ? `Agent 状态：${formatRunStatus(run.status)}` : "Agent 空闲"}
        </div>
      </div>

      <footer className="composer-area">
        {handoffOpen && (
          <HandoffPanel
            source={thread}
            workspace={workspace}
            onClose={() => setHandoffOpen(false)}
          />
        )}
        {messages.length === 0 && !stream && !run && (
          <div className="composer-greeting">
            <strong>{agent?.name ?? "Agent"}</strong>
            <span>输入任务要求，Agent 的工作只进入当前上下文。</span>
          </div>
        )}
        {!run && latestRun && (
          latestRun.status === "failed" || latestRun.status === "interrupted"
        ) && (
          <div className={`run-recovery run-recovery--${latestRun.status}`}>
            <CircleAlert size={15} />
            <span>
              <strong>
                {latestRun.status === "interrupted"
                  ? "运行已中断"
                  : "运行失败"}
              </strong>
              {latestRun.error ?? "本次运行未能完成。"}
            </span>
            <button
              type="button"
              className="button button--secondary button--compact"
              onClick={() => {
                setError(null);
                void workspace.retryThread(thread.id).catch((retryError: unknown) => {
                  setError(
                    retryError instanceof Error
                      ? retryError.message
                      : String(retryError),
                  );
                });
              }}
            >
              <RotateCcw size={14} />
              重试
            </button>
          </div>
        )}
        {error && (
          <div className="inline-error">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button
              type="button"
              className="icon-button icon-button--small"
              onClick={() => setError(null)}
              aria-label="关闭错误提示"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div
          className={`composer ${run && !waitingForInput ? "composer--disabled" : ""}`}
          ref={composerRef}
        >
          {attachments.length > 0 && (
            <div className="composer-attachments" aria-label="已添加的 Workspace 文件">
              {attachments.map((file) => (
                <span className="composer-attachment" key={file.relativePath}>
                  <FileText size={13} />
                  <span title={file.relativePath}>{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((current) =>
                      current.filter((item) => item.relativePath !== file.relativePath)
                    )}
                    aria-label={`移除 ${file.name}`}
                    title="移除文件"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            rows={1}
            maxLength={100_000}
            placeholder={
              waitingForInput
                ? "补充 Agent 继续任务所需的信息"
                : run
                ? "Agent 正在处理…"
                : `向 ${agent?.name ?? "Agent"} 补充任务要求`
            }
            disabled={Boolean(run && !waitingForInput)}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            aria-label={`发送消息给 ${agent?.name ?? "Agent"}`}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar__group">
              <button
                type="button"
                className="composer-icon-button"
                disabled={!canAddWorkspaceFiles || addingFiles}
                onClick={() => void addWorkspaceFiles()}
                aria-label="添加 Workspace 文件"
                title={canAddWorkspaceFiles
                  ? "添加 Workspace 文件"
                  : "当前 Workspace 没有本地文件夹"}
              >
                <Plus size={17} />
              </button>
              <div className="composer-control-wrap">
                <button
                  type="button"
                  className={`composer-text-button composer-access-button composer-access-button--${thread.executionProfile}`}
                  disabled={settingsDisabled}
                  onClick={() => setOpenMenu((current) =>
                    current === "access" ? null : "access"
                  )}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "access"}
                  title="Conversation 执行权限"
                >
                  {executionProfileIcon(thread.executionProfile)}
                  <span>{executionProfileLabel(thread.executionProfile)}</span>
                  <ChevronDown size={13} />
                </button>
                {openMenu === "access" && (
                  <div className="composer-menu composer-menu--access" role="menu">
                    <strong>执行权限</strong>
                    {EXECUTION_PROFILE_OPTIONS.map((option) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={thread.executionProfile === option.value}
                        className={thread.executionProfile === option.value ? "is-selected" : ""}
                        key={option.value}
                        onClick={() => void updateSettings({
                          executionProfile: option.value,
                        })}
                      >
                        <span className="composer-menu__icon">
                          {executionProfileIcon(option.value)}
                        </span>
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                        {thread.executionProfile === option.value && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="composer-toolbar__group composer-toolbar__group--right">
              <div className="composer-control-wrap composer-control-wrap--model">
                <button
                  type="button"
                  className="composer-text-button composer-model-button"
                  disabled={settingsDisabled || !provider}
                  onClick={() => {
                    setModelDraft(currentModel);
                    setOpenMenu((current) => current === "model" ? null : "model");
                  }}
                  aria-haspopup="dialog"
                  aria-expanded={openMenu === "model"}
                  title={`模型：${currentModel}`}
                >
                  <span>{currentModel}</span>
                  <ChevronDown size={13} />
                </button>
                {openMenu === "model" && provider && (
                  <div className="composer-menu composer-menu--model" role="dialog" aria-label="选择模型">
                    <strong>模型</strong>
                    <button
                      type="button"
                      className={!thread.modelOverride ? "is-selected" : ""}
                      onClick={() => void updateSettings({ modelOverride: null })}
                    >
                      <span>
                        <strong>{provider.defaultModel}</strong>
                        <small>{provider.name} 默认模型</small>
                      </span>
                      {!thread.modelOverride && <Check size={14} />}
                    </button>
                    <form
                      className="composer-model-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateSettings({ modelOverride: modelDraft });
                      }}
                    >
                      <label htmlFor={`model-${thread.id}`}>指定兼容模型</label>
                      <div>
                        <input
                          id={`model-${thread.id}`}
                          value={modelDraft}
                          maxLength={512}
                          onChange={(event) => setModelDraft(event.target.value)}
                          placeholder={provider.defaultModel}
                        />
                        <button
                          type="submit"
                          className="button button--secondary button--compact"
                          disabled={!modelDraft.trim()}
                        >
                          应用
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
              {run && !waitingForInput ? (
                <button
                  type="button"
                  className="composer-send composer-send--stop"
                  onClick={() => void workspace.cancelRun(run.id)}
                  aria-label="停止运行"
                  title="停止运行"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  className="composer-send"
                  disabled={!draft.trim() || sending}
                  onClick={() => void send()}
                  aria-label="发送消息"
                  title="发送"
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
}

function HandoffPanel(props: {
  source: Conversation;
  workspace: WorkspaceController;
  onClose: () => void;
}): JSX.Element {
  const targets = props.workspace.snapshot?.conversations.filter(
    (conversation) =>
      conversation.workspaceId === props.source.workspaceId &&
      conversation.id !== props.source.id,
  ) ?? [];
  const [targetId, setTargetId] = useState("");
  const [workRequest, setWorkRequest] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    text: string;
    tone: "success" | "error";
  } | null>(null);
  const byteLength = new TextEncoder().encode(workRequest.trim()).byteLength;
  const valid = Boolean(targetId && workRequest.trim() && byteLength <= 16 * 1024);

  const generate = async (): Promise<string> => {
    const prompt = await props.workspace.generateHandoffPrompt(
      props.source.id,
      targetId,
      workRequest,
    );
    setGenerated(prompt.text);
    return prompt.text;
  };

  const generatePreview = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await generate();
      setFeedback({ text: "Handoff Prompt 已生成", tone: "success" });
    } catch (error) {
      setFeedback({
        text: `生成失败：${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const text = generated ?? await generate();
      await props.workspace.copyHandoffPrompt(text);
      setFeedback({ text: "已复制 Handoff Prompt", tone: "success" });
    } catch (error) {
      setFeedback({
        text: `复制失败：${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const dispatch = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await props.workspace.dispatchPrompt(
        props.source.id,
        targetId,
        workRequest,
      );
      setFeedback(result.status === "failed"
        ? { text: `Dispatch 失败：${result.error ?? "目标不可用"}`, tone: "error" }
        : { text: "Dispatch 已发送到目标 Conversation", tone: "success" });
    } catch (error) {
      setFeedback({
        text: `Dispatch 失败：${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="handoff-panel" aria-label="Handoff 与 Agent Dispatch">
      <header>
        <div>
          <strong>交接工作</strong>
          <span>复制 Prompt，或明确发送给另一个 Conversation</span>
        </div>
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={props.onClose}
          aria-label="关闭交接面板"
        >
          <X size={14} />
        </button>
      </header>
      <label>
        <span>目标 Conversation</span>
        <select value={targetId} onChange={(event) => {
          setTargetId(event.target.value);
          setGenerated(null);
          setFeedback(null);
        }}>
          <option value="" disabled>请选择目标 Conversation</option>
          {targets.map((target) => (
            <option value={target.id} key={target.id}>{target.title}</option>
          ))}
        </select>
      </label>
      <label>
        <span>工作请求</span>
        <textarea
          rows={3}
          value={workRequest}
          onChange={(event) => {
            setWorkRequest(event.target.value);
            setGenerated(null);
            setFeedback(null);
          }}
          placeholder="说明目标、输入和期望输出"
          aria-label="Handoff 工作请求"
        />
      </label>
      <div className={`handoff-limit ${byteLength > 16 * 1024 ? "is-error" : ""}`}>
        {byteLength.toLocaleString()} / 16,384 bytes
      </div>
      {generated && (
        <div className="handoff-preview">
          <span>Handoff Prompt</span>
          <button
            type="button"
            className="icon-button icon-button--small"
            onClick={() => void copy()}
            aria-label="复制 Handoff Prompt"
            title="复制"
          >
            <Copy size={14} />
          </button>
          <pre>{generated}</pre>
        </div>
      )}
      {feedback && (
        <div className={`handoff-feedback handoff-feedback--${feedback.tone}`} role="status">
          {feedback.text}
        </div>
      )}
      <footer>
        <button
          type="button"
          className="button button--secondary button--compact"
          disabled={!valid || busy}
          onClick={() => void generatePreview()}
        >
          生成 Prompt
        </button>
        <button
          type="button"
          className="button button--secondary button--compact"
          disabled={!valid || busy}
          onClick={() => void copy()}
        >
          <Copy size={14} />
          复制
        </button>
        <button
          type="button"
          className="button button--primary button--compact"
          disabled={!valid || busy}
          onClick={() => void dispatch()}
        >
          <Send size={14} />
          发送 Dispatch
        </button>
      </footer>
    </section>
  );
}

function DispatchCard(props: {
  dispatch: Dispatch;
  currentConversationId: string;
  conversations: Conversation[];
}): JSX.Element {
  const source = props.conversations.find(
    ({ id }) => id === props.dispatch.sourceConversationId,
  );
  const target = props.conversations.find(
    ({ id }) => id === props.dispatch.targetConversationId,
  );
  const isSource = props.currentConversationId === props.dispatch.sourceConversationId;
  return (
    <article className={`dispatch-card dispatch-card--${props.dispatch.status}`}>
      <header>
        <Share2 size={14} />
        <strong>Agent Dispatch</strong>
        <span>{dispatchStatusLabel(props.dispatch.status)}</span>
      </header>
      <p>{props.dispatch.prompt}</p>
      <footer>
        <span>{isSource ? "发送至" : "来自"}</span>
        <strong>{isSource ? target?.title : source?.title}</strong>
      </footer>
      {props.dispatch.error && (
        <div className="dispatch-card__error" role="alert">
          <CircleAlert size={13} />
          {props.dispatch.error}
        </div>
      )}
    </article>
  );
}

function dispatchStatusLabel(status: Dispatch["status"]): string {
  return {
    pending: "待发送",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  }[status];
}

const EXECUTION_PROFILE_OPTIONS: Array<{
  value: ConversationExecutionProfile;
  label: string;
  description: string;
}> = [
  {
    value: "request-approval",
    label: "请求批准",
    description: "敏感工具执行前由你确认。",
  },
  {
    value: "auto-approve",
    label: "自动审批",
    description: "按当前 Conversation 权限自动处理已允许的工具。",
  },
  {
    value: "full-access",
    label: "完全访问",
    description: "允许 Agent 使用当前系统用户授予的工作权限。",
  },
];

function executionProfileLabel(profile: ConversationExecutionProfile): string {
  return EXECUTION_PROFILE_OPTIONS.find((option) => option.value === profile)?.label
    ?? "请求批准";
}

function executionProfileIcon(
  profile: ConversationExecutionProfile,
): JSX.Element {
  if (profile === "auto-approve") {
    return <Zap size={14} />;
  }
  if (profile === "full-access") {
    return <Unlock size={14} />;
  }
  return <ShieldCheck size={14} />;
}

function deduplicateWorkspaceFiles(
  files: WorkspaceFileSelection[],
): WorkspaceFileSelection[] {
  return [...new Map(files.map((file) => [file.relativePath, file])).values()];
}

function appendWorkspaceFileReferences(
  prompt: string,
  files: WorkspaceFileSelection[],
): string {
  if (files.length === 0) {
    return prompt;
  }
  const references = files.map((file) => `- \`${file.relativePath}\``).join("\n");
  return `${prompt}\n\nWorkspace files:\n${references}`;
}

function Message(props: {
  message: ConversationMessage;
  showTechnicalDetails: boolean;
  toolResults: Map<string, Extract<MessageContentBlock, { type: "tool-result" }>>;
  toolCallIds: Set<string>;
}): JSX.Element | null {
  // Tool results with a matching call render inside that call's expandable
  // row, so a tool message may have nothing left to show on its own.
  const visibleBlocks = props.message.content.filter(
    (block) => block.type !== "tool-result" || !props.toolCallIds.has(block.toolCallId),
  );
  if (visibleBlocks.length === 0) {
    return null;
  }
  return (
    <article className={`message message--${props.message.role}`}>
      <div className="message-content">
        {visibleBlocks.map((block, index) => (
          <MessageBlock
            key={`${props.message.id}-${block.type}-${index}`}
            block={block}
            showTechnicalDetails={props.showTechnicalDetails}
            toolResults={props.toolResults}
          />
        ))}
      </div>
    </article>
  );
}

function MessageBlock(props: {
  block: MessageContentBlock;
  showTechnicalDetails: boolean;
  toolResults: Map<string, Extract<MessageContentBlock, { type: "tool-result" }>>;
}): JSX.Element {
  const { block } = props;
  if (block.type === "text") {
    return <MarkdownText text={block.text} />;
  }
  if (block.type === "tool-call") {
    const result = props.toolResults.get(block.toolCallId);
    return (
      <details
        className={`tool-call ${result?.isError ? "tool-call--error" : ""}`}
      >
        <summary>
          <ChevronRight size={13} className="tool-call__chevron" aria-hidden="true" />
          {block.name === "run_command"
            ? <Terminal size={14} />
            : <FileText size={14} />}
          <span className="tool-call__name">{formatToolName(block.name)}</span>
          <code className="tool-call__args">{summarizeArguments(block.arguments)}</code>
          {result && (
            <span
              className={`tool-call__status ${result.isError ? "is-error" : ""}`}
            >
              {result.isError ? "失败" : "完成"}
            </span>
          )}
        </summary>
        {(result || props.showTechnicalDetails) && (
          <div className="tool-call__detail">
            {props.showTechnicalDetails && (
              <pre>{JSON.stringify(block.arguments, null, 2)}</pre>
            )}
            {result && <pre>{result.output}</pre>}
          </div>
        )}
      </details>
    );
  }
  return (
    <div className={`tool-result ${block.isError ? "tool-result--error" : ""}`}>
      <span>{block.isError ? <CircleAlert size={15} /> : <Check size={15} />}</span>
      {props.showTechnicalDetails || block.isError
        ? <pre>{block.output}</pre>
        : <span className="tool-result__summary">已完成</span>}
    </div>
  );
}

function ApprovalCard(props: {
  item: PendingApprovalItem;
  onDecision: (decision: ApprovalDecision) => Promise<void>;
}): JSX.Element {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const argumentsText = useMemo(
    () => summarizeArguments(props.item.toolCall.arguments),
    [props.item.toolCall.arguments],
  );

  const decide = async (decision: ApprovalDecision) => {
    setResolving(true);
    setError(null);
    try {
      await props.onDecision(decision);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : String(decisionError),
      );
    } finally {
      setResolving(false);
    }
  };

  return (
    <section
      id={`approval-${props.item.approval.id}`}
      className="approval-card"
      aria-label="需要工具审批"
    >
      <header>
        <span className="approval-card__icon">
          {props.item.toolCall.name === "run_command"
            ? <Terminal size={16} />
            : <FileText size={16} />}
        </span>
        <div>
          <strong>需要审批</strong>
          <span>{formatToolName(props.item.toolCall.name)}</span>
        </div>
      </header>
      <p>{props.item.approval.reason}</p>
      <code>{argumentsText}</code>
      {error && <div className="form-error" role="alert">{error}</div>}
      <footer>
        <button
          type="button"
          className="button button--secondary"
          disabled={resolving}
          onClick={() => void decide("denied")}
        >
          <X size={15} />
          拒绝
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={resolving}
          onClick={() => void decide("approved-once")}
        >
          <Play size={15} />
          仅本次允许
        </button>
      </footer>
    </section>
  );
}

function RunState(props: {
  status: string | null;
}): JSX.Element | null {
  if (!props.status) {
    return null;
  }
  return (
    <span className={`run-state run-state--${props.status}`}>
      <span />
      {formatRunStatus(props.status)}
    </span>
  );
}

function summarizeArguments(value: Record<string, unknown>): string {
  if (typeof value.command === "string") {
    return value.command;
  }
  if (typeof value.path === "string") {
    return value.path;
  }
  if (typeof value.question === "string") {
    return value.question;
  }
  const serialized = JSON.stringify(value);
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}
