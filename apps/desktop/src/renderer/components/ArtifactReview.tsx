import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  FilePlus2,
  GitCompareArrows,
  History,
  MessageSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ArtifactVersion } from "@scopeguard/domain";

import type { WorkspaceController } from "../useWorkspace.js";
import { ThreadPane } from "./ThreadPane.js";

export function ArtifactReview(props: {
  workspace: WorkspaceController;
  onCaptureNewVersion: (artifactId: string) => void;
}): JSX.Element {
  const { workspace } = props;
  const artifact = workspace.selectedArtifact;
  const version = workspace.selectedArtifactVersion;
  const comparison = workspace.comparisonArtifactVersion;
  const reviewConversation = workspace.associatedArtifactConversation;
  const conversationPanelOpen = workspace.centerState?.mode === "artifact-review" &&
    workspace.centerState.conversationPanelOpen;
  const [exportPath, setExportPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const versions = useMemo(() => (workspace.snapshot?.artifactVersions ?? [])
    .filter(({ artifactId }) => artifactId === artifact?.id)
    .sort((left, right) => right.version - left.version),
  [artifact?.id, workspace.snapshot?.artifactVersions]);

  useEffect(() => {
    setExportPath(artifact?.sourceRelativePath
      ? `exports/${artifact.sourceRelativePath.split("/").at(-1)}`
      : "");
    setFeedback(null);
  }, [artifact?.id]);

  if (!artifact || !version) {
    return (
      <section className="artifact-review artifact-review--invalid" role="region" aria-label="Artifact Review">
        <h1>Artifact Review 无法恢复</h1>
        <p>所选 Artifact 或版本已不可用。返回工作台后重新选择。</p>
        <button className="button button--primary" type="button" onClick={() => void workspace.returnToWorkbench()}>
          返回工作台
        </button>
      </section>
    );
  }

  const producingConversation = workspace.snapshot?.conversations.find(
    ({ id }) => id === version.producedByConversationId,
  ) ?? null;
  const producingRun = workspace.snapshot?.recentRuns.find(
    ({ id }) => id === version.producedByRunId,
  ) ?? null;
  const parentVersion = version.parentVersionId
    ? versions.find(({ id }) => id === version.parentVersionId) ?? null
    : null;
  const isCurrent = artifact.currentVersionId === version.id;

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setFeedback(null);
    try {
      await operation();
    } catch (cause) {
      setFeedback({ tone: "error", text: messageFromError(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="artifact-review" role="region" aria-label="Artifact Review">
      <header className="artifact-review__header">
        <button
          type="button"
          className="button button--secondary button--compact"
          onClick={() => void act(() => workspace.returnToWorkbench())}
        >
          <ArrowLeft size={15} />
          返回工作台
        </button>
        <div className="artifact-review__title">
          <span>Artifact Review</span>
          <h1>{artifact.title}</h1>
        </div>
        <div className="artifact-review__header-actions">
          {reviewConversation && (
            <button
              type="button"
              className="button button--secondary button--compact"
              aria-expanded={conversationPanelOpen}
              onClick={() => void act(() =>
                workspace.setArtifactConversationPanelOpen(!conversationPanelOpen)
              )}
            >
              <MessageSquare size={15} />
              {conversationPanelOpen ? "收起关联对话" : "显示关联对话"}
            </button>
          )}
          <button
            type="button"
            className="button button--secondary button--compact"
            onClick={() => props.onCaptureNewVersion(artifact.id)}
          >
            <FilePlus2 size={15} />
            捕获新版本
          </button>
        </div>
      </header>

      <div className="artifact-review__controls">
        <label>
          <span>审阅版本</span>
          <select
            aria-label="审阅版本"
            value={version.id}
            disabled={busy}
            onChange={(event) => void act(() => workspace.selectArtifactVersion(event.target.value))}
          >
            {versions.map((item) => (
              <option value={item.id} key={item.id}>
                v{item.version} · {formatDate(item.createdAt)}
                {artifact.currentVersionId === item.id ? " · 当前" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span><GitCompareArrows size={13} /> 对比版本</span>
          <select
            aria-label="对比版本"
            value={comparison?.id ?? ""}
            disabled={busy}
            onChange={(event) => void act(() =>
              workspace.selectComparisonArtifactVersion(event.target.value || null)
            )}
          >
            <option value="">不对比</option>
            {versions.filter(({ id }) => id !== version.id).map((item) => (
              <option value={item.id} key={item.id}>v{item.version}</option>
            ))}
          </select>
        </label>
        <div className="artifact-review__current">
          {isCurrent ? (
            <span className="artifact-current-badge"><Check size={13} /> 当前版本</span>
          ) : (
            <button
              type="button"
              className="button button--secondary button--compact"
              disabled={busy}
              onClick={() => void act(async () => {
                await workspace.setArtifactCurrentVersion(artifact.id, version.id);
                setFeedback({ tone: "success", text: `v${version.version} 已设为当前版本。` });
              })}
            >
              设为当前版本
            </button>
          )}
        </div>
      </div>

      <div className={`artifact-review__workspace ${
        conversationPanelOpen && reviewConversation
          ? "artifact-review__workspace--with-conversation"
          : ""
      }`}>
        <div className="artifact-review__body">
        <article className="artifact-version-card">
          <header>
            <div>
              <span className="artifact-version-card__eyebrow"><History size={13} /> 不可变版本</span>
              <h2>v{version.version}</h2>
            </div>
            <span className="artifact-format">{artifact.format.toUpperCase()}</span>
          </header>
          <dl className="artifact-metadata">
            <Metadata label="来源文件" value={version.source?.relativePath ?? "未记录"} />
            <Metadata label="Workspace 源身份" value={version.source?.contentHash ?? "未记录"} mono />
            <Metadata label="Artifact 输出身份" value={version.contentHash} mono />
            <Metadata
              label="父版本"
              value={parentVersion ? `v${parentVersion.version} · ${parentVersion.id}` : "初始版本"}
              mono={Boolean(parentVersion)}
            />
            <Metadata label="大小" value={formatBytes(version.byteSize)} />
            <Metadata label="Conversation" value={producingConversation?.title ?? version.producedByConversationId ?? "未记录"} />
            <Metadata label="Run" value={producingRun?.id ?? version.producedByRunId ?? "未记录"} mono />
            <Metadata
              label="效果确定性"
              value={producingRun?.effect ?? (
                version.producedByRunId ? "Run 记录不可用" : "未关联 Run"
              )}
            />
            <Metadata label="实际工具链" value={version.toolchain} />
            <Metadata label="输出验证" value={version.validationStatus === "passed" ? "通过" : version.validationStatus} />
            <Metadata label="验证摘要" value={version.validationSummary} />
          </dl>
          <section className="artifact-inputs" aria-label="工作流输入身份">
            <h3>工作流输入身份</h3>
            {version.inputs.length > 0 ? (
              <ul>{version.inputs.map((input) => (
                <li key={input.relativePath}>
                  <span>{input.relativePath}</span>
                  <code>{input.contentHash}</code>
                </li>
              ))}</ul>
            ) : <p>未声明输入文件；这可能是新建文件或手动导入。</p>}
          </section>
          <section className="artifact-limitations" aria-label="已知限制">
            <h3>已知限制</h3>
            {version.limitations.length > 0 ? (
              <ul>{version.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
            ) : <p>未声明限制。</p>}
          </section>
        </article>

        <aside className="artifact-actions">
          {comparison && <VersionComparison selected={version} comparison={comparison} />}
          <section className="artifact-action-card">
            <h2>打开与导出</h2>
            <p>打开的是独立副本；当前界面只导出到新路径，目标已存在时会停止并显示冲突。</p>
            <button
              type="button"
              className="button button--secondary button--full"
              disabled={busy}
              onClick={() => void act(async () => {
                await workspace.openArtifactVersionExternally(version.id);
                setFeedback({ tone: "success", text: "已交给系统应用打开不可变版本副本。" });
              })}
            >
              <ExternalLink size={15} />
              使用系统应用打开
            </button>
            <label className="artifact-export-field">
              <span>导出到 Workspace</span>
              <input
                aria-label="导出到 Workspace"
                value={exportPath}
                onChange={(event) => setExportPath(event.target.value)}
                placeholder="exports/result.docx"
              />
            </label>
            <button
              type="button"
              className="button button--primary button--full"
              disabled={busy || !exportPath.trim()}
              onClick={() => void act(async () => {
                const exported = await workspace.exportArtifactVersion({
                  versionId: version.id,
                  relativePath: exportPath.trim(),
                });
                setFeedback({ tone: "success", text: `已导出 ${exported.relativePath}。` });
              })}
            >
              <Download size={15} />
              导出版本
            </button>
          </section>
          {feedback && (
            <p
              className={`artifact-feedback artifact-feedback--${feedback.tone}`}
              role="status"
            >
              {feedback.text}
            </p>
          )}
        </aside>
        </div>
        {conversationPanelOpen && reviewConversation && (
          <aside className="artifact-review__conversation" aria-label="Artifact 关联对话面板">
            <ThreadPane
              thread={reviewConversation}
              workspace={workspace}
              paneIndex={0}
              active={false}
              variant="artifact-review"
              ariaLabel={`${reviewConversation.title}，Artifact 关联对话`}
              onActivate={() => undefined}
              onClose={() => void act(() => workspace.setArtifactConversationPanelOpen(false))}
            />
          </aside>
        )}
      </div>
    </section>
  );
}

function Metadata(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd className={props.mono ? "is-mono" : undefined}>{props.value}</dd>
    </div>
  );
}

function VersionComparison(props: {
  selected: ArtifactVersion;
  comparison: ArtifactVersion;
}): JSX.Element {
  return (
    <section className="artifact-action-card artifact-comparison">
      <h2>版本对比</h2>
      <dl>
        <Metadata label="版本" value={`v${props.selected.version} ↔ v${props.comparison.version}`} />
        <Metadata
          label="大小变化"
          value={`${formatBytes(props.comparison.byteSize)} → ${formatBytes(props.selected.byteSize)}`}
        />
        <Metadata
          label="内容身份"
          value={props.selected.contentHash === props.comparison.contentHash ? "相同" : "不同"}
        />
      </dl>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function messageFromError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
