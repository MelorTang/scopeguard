import { FilePlus2, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { WorkspaceFileSelection } from "@scopeguard/ipc-contracts";

import type { WorkspaceController } from "../useWorkspace.js";
import { Modal } from "./Modal.js";

export function ArtifactCaptureDialog(props: {
  open: boolean;
  workspace: WorkspaceController;
  artifactId?: string;
  onClose: () => void;
}): JSX.Element | null {
  const [file, setFile] = useState<WorkspaceFileSelection | null>(null);
  const [inputs, setInputs] = useState<WorkspaceFileSelection[]>([]);
  const [toolchain, setToolchain] = useState("");
  const [limitations, setLimitations] = useState("");
  const [runId, setRunId] = useState("");
  const [validationStatus, setValidationStatus] = useState<"passed" | "partial" | "failed">("passed");
  const [validationSummary, setValidationSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceId = props.workspace.selectedWorkspace?.id;
  const eligibleRuns = useMemo(() => (props.workspace.snapshot?.recentRuns ?? [])
    .filter((run) => {
      if (run.status !== "completed" || run.effect !== "confirmed") return false;
      const conversation = props.workspace.snapshot?.conversations.find(
        ({ id }) => id === run.conversationId,
      );
      return conversation?.workspaceId === workspaceId;
    }),
  [props.workspace.snapshot, workspaceId]);

  useEffect(() => {
    if (!props.open) return;
    setFile(null);
    setInputs([]);
    setToolchain("");
    setLimitations("");
    setRunId("");
    setValidationStatus("passed");
    setValidationSummary("");
    setError(null);
  }, [props.open]);

  if (!props.open) return null;

  const chooseFile = async () => {
    setError(null);
    try {
      const files = await props.workspace.chooseWorkspaceFiles();
      setFile(files[0] ?? null);
    } catch (cause) {
      setError(messageFromError(cause));
    }
  };

  const chooseInputs = async () => {
    setError(null);
    try {
      const selected = await props.workspace.chooseWorkspaceFiles();
      setInputs((current) => deduplicateFiles([...current, ...selected]));
    } catch (cause) {
      setError(messageFromError(cause));
    }
  };

  const capture = async () => {
    if (
      !file ||
      !toolchain.trim() ||
      !runId ||
      validationStatus !== "passed" ||
      !validationSummary.trim()
    ) return;
    const run = eligibleRuns.find(({ id }) => id === runId);
    if (!run) return;
    setSaving(true);
    setError(null);
    try {
      await props.workspace.captureArtifactVersion({
        relativePath: file.relativePath,
        inputRelativePaths: inputs.map(({ relativePath }) => relativePath),
        artifactId: props.artifactId,
        producedByConversationId: run.conversationId,
        producedByRunId: run.id,
        toolchain: toolchain.trim(),
        limitations: limitations.split("\n").map((item) => item.trim()).filter(Boolean),
        validationStatus,
        validationSummary: validationSummary.trim(),
      });
      props.onClose();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title="捕获 Artifact 版本" onClose={props.onClose} width="large">
      <form
        className="dialog-form artifact-capture-form"
        onSubmit={(event) => {
          event.preventDefault();
          void capture();
        }}
      >
        <div className="artifact-capture-field">
          <span>Workspace 文件</span>
          <button
            type="button"
            className="file-selection-button"
            aria-label="选择 Workspace 文件"
            onClick={() => void chooseFile()}
            disabled={saving}
          >
            <FolderOpen size={16} />
            <span>{file?.relativePath ?? "选择 Workspace 文件"}</span>
          </button>
        </div>
        <div className="artifact-capture-field">
          <span>工作流输入文件（可选）</span>
          <button
            type="button"
            className="file-selection-button"
            aria-label="选择工作流输入文件"
            onClick={() => void chooseInputs()}
            disabled={saving}
          >
            <FolderOpen size={16} />
            <span>{inputs.length > 0
              ? inputs.map(({ relativePath }) => relativePath).join("、")
              : "选择 Agent 实际使用的输入文件"}</span>
          </button>
        </div>
        <label>
          <span>产生结果的 Run</span>
          <select
            aria-label="产生结果的 Run"
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            required
          >
            <option value="">明确选择已完成且效果已确认的 Run</option>
            {eligibleRuns.map((run) => {
              const conversation = props.workspace.snapshot?.conversations.find(
                ({ id }) => id === run.conversationId,
              );
              return (
                <option key={run.id} value={run.id}>
                  {conversation?.title ?? run.conversationId} · {run.id}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          <span>实际工具链</span>
          <input
            aria-label="实际工具链"
            value={toolchain}
            onChange={(event) => setToolchain(event.target.value)}
            placeholder="例如：documents Skill + LibreOffice 25.2"
            maxLength={512}
            required
          />
        </label>
        <label>
          <span>已知限制</span>
          <textarea
            aria-label="已知限制"
            value={limitations}
            onChange={(event) => setLimitations(event.target.value)}
            placeholder="每行一项；写清未验证、部分支持或外部工具限制"
            rows={4}
          />
        </label>
        <label>
          <span>输出验证结果</span>
          <select
            aria-label="输出验证结果"
            value={validationStatus}
            onChange={(event) => setValidationStatus(
              event.target.value as "passed" | "partial" | "failed",
            )}
            required
          >
            <option value="passed">通过，可捕获为 Artifact 版本</option>
            <option value="partial">部分通过，不可捕获</option>
            <option value="failed">失败，不可捕获</option>
          </select>
        </label>
        <label>
          <span>验证摘要</span>
          <textarea
            aria-label="验证摘要"
            value={validationSummary}
            onChange={(event) => setValidationSummary(event.target.value)}
            placeholder="写清实际执行的验证和结果，例如：重新打开 DOCX 并确认正文可读。"
            rows={3}
            maxLength={2048}
            required
          />
        </label>
        {validationStatus !== "passed" && (
          <p className="field-help" role="status">
            部分通过或失败的输出不会被捕获为 Artifact 版本；现有 Run 记录仍会保留。
          </p>
        )}
        <p className="field-help">
          ScopeGuard 只捕获当前文件为不可变版本，不会把该工具链提升为全局格式保证。
        </p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <footer className="dialog-actions">
          <button type="button" className="button button--secondary" onClick={props.onClose}>
            取消
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={
              saving ||
              !file ||
              !toolchain.trim() ||
              !runId ||
              validationStatus !== "passed" ||
              !validationSummary.trim()
            }
          >
            <FilePlus2 size={15} />
            {saving ? "正在捕获…" : "捕获不可变版本"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function messageFromError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function deduplicateFiles(files: readonly WorkspaceFileSelection[]): WorkspaceFileSelection[] {
  return [...new Map(files.map((file) => [file.relativePath, file])).values()];
}
