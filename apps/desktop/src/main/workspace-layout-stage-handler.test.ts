import assert from "node:assert/strict";
import test from "node:test";

import { stageWorkspaceLayoutRequest } from "./workspace-layout-stage-handler.js";

test("malformed layout IPC is parsed before a quiescing result can be returned", () => {
  let scheduled = false;
  assert.throws(() => stageWorkspaceLayoutRequest({
    workspaceId: "workspace",
    paneWidths: "not-an-array",
  }, {
    isSchedulingSuspended: true,
    schedule: () => {
      scheduled = true;
    },
  }), /Workspace layout|field|array/i);
  assert.equal(scheduled, false);
});
