import assert from "node:assert/strict";
import test from "node:test";

import { isolatedChildEnvironment } from "./child-process-environment.js";

test("shared child environment keeps the exact platform minimum", () => {
  assert.deepEqual(
    isolatedChildEnvironment({
      PATH: "/bin",
      HOME: "/home/user",
      TEMP: "/tmp",
      SystemRoot: String.raw`C:\Windows`,
      ProgramFiles: String.raw`C:\Program Files`,
      "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
      OPENAI_API_KEY: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      ELECTRON_RUN_AS_NODE: "1",
    }),
    {
      PATH: "/bin",
      HOME: "/home/user",
      TEMP: "/tmp",
      SystemRoot: String.raw`C:\Windows`,
      ProgramFiles: String.raw`C:\Program Files`,
      "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
    },
  );
});

test("shared child environment accepts only defined explicit values", () => {
  assert.deepEqual(
    isolatedChildEnvironment(
      { PATH: "/bin", OPENAI_API_KEY: "must-not-inherit" },
      { SCOPEGUARD_DB_PATH: "/workspace/scopeguard.db" },
    ),
    { PATH: "/bin", SCOPEGUARD_DB_PATH: "/workspace/scopeguard.db" },
  );
  assert.throws(
    () => isolatedChildEnvironment({}, { SCOPEGUARD_DB_PATH: undefined }),
    /is undefined/,
  );
});
