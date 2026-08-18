import assert from "node:assert/strict";
import { assertSuccess } from "../qualification/assertions.mjs";
import { Classification } from "../qualification/evidence.mjs";

export async function qualifyProcessLifecycle(harness) {
  const ready = await harness.startClient("ready");
  const initialReadySessionId = ready.state.sessionId;
  const versionProbe = await ready.client.send({
    type: "get_protocol_version",
  });
  assert.equal(versionProbe.success, false);
  assert.match(versionProbe.error, /Unknown command/);
  const createdSession = assertSuccess(
    await ready.client.send({ type: "new_session" }),
    "new_session",
  );
  assert.equal(createdSession.cancelled, false);
  const createdState = assertSuccess(
    await ready.client.send({ type: "get_state" }),
    "get_state",
  );
  assert.notEqual(createdState.sessionId, initialReadySessionId);
  const readyExit = await harness.closeClient(ready.client);
  assert.deepEqual(
    { code: readyExit.code, signal: readyExit.signal },
    { code: 0, signal: null },
  );
  harness.record(
    "process-ready-shutdown",
    Classification.LOSSY,
    `CLI ${harness.version}; readiness is get_state because RPC has no handshake/version command; stdin EOF exits 0`,
  );
  harness.record(
    "session-create",
    Classification.EXACT,
    "new_session returned cancelled=false and get_state exposed a new sessionId",
  );

  const terminated = await harness.startClient("terminated");
  const terminatedExit = await terminated.client.kill("SIGTERM");
  harness.forgetClient(terminated.client);
  assert.equal(terminatedExit.code, 143);
  assert.equal(terminatedExit.signal, null);
  harness.record(
    "host-termination",
    Classification.LOSSY,
    "Pi handles SIGTERM as numeric exit 143 without a shutdown acknowledgement",
  );

  const crash = await harness.startClient("crash");
  const crashExit = await crash.client.kill("SIGKILL");
  harness.forgetClient(crash.client);
  assert.equal(crashExit.code, null);
  assert.equal(crashExit.signal, "SIGKILL");
  harness.record(
    "unexpected-crash",
    Classification.EXACT,
    "transport distinguishes SIGKILL from normal exit and retains sanitized stderr",
  );
}
