import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CliAgentAbortedError,
  CliAgentProcessError,
  cliAgentEnvironment,
  runCliAgent,
  type CliOutputChunk,
} from "./index.js";

test("sends the prompt over stdin and reports incremental stdout", async () => {
  await withFixture(async (projectRoot) => {
    const output: CliOutputChunk[] = [];
    const result = await runNodeAgent({
      projectRoot,
      args: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let input = '';",
          "process.stdin.on('data', chunk => input += chunk);",
          "process.stdin.on('end', () => {",
          "  process.stdout.write('received:');",
          "  setTimeout(() => process.stdout.end(input), 10);",
          "});",
        ].join("\n"),
      ],
      prompt: "hello through stdin",
      onOutput: (chunk) => output.push(chunk),
    });

    assert.equal(result.stdout, "received:hello through stdin");
    assert.equal(result.stderr, "");
    assert.equal(
      output.filter((item) => item.stream === "stdout").map((item) => item.chunk).join(""),
      result.stdout,
    );
  });
});

test("replaces prompt and project root placeholders without shell evaluation", async () => {
  await withFixture(async (projectRoot) => {
    const prompt = "literal; echo should-not-run && $(pwd)";
    const result = await runNodeAgent({
      projectRoot,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        "prompt={prompt}",
        "root={projectRoot}",
      ],
      prompt,
    });

    assert.deepEqual(JSON.parse(result.stdout), [
      `prompt=${prompt}`,
      `root=${projectRoot}`,
    ]);
    assert.equal(result.args.includes(`prompt=${prompt}`), true);
  });
});

test("returns captured diagnostics for a non-zero exit", async () => {
  await withFixture(async (projectRoot) => {
    await assert.rejects(
      runNodeAgent({
        projectRoot,
        args: [
          "-e",
          "process.stdout.write('partial output'); process.stderr.write('provider rejected request\\n'); process.exit(7)",
        ],
        prompt: "",
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliAgentProcessError);
        assert.equal(error.exitCode, 7);
        assert.equal(error.stdout, "partial output");
        assert.equal(error.stderr, "provider rejected request\n");
        assert.match(error.message, /exit code 7: provider rejected request/u);
        return true;
      },
    );
  });
});

test("reports a diagnostic spawn error when the command does not exist", async () => {
  await withFixture(async (projectRoot) => {
    await assert.rejects(
      runCliAgent({
        command: join(projectRoot, "missing-cli-agent"),
        args: [],
        cwd: projectRoot,
        env: {},
        prompt: "unused",
        projectRoot,
        signal: AbortSignal.timeout(5_000),
        onOutput: () => {},
      }),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.name === "CliAgentSpawnError",
          true,
        );
        assert.match(String(error), /Failed to start CLI agent command/u);
        return true;
      },
    );
  });
});

test("aborts a running process", async () => {
  await withFixture(async (projectRoot) => {
    const controller = new AbortController();
    const run = runNodeAgent({
      projectRoot,
      args: [
        "-e",
        "process.stdout.write('started\\n'); setInterval(() => {}, 1_000)",
      ],
      prompt: "",
      signal: controller.signal,
      onOutput: (output) => {
        if (output.chunk.includes("started")) {
          controller.abort();
        }
      },
    });

    await assert.rejects(run, CliAgentAbortedError);
  });
});

test("does not spawn when already aborted", async () => {
  await withFixture(async (projectRoot) => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runNodeAgent({
        projectRoot,
        args: ["-e", "process.exit(99)"],
        prompt: "",
        signal: controller.signal,
      }),
      CliAgentAbortedError,
    );
  });
});

test("inherits only allowlisted environment variables before explicit overrides", () => {
  assert.deepEqual(
    cliAgentEnvironment(
      { HOME: "/explicit-home", SCOPEGUARD_TEST: "visible" },
      {
        PATH: "/bin",
        HOME: "/parent-home",
        OPENAI_API_KEY: "must-not-leak",
        UNRELATED_VALUE: "must-not-leak",
      },
    ),
    {
      PATH: "/bin",
      HOME: "/explicit-home",
      SCOPEGUARD_TEST: "visible",
    },
  );
});

test("bounds captured and streamed CLI output", async () => {
  await withFixture(async (projectRoot) => {
    let streamed = "";
    const result = await runNodeAgent({
      projectRoot,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(1_000_100))",
      ],
      prompt: "",
      onOutput: (output) => {
        streamed += output.chunk;
      },
    });

    assert.equal(result.stdout.length < 1_000_100, true);
    assert.match(result.stdout, /stdout truncated/);
    assert.equal(streamed, result.stdout);
  });
});

interface NodeAgentOverrides {
  projectRoot: string;
  args: readonly string[];
  prompt: string;
  signal?: AbortSignal;
  onOutput?: (output: CliOutputChunk) => void;
}

function runNodeAgent(overrides: NodeAgentOverrides) {
  return runCliAgent({
    command: process.execPath,
    args: overrides.args,
    cwd: overrides.projectRoot,
    env: {},
    prompt: overrides.prompt,
    projectRoot: overrides.projectRoot,
    signal: overrides.signal ?? AbortSignal.timeout(5_000),
    onOutput: overrides.onOutput ?? (() => {}),
  });
}

async function withFixture(
  callback: (projectRoot: string) => Promise<void>,
): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "scopeguard-cli-runtime-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}
