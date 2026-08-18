import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { assertSuccess } from "../qualification/assertions.mjs";
import { Classification } from "../qualification/evidence.mjs";

export async function qualifyProviderFailure(harness) {
  const providerError = await harness.startClient("provider-error");
  const records = await harness.runPrompt(
    providerError.client,
    "[http-error]",
    20_000,
  );
  const errorMessage = records.find(
    (item) =>
      item.type === "message_end" &&
      item.message?.role === "assistant" &&
      item.message?.stopReason === "error",
  );
  assert.ok(errorMessage, "provider failure did not become assistant error");
  assert.match(
    errorMessage.message.errorMessage ?? "",
    /503|qualification protocol failure/,
  );
  await harness.closeClient(providerError.client);
  harness.record(
    "provider-protocol-error",
    Classification.EXACT,
    "accepted prompt fails through assistant error event and still reaches agent_settled",
  );
}

export async function qualifySessionResumeAndCompaction(harness) {
  const persisted = await harness.startClient("persist");
  await harness.runPrompt(persisted.client, "[persist-marker]");
  const persistedState = assertSuccess(
    await persisted.client.send({ type: "get_state" }),
    "get_state",
  );
  assert.ok(persistedState.sessionFile);
  assert.ok(existsSync(persistedState.sessionFile));
  const sessionLocator = persistedState.sessionFile;
  const sessionId = persistedState.sessionId;
  const sessionHeader = JSON.parse(
    (await readFile(sessionLocator, "utf8")).split("\n", 1)[0],
  );
  assert.equal(sessionHeader.version, 3);
  await harness.closeClient(persisted.client);

  const resumed = await harness.startClient("resume", {
    sessionName: "persist",
    extra: ["--session", sessionLocator],
  });
  const resumedState = assertSuccess(
    await resumed.client.send({ type: "get_state" }),
    "get_state",
  );
  assert.equal(resumedState.sessionId, sessionId);
  await harness.runPrompt(resumed.client, "[resume-check]");
  assert.equal(
    assertSuccess(
      await resumed.client.send({ type: "get_last_assistant_text" }),
      "get_last_assistant_text",
    ).text,
    "resume-ok",
  );
  harness.record(
    "session-resume",
    Classification.EXACT,
    "opaque sessionFile/sessionId and Pi session format v3 survived process exit; prior history reached the provider",
  );

  await harness.runPrompt(resumed.client, "[long-context] one");
  await harness.runPrompt(resumed.client, "[long-context] two");
  const compactMark = resumed.client.mark();
  const compactResult = assertSuccess(
    await resumed.client.send(
      { type: "compact", customInstructions: "SCOPEGUARD_COMPACT_SUMMARY" },
      20_000,
    ),
    "compact",
  );
  const compactRecords = resumed.client.records.slice(compactMark);
  assert.ok(compactRecords.some((item) => item.type === "compaction_start"));
  const compactionEnd = compactRecords.find(
    (item) => item.type === "compaction_end",
  );
  assert.equal(compactionEnd.aborted, false);
  assert.match(compactResult.summary, /QUALIFICATION_COMPACTION_SUMMARY/);
  const entries = assertSuccess(
    await resumed.client.send({ type: "get_entries" }),
    "get_entries",
  ).entries;
  assert.ok(entries.some((entry) => entry.type === "compaction"));
  await harness.closeClient(resumed.client);

  const compacted = await harness.startClient("post-compaction-resume", {
    sessionName: "persist",
    extra: ["--session", sessionLocator],
  });
  await harness.runPrompt(compacted.client, "[after-compaction]");
  assert.equal(
    assertSuccess(
      await compacted.client.send({ type: "get_last_assistant_text" }),
      "get_last_assistant_text",
    ).text,
    "after-compaction-ok",
  );
  await harness.closeClient(compacted.client);
  harness.record(
    "manual-compaction-resume",
    Classification.EXACT,
    "compaction_start/end and Pi compaction entry persisted; process restart by opaque locator continued successfully",
  );
}
