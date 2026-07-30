import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Play,
  RotateCcw,
  Send,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentThread,
  ApprovalDecision,
  MessageContentBlock,
  PendingApprovalItem,
  ThreadMessage,
} from "@scopeguard/domain";

import type { WorkspaceController } from "../useWorkspace.js";
import { MarkdownText } from "./MarkdownText.js";

export function ThreadPane(props: {
  thread: AgentThread;
  workspace: WorkspaceController;
  paneIndex: number;
  active: boolean;
  onActivate: () => void;
}): JSX.Element {
  const { thread, workspace } = props;
  const snapshot = workspace.snapshot;
  const agent = snapshot?.agentProfiles.find(
    (profile) => profile.id === thread.agentProfileId,
  );
  const provider = snapshot?.providerProfiles.find(
    (profile) => profile.id === agent?.providerProfileId,
  );
  const run = workspace.getRunForThread(thread.id);
  const latestRun = workspace.getLatestRunForThread(thread.id);
  const messages = workspace.messagesByThread[thread.id] ?? [];
  const stream = workspace.streamingByThread[thread.id] ?? "";
  const approvals = snapshot?.pendingApprovals.filter(
    (item) => item.approval.runId === run?.id,
  ) ?? [];
  const approvalFocus = workspace.approvalFocus?.threadId === thread.id
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
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(`scopeguard.draft.${thread.id}`, draft);
  }, [draft, thread.id]);

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

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || run || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await workspace.sendMessage(thread.id, prompt);
      setDraft("");
      localStorage.removeItem(`scopeguard.draft.${thread.id}`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      id={`thread-panel-${thread.id}`}
      className={`thread-pane ${props.active ? "is-active" : ""}`}
      role="tabpanel"
      aria-labelledby={`thread-tab-${thread.id}`}
      aria-label={`${thread.title}, pane ${props.paneIndex + 1}`}
      onPointerDownCapture={props.onActivate}
      onFocusCapture={props.onActivate}
    >
      <header className="thread-pane-header">
        <div className="agent-avatar" aria-hidden="true">
          <Bot size={16} />
        </div>
        <div className="thread-pane-heading">
          <strong>{thread.title}</strong>
          <span>
            {agent?.name ?? "Agent"}
            {workspace.professionalMode && provider
              ? ` · ${agent?.modelOverride ?? provider.defaultModel}`
              : ""}
          </span>
        </div>
        <RunState status={run?.status ?? null} />
        {run && (
          <button
            className="icon-button"
            type="button"
            onClick={() => void workspace.cancelRun(run.id)}
            title="Stop Run"
            aria-label="Stop Run"
          >
            <Square size={15} fill="currentColor" />
          </button>
        )}
      </header>

      <div className="conversation" ref={conversationRef}>
        {messages.length === 0 && !stream ? (
          <div className="thread-empty">
            <Bot size={22} />
            <strong>{agent?.name ?? "Agent"}</strong>
            <span>Start a conversation in this Project.</span>
          </div>
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              showTechnicalDetails={workspace.professionalMode}
            />
          ))
        )}
        {stream && (
          <div className="message message--assistant message--streaming">
            <div className="message-role">Agent</div>
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
        <div className="sr-only" aria-live="polite">
          {run ? `Agent Run ${run.status}` : "Agent idle"}
        </div>
      </div>

      <footer className="composer-area">
        {!run && latestRun && (
          latestRun.status === "failed" || latestRun.status === "interrupted"
        ) && (
          <div className={`run-recovery run-recovery--${latestRun.status}`}>
            <CircleAlert size={15} />
            <span>
              <strong>
                {latestRun.status === "interrupted"
                  ? "Run interrupted"
                  : "Run failed"}
              </strong>
              {latestRun.error ?? "The Run did not complete."}
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
              Retry
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
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className={`composer ${run ? "composer--disabled" : ""}`}>
          <textarea
            value={draft}
            rows={2}
            maxLength={100_000}
            placeholder={run ? "Agent is working…" : `Message ${agent?.name ?? "Agent"}`}
            disabled={Boolean(run)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            aria-label={`Message ${agent?.name ?? "Agent"}`}
          />
          <button
            type="button"
            className="composer-send"
            disabled={!draft.trim() || Boolean(run) || sending}
            onClick={() => void send()}
            aria-label="Send message"
            title="Send"
          >
            <Send size={17} />
          </button>
        </div>
      </footer>
    </section>
  );
}

function Message(props: {
  message: ThreadMessage;
  showTechnicalDetails: boolean;
}): JSX.Element {
  const label = props.message.role === "user"
    ? "You"
    : props.message.role === "assistant"
      ? "Agent"
      : "Tool";
  return (
    <article className={`message message--${props.message.role}`}>
      <div className="message-role">{label}</div>
      <div className="message-content">
        {props.message.content.map((block, index) => (
          <MessageBlock
            key={`${props.message.id}-${block.type}-${index}`}
            block={block}
            showTechnicalDetails={props.showTechnicalDetails}
          />
        ))}
      </div>
    </article>
  );
}

function MessageBlock(props: {
  block: MessageContentBlock;
  showTechnicalDetails: boolean;
}): JSX.Element {
  const { block } = props;
  if (block.type === "text") {
    return <MarkdownText text={block.text} />;
  }
  if (block.type === "tool-call") {
    return (
      <div className="tool-event">
        <span className="tool-event__icon">
          {block.name === "run_command"
            ? <Terminal size={15} />
            : <FileText size={15} />}
        </span>
        <span>
          <strong>{humanizeToolName(block.name)}</strong>
          {props.showTechnicalDetails && (
            <code>{summarizeArguments(block.arguments)}</code>
          )}
        </span>
        <ChevronRight size={14} />
      </div>
    );
  }
  return (
    <div className={`tool-result ${block.isError ? "tool-result--error" : ""}`}>
      <span>{block.isError ? <CircleAlert size={15} /> : <Check size={15} />}</span>
      {props.showTechnicalDetails || block.isError
        ? <pre>{block.output}</pre>
        : <span className="tool-result__summary">Completed</span>}
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
      aria-label="Tool approval required"
    >
      <header>
        <span className="approval-card__icon">
          {props.item.toolCall.name === "run_command"
            ? <Terminal size={16} />
            : <FileText size={16} />}
        </span>
        <div>
          <strong>Approval required</strong>
          <span>{humanizeToolName(props.item.toolCall.name)}</span>
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
          Deny
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={resolving}
          onClick={() => void decide("approved-once")}
        >
          <Play size={15} />
          Allow once
        </button>
      </footer>
    </section>
  );
}

function RunState(props: { status: string | null }): JSX.Element | null {
  if (!props.status) {
    return null;
  }
  return (
    <span className={`run-state run-state--${props.status}`}>
      <span />
      {formatStatus(props.status)}
    </span>
  );
}

function formatStatus(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function humanizeToolName(name: string): string {
  return name
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function summarizeArguments(value: Record<string, unknown>): string {
  if (typeof value.command === "string") {
    return value.command;
  }
  if (typeof value.path === "string") {
    return value.path;
  }
  const serialized = JSON.stringify(value);
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}
