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
}
