import assert from "node:assert/strict";
import test from "node:test";

import { writeControlledClipboard } from "./controlled-clipboard.js";
import { configureDenyAllSessionPermissions } from "./session-security.js";
import type { SessionPermissionBoundary } from "./session-security.js";

test("production session permissions remain deny-all while controlled IPC stays separate", () => {
  let requestHandler: Parameters<SessionPermissionBoundary["setPermissionRequestHandler"]>[0] | undefined;
  let checkHandler: Parameters<SessionPermissionBoundary["setPermissionCheckHandler"]>[0] | undefined;
  configureDenyAllSessionPermissions({
    setPermissionRequestHandler(handler) {
      requestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      checkHandler = handler;
    },
  });

  let decision: boolean | null = null;
  assert.ok(requestHandler);
  requestHandler({}, "clipboard-sanitized-write", (allowed) => { decision = allowed; }, {});
  assert.equal(decision, false);
  assert.ok(checkHandler);
  assert.equal(checkHandler({}, "clipboard-sanitized-write", "file://renderer", {}), false);

  let copied = "";
  writeControlledClipboard({}, "controlled handoff", {
    assertTrustedSender() {},
    writeText(text) { copied = text; },
  });
  assert.equal(copied, "controlled handoff");
});
