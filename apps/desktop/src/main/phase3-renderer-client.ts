import type { WorkspaceLayout } from "@scopeguard/domain";

import {
  parseLateWorkspaceLayoutStageReceipt,
  type LateWorkspaceLayoutStageReceipt,
} from "./phase3-late-layout-observation.js";

const PHASE3_RENDERER_METHOD_NAMES = [
  "cancelRun",
  "copyHandoffPrompt",
  "createAgent",
  "createConversation",
  "createDispatch",
  "executeDispatch",
  "generateHandoffPrompt",
  "getWorkspaceLayout",
  "getWorkspaceSnapshot",
  "listConversationMessages",
  "listDispatches",
  "saveWorkspaceLayout",
  "stageWorkspaceLayout",
  "startRun",
] as const;

const PHASE3_RENDERER_METHODS = new Set<string>(PHASE3_RENDERER_METHOD_NAMES);

export type Phase3RendererMethod = typeof PHASE3_RENDERER_METHOD_NAMES[number];

export class Phase3RendererClient {
  readonly #webContents: {
    executeJavaScript(source: string): Promise<unknown>;
  };

  constructor(webContents: { executeJavaScript(source: string): Promise<unknown> }) {
    this.#webContents = webContents;
  }

  async invoke<Result>(method: Phase3RendererMethod, ...args: unknown[]): Promise<Result> {
    if (!PHASE3_RENDERER_METHODS.has(method)) {
      throw new Error(`Phase 3 Renderer method is not allowed: ${method}`);
    }
    const invocation = JSON.stringify(JSON.stringify({ method, args }));
    const source = `(() => {
      const invocation = JSON.parse(${invocation});
      const api = window.scopeguardDesktop;
      if (!api) throw new Error("Production ScopeGuard preload API is unavailable.");
      const operation = api[invocation.method];
      if (typeof operation !== "function") throw new Error("Preload method is unavailable.");
      return operation(...invocation.args);
    })()`;
    return await this.#webContents.executeJavaScript(source) as Result;
  }

  async armLateWorkspaceLayoutStage(
    layout: WorkspaceLayout,
    delayMs: number,
  ): Promise<LateWorkspaceLayoutStageReceipt> {
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) {
      throw new Error("Late Workspace layout delay must be a positive integer.");
    }
    const invocation = JSON.stringify(JSON.stringify({ layout, delayMs }));
    const source = `(() => {
      const invocation = JSON.parse(${invocation});
      const api = window.scopeguardDesktop;
      if (!api) throw new Error("Production ScopeGuard preload API is unavailable.");
      const armedAtUnixMs = Date.now();
      window.setTimeout(() => {
        void api.stageWorkspaceLayout(invocation.layout).catch(() => undefined);
      }, invocation.delayMs);
      return {
        armedAtUnixMs,
        dueAtUnixMs: armedAtUnixMs + invocation.delayMs,
      };
    })()`;
    return parseLateWorkspaceLayoutStageReceipt(
      await this.#webContents.executeJavaScript(source),
      delayMs,
    );
  }

  async resizeFirstPaneThroughWorkbench(
    expectedBefore: readonly number[],
  ): Promise<number[]> {
    const invocation = JSON.stringify(JSON.stringify({ expectedBefore }));
    const source = `(async () => {
      const invocation = JSON.parse(${invocation});
      const readWidths = () => {
        const workbench = document.querySelector(".workbench");
        if (!workbench) return [];
        return getComputedStyle(workbench).gridTemplateColumns
          .split(/\\s+/)
          .filter((_value, index) => index % 2 === 0)
          .map((value) => Number.parseFloat(value));
      };
      const deadline = Date.now() + 5000;
      while (JSON.stringify(readWidths()) !== JSON.stringify(invocation.expectedBefore)) {
        if (Date.now() >= deadline) {
          throw new Error("Production Renderer did not hydrate the expected Workspace layout.");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      const splitter = document.querySelector('[role="separator"][aria-orientation="vertical"]');
      if (!(splitter instanceof HTMLElement)) {
        throw new Error("Production Renderer pane splitter is unavailable.");
      }
      splitter.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }));
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      return readWidths();
    })()`;
    return await this.#webContents.executeJavaScript(source) as number[];
  }
}
