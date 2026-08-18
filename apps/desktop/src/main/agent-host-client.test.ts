import assert from "node:assert/strict";
import test from "node:test";

import { agentHostEnvironment, boundedBackoffDelay } from "./agent-host-client.js";

test("bounds Agent host restart delay", () => {
  assert.equal(boundedBackoffDelay(0, 100, 1_000), 100);
  assert.equal(boundedBackoffDelay(3, 100, 1_000), 800);
  assert.equal(boundedBackoffDelay(8, 100, 1_000), 1_000);
});

test("does not inherit Provider or cloud credentials", () => {
  assert.deepEqual(
    agentHostEnvironment({
      PATH: "/bin",
      HOME: "/home/user",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
    { PATH: "/bin", HOME: "/home/user" },
  );
});
