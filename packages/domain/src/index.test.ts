import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionRun,
  mergeToolPolicy,
  normalizeProviderBaseUrl,
  validateProviderProfileInput,
} from "./index.js";

test("normalizes provider URLs without changing their path", () => {
  assert.equal(
    normalizeProviderBaseUrl(" https://relay.example.com/v1/// "),
    "https://relay.example.com/v1",
  );
  assert.throws(
    () => normalizeProviderBaseUrl("file:///tmp/provider"),
    /http or https/,
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://user:secret@relay.example.com/v1"),
    /must not contain credentials/,
  );
});

test("validates provider fields and removes empty headers", () => {
  assert.deepEqual(
    validateProviderProfileInput({
      name: " Company relay ",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1/",
      defaultModel: " gpt-compatible ",
      apiKey: " secret ",
      customHeaders: {
        " X-Workspace ": " scopeguard ",
        Empty: " ",
      },
    }),
    {
      name: "Company relay",
      protocol: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      defaultModel: "gpt-compatible",
      apiKey: "secret",
      customHeaders: {
        "X-Workspace": "scopeguard",
      },
    },
  );
});

test("keeps run transitions explicit", () => {
  assert.equal(canTransitionRun("queued", "preparing"), true);
  assert.equal(canTransitionRun("preparing", "running"), true);
  assert.equal(canTransitionRun("running", "waiting-approval"), true);
  assert.equal(canTransitionRun("completed", "running"), false);
  assert.equal(canTransitionRun("cancelled", "completed"), false);
});

test("merges tool policy without making writes implicit", () => {
  assert.deepEqual(mergeToolPolicy({ runCommands: "deny" }), {
    readFiles: "allow",
    writeFiles: "ask",
    runCommands: "deny",
  });
});
