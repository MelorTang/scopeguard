import assert from "node:assert/strict";
import test from "node:test";

import { stopAgentHostForTerminalShutdown } from "./terminal-agent-host-shutdown.js";

test("terminal Agent Host stop failure is propagated without a false completion event", async () => {
  const events: string[] = [];

  await assert.rejects(
    () => stopAgentHostForTerminalShutdown({
      stop: async () => {
        throw new Error("host stop failed");
      },
      recordEvent: (event) => events.push(event),
    }),
    /host stop failed/,
  );

  assert.deepEqual(events, ["host-stop-started"]);
});
