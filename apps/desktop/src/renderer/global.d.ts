import type { ScopeGuardDesktopApi } from "@scopeguard/ipc-contracts";

declare global {
  interface Window {
    scopeguardDesktop?: ScopeGuardDesktopApi;
  }
}

export {};
