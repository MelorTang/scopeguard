#!/usr/bin/env node
/**
 * ScopeGuard External Executor Reference Bridge
 * =============================================
 * A minimal, self-contained sample client that demonstrates how to integrate
 * with ScopeGuard's external executor / connected-run API.
 *
 * Supports two execution modes:
 *   --mode simulate  (default)  Fake execution for testing the API flow
 *   --mode exec                 Real CLI execution (Claude CLI / Codex CLI)
 *
 * The 7-step integration flow:
 *   1. discovery   → learn server capabilities
 *   2. initialize   → establish a session
 *   3. handoff      → fetch task context
 *   4. start run    → register an external run
 *   5. execute      → simulate or real CLI execution
 *   6. finish run   → report results back
 *   7. ping         → heartbeat (optional)
 *
 * Usage:
 *   node scripts/external-bridge-example.js \
 *     --baseUrl http://localhost:3000 \
 *     --taskId  <your-task-id> \
 *     --executorId claude-cli \
 *     --mode exec \
 *     --token $SCOPEGUARD_TOKEN
 *
 * All arguments are optional — see --help for defaults.
 */

"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { spawn, spawnSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  baseUrl: "http://localhost:3000",
  clientName: "external-bridge-example",
  clientVersion: "0.1.0",
  executorId: "claude-cli",
  mode: "simulate",
  cliCommand: "",
  timeoutMs: "300000",       // 5 minutes default for real exec
  pollIntervalMs: "10000",    // 10 seconds default for pull mode polling
  token: process.env.SCOPEGUARD_TOKEN || "",
};

// ── Argument parsing ────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2), DEFAULTS);

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.taskId && args.mode !== "pull") {
  console.error("\nError: --taskId is required in " + args.mode + " mode.\n");
  printHelp();
  process.exit(1);
}

if (!args.token) {
  console.error("\nError: --token is required (or set SCOPEGUARD_TOKEN env var).\n");
  printHelp();
  process.exit(1);
}

if (!["simulate", "exec", "pull"].includes(args.mode)) {
  console.error("\nError: --mode must be 'simulate', 'exec', or 'pull'.\n");
  printHelp();
  process.exit(1);
}

// ── Entry point ────────────────────────────────────────────────────────────
main(args).catch((err) => {
  console.error("\n[bridge] Fatal error:", err.message);
  process.exit(1);
});

async function main(a) {
  log("\n=== ScopeGuard External Executor Reference Bridge ===\n");
  log("Mode: " + a.mode + " | Executor: " + a.executorId + " | CLI: " + (a.cliCommand || "default"));

  // Pull mode: auto-discover, auto-initialize, poll pending, claim, run, complete.
  if (a.mode === "pull") {
    await pullMode(a);
    log("\n=== Pull mode completed ===");
    return;
  }

  // Step 1: Discovery
  log("\n[1/7] Discovering server capabilities...");
  const discovery = await httpGet(a.baseUrl + "/api/desktop/external/discovery", a.token);
  log("     Protocol: " + discovery.protocol + " | Capabilities: " + Object.keys(discovery.capabilities || {}).join(", "));

  // Step 2: Initialize
  log("[2/7] Initializing session as '" + a.clientName + "'...");
  const initBody = {
    clientName: a.clientName,
    clientVersion: a.clientVersion,
    protocolVersion: discovery.protocol,
    executorId: a.executorId,
    mode: "connected",
  };
  const initRes = await httpPost(a.baseUrl + "/api/desktop/external/initialize", initBody, a.token);
  if (!initRes.ok) {
    throw new Error("initialize failed: " + JSON.stringify(initRes));
  }
  a.sessionId = initRes.sessionId;
  log("     Session established: " + a.sessionId);
  log("     Protocol version: " + initRes.acceptedProtocolVersion);
  log("     Heartbeat interval: " + initRes.heartbeatIntervalMs + "ms");

  // Step 3: Fetch task handoff
  log("[3/7] Fetching handoff for task: " + a.taskId + "...");
  const handoffRes = await httpGet(a.baseUrl + "/api/desktop/tasks/" + encodeURIComponent(a.taskId) + "/handoff", a.token);
  if (!handoffRes.ok) {
    throw new Error("handoff fetch failed: " + JSON.stringify(handoffRes));
  }
  const handoff = handoffRes.handoff;
  log("     Task title: " + handoffRes.title);
  log("     Allowed files: " + (handoff.allowedFiles || []).length + " patterns");
  log("     Commands: " + (handoff.commands || []).length + " command(s)");
  log("     Acceptance criteria: " + (handoff.acceptanceCriteria || []).length + " criterion/criteria");
  log("     Project root: " + (handoff.projectRoot || "unknown"));

  // Step 4: Start external run
  log("[4/7] Starting external run...");
  const externalSessionId = "ext-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const startBody = {
    executorId: a.executorId,
    externalSessionId: externalSessionId,
    sessionId: a.sessionId,
  };
  const startRes = await httpPost(a.baseUrl + "/api/desktop/tasks/" + encodeURIComponent(a.taskId) + "/external-run/start", startBody, a.token);
  if (!startRes.ok) {
    throw new Error("run start failed: " + JSON.stringify(startRes));
  }
  const runId = startRes.run.runId;
  log("     Run registered: " + runId + " (status: " + startRes.run.status + ")");

  // Step 5: Execute
  // ─────────────────────────────────────────────────────────────────────
  let execResult;
  if (a.mode === "simulate") {
    execResult = await simulateExecution(handoff, a.executorId);
  } else {
    execResult = await realExecution(handoff, a.executorId, a.cliCommand, parseInt(a.timeoutMs, 10));
  }
  // ─────────────────────────────────────────────────────────────────────

  // Step 6: Finish external run
  log("[6/7] Finishing external run...");
  const finishBody = {
    executorId: a.executorId,
    externalSessionId: externalSessionId,
    success: execResult.success,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    resultSummary: execResult.resultSummary,
    changedFiles: execResult.changedFiles,
    exitCode: execResult.exitCode,
    sessionId: a.sessionId,
  };
  const finishRes = await httpPost(a.baseUrl + "/api/desktop/tasks/" + encodeURIComponent(a.taskId) + "/external-run/finish", finishBody, a.token);
  if (!finishRes.ok) {
    throw new Error("run finish failed: " + JSON.stringify(finishRes));
  }
  log("     Run finished: " + finishRes.run.status + " | exitCode: " + finishRes.run.exitCode);

  // Step 7: Ping (heartbeat — optional but recommended)
  log("[7/7] Sending heartbeat...");
  const pingRes = await httpPost(a.baseUrl + "/api/desktop/external/ping", {
    sessionId: a.sessionId,
    clientName: a.clientName,
  }, a.token);
  if (!pingRes.ok) {
    log("     Ping note: " + pingRes.message);
  } else {
    log("     Pong from server at: " + pingRes.serverTime);
  }

  log("\n=== Bridge run complete ===");
  log("  Run ID:         " + runId);
  log("  Session ID:     " + a.sessionId);
  log("  Task:           " + handoff.title);
  log("  Mode:           " + a.mode);
  log("  Executor:       " + a.executorId);
  log("  Success:        " + execResult.success);
  log("  Exit code:      " + execResult.exitCode);
  log("  Result:         " + execResult.resultSummary);
}

// ── Execution modes ────────────────────────────────────────────────────────

async function pullMode(a) {
  const pollIntervalMs = parseInt(a.pollIntervalMs, 10);
  const agentLabel = a.clientName + " (" + a.executorId + ")";

  // 1. Discovery
  log("");
  log("[agent] Connecting to " + a.baseUrl + "...");
  let discovery;
  try {
    discovery = await httpGet(a.baseUrl + "/api/desktop/external/discovery", a.token);
  } catch (err) {
    throw new Error("Cannot reach ScopeGuard server at " + a.baseUrl + ": " + err.message);
  }
  log("[agent] Protocol: " + discovery.protocol);

  // 2. Initialize
  log("[agent] Registering as " + agentLabel + "...");
  const initBody = {
    clientName: a.clientName,
    clientVersion: a.clientVersion,
    protocolVersion: discovery.protocol,
    executorId: a.executorId,
    mode: "connected",
  };
  let initRes;
  try {
    initRes = await httpPost(a.baseUrl + "/api/desktop/external/initialize", initBody, a.token);
  } catch (err) {
    throw new Error("Failed to initialize session: " + err.message);
  }
  if (!initRes.ok) {
    throw new Error("Initialize rejected: " + JSON.stringify(initRes));
  }
  const sessionId = initRes.sessionId;
  const heartbeatMs = initRes.heartbeatIntervalMs || 30000;
  log("[agent] Session: " + sessionId + " | Heartbeat: " + heartbeatMs + "ms");

  // 3. Continuous poll loop
  const pollUrl = a.baseUrl + "/api/desktop/external/pending" + (a.executorId ? "?executorId=" + encodeURIComponent(a.executorId) : "");
  var iteration = 0;
  var consecutiveErrors = 0;
  var idleCount = 0;

  log("");
  log("[agent] Connected. Waiting for assignments...");
  log("[agent] Poll interval: " + pollIntervalMs + "ms | Ctrl+C to stop");

  // Graceful shutdown
  var shuttingDown = false;
  function handleShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("");
    log("[agent] Shutting down gracefully. Session " + sessionId + " remains on server.");
    log("[agent] The connected client will appear as stale after 2 minutes.");
    process.exit(0);
  }
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  while (!shuttingDown) {
    iteration++;
    idleCount++;

    // Heartbeat ping every ~5 iterations (keep session alive)
    if (iteration % 5 === 0) {
      try {
        await httpPost(a.baseUrl + "/api/desktop/external/ping", { sessionId: sessionId, clientName: a.clientName }, a.token);
      } catch {
        // ping failure is non-fatal
      }
    }

    try {
      // --- Poll ---
      const pendingRes = await httpGet(pollUrl, a.token);
      const assignments = pendingRes.assignments || [];

      if (assignments.length === 0) {
        // No work — sleep and retry
        consecutiveErrors = 0;
        if (idleCount < 3 || idleCount % 6 === 0) {
          log("[agent] No pending assignments. Waiting...");
        }
        await sleep(pollIntervalMs);
        continue;
      }

      // --- Assignment found ---
      idleCount = 0;
      const assignment = assignments[0];
      log("[agent] Assignment found: " + assignment.assignmentId);

      // --- Claim ---
      log("[agent] Claiming...");
      let claimRes;
      try {
        claimRes = await httpPost(a.baseUrl + "/api/desktop/external/pending/" + encodeURIComponent(assignment.assignmentId) + "/claim", { sessionId: sessionId }, a.token);
      } catch (err) {
        log("[agent] Claim network error: " + err.message + " - retrying");
        await sleep(pollIntervalMs);
        continue;
      }
      if (!claimRes.ok) {
        if (claimRes.code === "CLAIM_FAILED") {
          log("[agent] Claim conflict (already claimed by another agent) - skipping");
        } else {
          log("[agent] Claim failed: " + (claimRes.message || JSON.stringify(claimRes)) + " - retrying");
        }
        await sleep(pollIntervalMs);
        continue;
      }

      const handoff = claimRes.handoff;
      const taskTitle = handoff.title || "(untitled)";
      log("[agent] Running: " + taskTitle);

      // --- Execute ---
      let execResult;
      try {
        if (a.cliCommand && a.cliCommand.trim()) {
          execResult = await realExecution(handoff, a.executorId, a.cliCommand, parseInt(a.timeoutMs, 10));
        } else {
          execResult = await simulateExecution(handoff, a.executorId);
        }
      } catch (err) {
        log("[agent] Execution error: " + err.message);
        // Even if execution fails, we try to report the failure
        execResult = {
          success: false,
          stdout: "",
          stderr: "[agent] Execution failed: " + err.message,
          resultSummary: "Execution error: " + err.message,
          changedFiles: [],
          exitCode: -1,
        };
      }

      // --- Start run ---
      log("[agent] Reporting run...");
      const externalSessionId = "ext-" + Date.now();
      let startRes;
      try {
        startRes = await httpPost(a.baseUrl + "/api/desktop/tasks/" + encodeURIComponent(handoff.taskId) + "/external-run/start", {
          executorId: a.executorId,
          externalSessionId: externalSessionId,
          sessionId: sessionId,
        }, a.token);
      } catch (err) {
        throw new Error("Start run network error: " + err.message);
      }
      if (!startRes || !startRes.ok) {
        throw new Error("run start failed: " + JSON.stringify(startRes));
      }

      // --- Finish run ---
      let finishRes;
      try {
        finishRes = await httpPost(a.baseUrl + "/api/desktop/tasks/" + encodeURIComponent(handoff.taskId) + "/external-run/finish", {
          executorId: a.executorId,
          externalSessionId: externalSessionId,
          success: execResult.success,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          resultSummary: execResult.resultSummary,
          changedFiles: execResult.changedFiles,
          exitCode: execResult.exitCode,
          sessionId: sessionId,
        }, a.token);
      } catch (err) {
        throw new Error("Finish run network error: " + err.message);
      }
      if (!finishRes || !finishRes.ok) {
        throw new Error("run finish failed: " + JSON.stringify(finishRes));
      }

      // --- Complete assignment ---
      try {
        await httpPost(a.baseUrl + "/api/desktop/external/pending/" + encodeURIComponent(assignment.assignmentId) + "/complete", { sessionId: sessionId }, a.token);
      } catch (err) {
        throw new Error("Complete assignment network error: " + err.message);
      }

      log("[agent] Done: " + taskTitle + " | " + (execResult.success ? "OK" : "FAILED"));
      consecutiveErrors = 0;

      // Small pause before next poll
      await sleep(2000);

    } catch (err) {
      consecutiveErrors++;
      log("[agent] Recoverable error: " + err.message + " (x" + consecutiveErrors + ")");
      var backoffMs = Math.min(pollIntervalMs * Math.min(consecutiveErrors, 3), 30000);
      await sleep(backoffMs);
    }
  }
}

async function simulateExecution(handoff, executorId) {
  log("     [simulate] Would now execute task: " + handoff.title);
  log("     [simulate] Executor: " + executorId);
  log("     [simulate] Commands: " + JSON.stringify(handoff.commands || []));
  log("     [simulate] Waiting 1 second...");
  await sleep(1000);
  return {
    success: true,
    stdout: "[simulate] Task executed successfully (simulated).\n",
    stderr: "",
    resultSummary: "Simulated execution of: " + handoff.title,
    changedFiles: [],
    exitCode: 0,
  };
}

async function realExecution(handoff, executorId, cliCommandOverride, timeoutMs) {
  // Step A: Resolve the executable path (single string, no split on spaces)
  const cliExecutable = resolveCliExecutable(executorId, cliCommandOverride);

  // Step B: Build the executor-specific argument list
  const prompt = buildExecutorPrompt(handoff, executorId);
  const cliArgs = buildCliArgs(executorId, prompt);

  // Step C: Resolve working directory (use projectRoot from handoff)
  const cwd = resolveWorkingDir(handoff);

  // Step D: Prompt length guard — prompt is passed as CLI arg; too-long prompts
  // can exceed OS limits or cause quoting instability on some platforms.
  // Reject clearly rather than silently truncate.
  const MAX_PROMPT_CHARS = 40000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      "Task handoff prompt is " + prompt.length + " chars, exceeding the " +
      MAX_PROMPT_CHARS + "-char limit for this reference bridge. " +
      "Simplify the task (fewer acceptance criteria, shorter description) " +
      "or consider a more sophisticated bridge that passes context via file."
    );
  }

  log("     [exec] Executable: " + cliExecutable);
  log("     [exec] Args length: " + prompt.length + " chars");
  log("     [exec] CWD:        " + cwd);
  log("     [exec] Timeout:    " + timeoutMs + "ms");

  // Step E: Check CLI status (availability AND exec-mode support)
  const cliStatus = checkCliStatus(cliExecutable);

  if (!cliStatus.available) {
    throw new Error(
      "CLI executable '" + cliExecutable + "' is not available. " +
      "Ensure " + executorId + " is installed and in your PATH. " +
      "Use --cliCommand to specify a full path if needed."
    );
  }

  if (!cliStatus.supportedForExec) {
    // Distinguish "installed" from "usable in exec mode" — critical for Windows .cmd shims.
    throw new Error(
      "CLI '" + cliExecutable + "' is installed but cannot be used in exec mode. " +
      "This reference bridge does not support .cmd or .bat executables on Windows " +
      "(they cannot reliably pass long CLI arguments). " +
      "On Windows, if '" + cliExecutable + "' resolves to an npm shim (.cmd file), " +
      "this is expected. Use one of: " +
      "(a) --cliCommand pointing to the underlying .exe directly; " +
      "(b) ensure the command in your PATH resolves to an .exe (not a .cmd shim); " +
      "(c) --mode simulate to test the API flow without real CLI execution."
    );
  }

  // Step F: Execute the CLI
  return await spawnCli(cliExecutable, cliArgs, cwd, timeoutMs);
}

/**
 * Resolves the CLI executable path or command name.
 * --cliCommand is treated as a single executable path (not split on spaces).
 */
function resolveCliExecutable(executorId, cliCommandOverride) {
  if (cliCommandOverride && cliCommandOverride.trim()) {
    // Treat as a single executable path — no split
    return cliCommandOverride.trim();
  }
  // Fall back to default command names (no path, no args)
  if (executorId === "claude-cli") return "claude";
  if (executorId === "codex-cli") return "codex";
  return executorId;
}

function isCmdScript(executable) {
  if (process.platform !== "win32") return false;
  const ext = path.extname(executable).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * Builds the launch argv for a given executable + args.
 * On Windows .cmd/.bat, this function is NOT used for real exec —
 *   use .cmdExecOrReject() in realExecution instead.
 * Here we only handle direct spawn (non-.cmd on Windows, all on Unix).
 */
function buildLaunchArgv(executable, args) {
  // Only reachable for .exe / bare commands where execArg is null.
  // .cmd/.bat real exec goes through .cmdExecOrReject() instead.
  return { launcher: executable, args: args };
}

/**
 * Rejects .cmd/.bat real execution with a clear message.
 * Windows batch shims and long CLI arguments are not reliable in this bridge.
 * Returns an exec result object (never returns normally — always throws).
 */
function cmdExecOrReject(executable, executorId) {
  const ext = path.extname(executable).toLowerCase();
  const typeLabel = ext === ".bat" ? ".bat" : ".cmd";
  throw new Error(
    "Cannot execute " + typeLabel + " files in real exec mode. " +
    "Executable '" + executable + "' is a " + typeLabel + " script. " +
    "Windows batch shims do not reliably pass long arguments to child processes, " +
    "and this reference bridge does not support that configuration. " +
    "Please use one of: " +
    "(a) a bare command in your PATH (e.g., 'claude' or 'codex') that resolves to an .exe; " +
    "(b) --cliCommand pointing to a .exe directly; " +
    "(c) --mode simulate to test the API flow without real CLI execution."
  );
}

/**
 * Builds the executor-specific argument list.
 * The prompt is passed as a single argument (not via stdin).
 */
function buildCliArgs(executorId, prompt) {
  if (executorId === "claude-cli") {
    // claude -p <prompt>  — print mode: single-shot prompt, non-interactive
    return ["-p", prompt];
  }
  if (executorId === "codex-cli") {
    // codex exec <prompt>
    return ["exec", prompt];
  }
  // Fallback: pass as single arg
  return [prompt];
}

/**
 * Resolves the working directory for CLI execution.
 * Uses projectRoot from handoff; falls back to process.cwd().
 */
function resolveWorkingDir(handoff) {
  const projectRoot = handoff && handoff.projectRoot;
  if (projectRoot && typeof projectRoot === "string" && existsSync(projectRoot)) {
    return projectRoot;
  }
  return process.cwd();
}

function buildExecutorPrompt(handoff, executorId) {
  const lines = [];

  lines.push("=== ScopeGuard Task Handoff ===");
  lines.push("Executor: " + executorId);
  lines.push("");

  if (handoff.title) {
    lines.push("TASK: " + handoff.title);
  }

  if (handoff.goal) {
    lines.push("");
    lines.push("GOAL:");
    lines.push(handoff.goal);
  }

  if (handoff.commands && handoff.commands.length > 0) {
    lines.push("");
    lines.push("COMMANDS:");
    handoff.commands.forEach(function (cmd) {
      lines.push("  $ " + cmd);
    });
  }

  if (handoff.allowedFiles && handoff.allowedFiles.length > 0) {
    lines.push("");
    lines.push("ALLOWED FILES (you may read/write within these patterns):");
    handoff.allowedFiles.forEach(function (pattern) {
      lines.push("  " + pattern);
    });
  }

  if (handoff.forbiddenFiles && handoff.forbiddenFiles.length > 0) {
    lines.push("");
    lines.push("FORBIDDEN FILES (do not modify):");
    handoff.forbiddenFiles.forEach(function (pattern) {
      lines.push("  " + pattern);
    });
  }

  if (handoff.acceptanceCriteria && handoff.acceptanceCriteria.length > 0) {
    lines.push("");
    lines.push("ACCEPTANCE CRITERIA (verify these are met before finishing):");
    handoff.acceptanceCriteria.forEach(function (criteria, i) {
      lines.push("  " + (i + 1) + ". " + criteria);
    });
  }

  lines.push("");
  lines.push("=== INSTRUCTIONS ===");
  lines.push("1. Read the task goal and commands above.");
  lines.push("2. Execute the commands to complete the task.");
  lines.push("3. Stay within allowed files; do not touch forbidden files.");
  lines.push("4. Verify acceptance criteria are met.");
  lines.push("5. When complete, output a brief summary of what was done.");
  lines.push("6. List any files that were changed/created/deleted.");
  lines.push("");
  lines.push("=== OUTPUT FORMAT ===");
  lines.push("When finished, write your summary in this format:");
  lines.push("");
  lines.push("--- SCOPEGUARD RESULT ---");
  lines.push("SUMMARY: <brief description of what was accomplished>");
  lines.push("CHANGED: <list of changed file paths, one per line, or 'none'>");
  lines.push("--- END RESULT ---");

  return lines.join("\n");
}

function checkCliStatus(executable) {
  // Returns { available, supportedForExec }.
  //   available:         CLI is installed (--version succeeded)
  //   supportedForExec:  bridge can reliably use it in exec mode
  //
  // .cmd/.bat is "available" (the shim exists) but "not supported for exec"
  // because Windows batch files cannot reliably pass long CLI arguments.
  try {
    if (isCmdScript(executable)) {
      // .cmd/.bat availability check: minimal shell string (no user data).
      const result = spawnSync("cmd", ["/c", executable + " --version"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      return { available: result.status === 0, supportedForExec: false };
    }
    // .exe / bare command: direct spawn with args array — no shell involved.
    const result = spawnSync(executable, ["--version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    return { available: result.status === 0, supportedForExec: result.status === 0 };
  } catch {
    return { available: false, supportedForExec: false };
  }
}

function spawnCli(executable, args, cwd, timeoutMs) {
  // Reject .cmd/.bat — they cannot reliably pass long args; use bare command / .exe instead.
  if (isCmdScript(executable)) {
    return Promise.resolve(cmdExecOrReject(executable, "unknown"));
  }

  return new Promise(function (resolve) {
    const child = spawn(executable, args, {
      cwd: cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: Object.assign({}, process.env),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(function () {
      killed = true;
      child.kill("SIGTERM");
      resolve({
        success: false,
        stdout: stdout,
        stderr: stderr + "\n[TIMEOUT] Execution exceeded " + timeoutMs + "ms and was killed.",
        resultSummary: "Execution timed out after " + timeoutMs + "ms.",
        changedFiles: [],
        exitCode: -1,
      });
    }, timeoutMs);

    child.stdout.on("data", function (chunk) {
      stdout += chunk.toString();
    });

    child.stderr.on("data", function (chunk) {
      stderr += chunk.toString();
    });

    child.on("error", function (err) {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout: stdout,
        stderr: stderr + "\n[ERROR] " + err.message,
        resultSummary: "Execution error: " + err.message,
        changedFiles: [],
        exitCode: -1,
      });
    });

    child.on("close", function (code) {
      clearTimeout(timer);
      if (killed) return; // already resolved in timer handler

      const exitCode = code !== null ? code : -1;
      const resultSummary = extractResultSummary(stdout, stderr);
      const changedFiles = extractChangedFiles(stdout);

      resolve({
        success: exitCode === 0,
        stdout: stdout,
        stderr: stderr,
        resultSummary: resultSummary,
        changedFiles: changedFiles,
        exitCode: exitCode,
      });
    });
  });
}

// ── Output parsers ─────────────────────────────────────────────────────────

function extractResultSummary(stdout, stderr) {
  // Try to parse the structured result block first
  const resultMatch = stdout.match(/--- SCOPEGUARD RESULT ---\s*SUMMARY:\s*(.+?)\s*--- END RESULT ---/is);
  if (resultMatch && resultMatch[1]) {
    return resultMatch[1].trim();
  }

  // Fall back to last non-empty lines from stdout
  const lines = stdout.split("\n").filter(function (l) { return l.trim().length > 0; });
  if (lines.length > 0) {
    const lastLines = lines.slice(-5).join(" ");
    return lastLines.length > 300 ? lastLines.slice(0, 300) + "..." : lastLines;
  }

  if (stderr.trim()) {
    return "[stderr] " + stderr.trim().split("\n").slice(-2).join(" ");
  }

  return "Execution completed (no structured output)";
}

function extractChangedFiles(stdout) {
  const resultMatch = stdout.match(/--- SCOPEGUARD RESULT ---\s*CHANGED:\s*(.+?)\s*--- END RESULT ---/is);
  if (resultMatch && resultMatch[1]) {
    const changedStr = resultMatch[1].trim();
    if (changedStr.toLowerCase() === "none" || changedStr === "") return [];
    return changedStr.split("\n").map(function (f) { return f.trim(); }).filter(function (f) { return f.length > 0; });
  }

  // No structured output — return empty (bridge doesn't do deep stdout parsing)
  return [];
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(token) {
  return token ? { Authorization: "Bearer " + token } : {};
}

function httpGet(url, token) {
  return new Promise(function (resolve, reject) {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const req = transport.get({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: authHeaders(token),
      timeout: 15000,
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Non-JSON response: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("Request timeout: " + url)); });
  });
}

function httpPost(url, body, token) {
  return new Promise(function (resolve, reject) {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = transport.request({
      method: "POST",
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }, authHeaders(token)),
      timeout: 15000,
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Non-JSON response: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("Request timeout: " + url)); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Argument parser ────────────────────────────────────────────────────────
function parseArgs(argv, defaults) {
  const result = Object.assign({}, defaults);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }

    // --key=value form
    const eqMatch = arg.match(/^--([a-zA-Z][a-zA-Z0-9-]*)=(.*)$/);
    if (eqMatch) {
      const key = eqMatch[1];
      const value = eqMatch[2];
      if (["baseUrl", "taskId", "clientName", "clientVersion", "executorId", "mode", "cliCommand", "timeoutMs", "pollIntervalMs", "token"].includes(key)) {
        result[key] = value;
      } else {
        console.warn("Unknown option: --" + key);
      }
      continue;
    }

    // --key value form (space-separated)
    if (arg.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      const key = arg.slice(2);
      if (["baseUrl", "taskId", "clientName", "clientVersion", "executorId", "mode", "cliCommand", "timeoutMs", "pollIntervalMs", "token"].includes(key)) {
        result[key] = argv[++i];
        continue;
      } else {
        console.warn("Unknown option: --" + key);
        continue;
      }
    }

    console.warn("Unknown argument: " + arg);
  }
  return result;
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function log(msg) {
  console.log(msg);
}

function printHelp() {
  console.log(`
ScopeGuard External Executor Reference Bridge
=============================================

A sample client that walks the full connected-executor integration flow.
Supports two execution modes: simulate (for testing) and exec (real CLI).

Usage:
  node scripts/external-bridge-example.js [options]

Required:
  --taskId=<id>                Task ID to operate on (required)
  --token=<token>             External API Bearer token (required;
                               set SCOPEGUARD_TOKEN env var as alternative)

Execution mode (required):
  --mode=<mode>               'simulate' (default), 'exec' (real CLI), or 'pull' (auto agent).
                               In simulate mode: fake execution, no CLI needed.
                               In exec mode: spawns real Claude/Codex CLI.

Options:
  --baseUrl=<url>             ScopeGuard server base URL
                               (default: http://localhost:3000)
  --clientName=<name>         Client name for session
                               (default: external-bridge-example)
  --clientVersion=<ver>       Client version string (default: 0.1.0)
  --executorId=<id>           Executor ID: 'claude-cli' or 'codex-cli'
                               (default: claude-cli)
  --cliCommand=<path>         Override CLI executable path.
                               Treated as a single path — spaces are preserved.
                               The executor-specific args (-p for claude, exec
                               for codex) are added automatically.
                               NOTE: .cmd and .bat files are NOT supported in exec mode.
                               Windows batch shims cannot reliably pass long CLI arguments.
                               Use a .exe path or a bare command that resolves to an .exe.
                               Examples:
                                 --cliCommand claude
                                 --cliCommand C:\\path\\to\\claude.exe
                                 --cliCommand "C:\\Users\\me\\claude.exe"
                               In exec mode only.
  --timeoutMs=<ms>            Execution timeout in milliseconds
                               (default: 300000 = 5 minutes)
  --help, -h                  Show this help message

CLI invocation patterns:
  claude-cli:  claude -p <prompt>
  codex-cli:   codex exec <prompt>
  Both run in the task's project root (from handoff.projectRoot).

Windows compatibility note:
  This reference bridge does not support .cmd or .bat executables in exec mode.
  On Windows, npm global installs typically create .cmd shims (e.g., when you run
  'npm install -g @anthropic/claude-code'), so the default bare commands 'claude'
  or 'codex' may resolve to .cmd files and will not work in --mode exec.
  Recommended options on Windows:
    (a) Point --cliCommand to the underlying .exe directly
    (b) Ensure the command in your PATH resolves to an .exe (not a .cmd shim)
    (c) Use --mode simulate to test the API flow without real CLI execution
  On Unix/Linux/macOS, bare commands typically work directly.

Examples:

  # Simulate mode — no real CLI required, tests the full API flow
  node scripts/external-bridge-example.js \\
    --taskId abc123 --mode simulate --token $SCOPEGUARD_TOKEN

  # Exec mode with Claude CLI (default command)
  node scripts/external-bridge-example.js \\
    --taskId abc123 --mode exec --executorId claude-cli --token $SCOPEGUARD_TOKEN

  # Exec mode with Codex CLI
  node scripts/external-bridge-example.js \\
    --taskId abc123 --mode exec --executorId codex-cli --token $SCOPEGUARD_TOKEN

  # Exec mode with custom CLI path (use .exe; .cmd/.bat are rejected)
  node scripts/external-bridge-example.js \\
    --taskId abc123 --mode exec --executorId claude-cli \\
    --cliCommand "C:\\Users\\me\\tools\\claude.exe" \\
    --timeoutMs 600000 \\
    --token $SCOPEGUARD_TOKEN

  # Get this help text
  node scripts/external-bridge-example.js --help

Prerequisites for exec mode:
  - The chosen CLI (claude or codex) must be installed and in your PATH
  - Or specify a full path via --cliCommand
  - The token can be obtained from: Settings → External Executor Integration → Copy

Environment:
  SCOPEGUARD_TOKEN            Alternative to --token flag
`);
}
