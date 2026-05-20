#!/usr/bin/env node
/**
 * ScopeGuard MCP Bridge
 * =====================
 * A generic stdio MCP (Model Context Protocol) server that exposes
 * ScopeGuard's connected-agent capabilities to any MCP-compatible host
 * (Claude Desktop, Codex, OpenCode, etc.).
 *
 * This bridge is NOT Claude-specific. It speaks the standard MCP protocol
 * over stdio, making it usable by any MCP host.
 *
 * Debug mode: set SCOPEGUARD_MCP_DEBUG=1 to see protocol-level trace on stderr.
 *
 * Environment variables:
 *   SCOPEGUARD_BASE_URL     ScopeGuard server URL (default: http://localhost:3000)
 *   SCOPEGUARD_TOKEN        Bearer token (required)
 *   SCOPEGUARD_EXECUTOR_ID  Executor ID for claiming tasks (default: claude-cli)
 *   SCOPEGUARD_CLIENT_NAME  Client name for session (default: scopeguard-mcp-bridge)
 *   SCOPEGUARD_MCP_DEBUG    Set to 1 for stderr protocol debug logging
 *
 * Example Claude Desktop configuration:
 * {
 *   "mcpServers": {
 *     "scopeguard": {
 *       "command": "node",
 *       "args": ["/path/to/scopeguard/scripts/scopeguard-mcp-bridge.js"],
 *       "env": {
 *         "SCOPEGUARD_BASE_URL": "http://localhost:3000",
 *         "SCOPEGUARD_TOKEN": "<your-token>",
 *         "SCOPEGUARD_EXECUTOR_ID": "claude-cli",
 *         "SCOPEGUARD_MCP_DEBUG": "1"
 *       }
 *     }
 *   }
 * }
 */

"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");

// ── Configuration ─────────────────────────────────────────────────────────

const BASE_URL = process.env.SCOPEGUARD_BASE_URL || "http://localhost:3000";
const TOKEN = process.env.SCOPEGUARD_TOKEN || "";
const EXECUTOR_ID = process.env.SCOPEGUARD_EXECUTOR_ID || "claude-cli";
const CLIENT_NAME = process.env.SCOPEGUARD_CLIENT_NAME || "scopeguard-mcp-bridge";

if (!TOKEN) {
  console.error("[scopeguard-mcp] Error: SCOPEGUARD_TOKEN is required.");
  process.exit(1);
}

// ── Debug logging ─────────────────────────────────────────────────────────

const DEBUG = process.env.SCOPEGUARD_MCP_DEBUG === "1" || process.env.SCOPEGUARD_MCP_DEBUG === "true";

function debug(...args) {
  if (DEBUG) {
    process.stderr.write("[scopeguard-mcp:debug] " + args.join(" ") + "\n");
  }
}

// ── Startup health tracking ───────────────────────────────────────────────

let mcpInitialized = false; // set when initialize request is received
let mcpSessionReady = false; // set after notifications/initialized

// ── MCP Protocol constants ────────────────────────────────────────────────

const MCP_VERSION = "2025-03-26";

// ── State ─────────────────────────────────────────────────────────────────

let serverSessionId = null;
let serverCapabilities = {};
let sessionHeartbeatId = null;

const HEARTBEAT_INTERVAL_MS = 25000; // 25s — keeps session present within 45s staleness window

// ── HTTP helpers (mirroring external-bridge-example.js) ──────────────────

function authHeaders() {
  return { Authorization: "Bearer " + TOKEN };
}

function httpGet(urlPath) {
  return new Promise(function (resolve, reject) {
    const parsedUrl = new URL(BASE_URL + urlPath);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const req = transport.get({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: authHeaders(),
      timeout: 15000,
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          const snippet = data.slice(0, 300).replace(/\n/g, " ");
          reject(new Error("HTTP " + status + " " + urlPath + " — " + snippet));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("non-JSON response (" + status + " " + urlPath + "): " + data.slice(0, 200).replace(/\n/g, " "))); }
      });
    });
    req.on("error", function (err) {
      const msg = (err && (err.message || err.code || String(err))) || "unknown error";
      reject(new Error(msg + " — " + urlPath));
    });
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout — " + urlPath)); });
  });
}

function httpPost(urlPath, body) {
  return new Promise(function (resolve, reject) {
    const parsedUrl = new URL(BASE_URL + urlPath);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = transport.request({
      method: "POST",
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }, authHeaders()),
      timeout: 15000,
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          const snippet = data.slice(0, 300).replace(/\n/g, " ");
          reject(new Error("HTTP " + status + " " + urlPath + " — " + snippet));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("non-JSON response (" + status + " " + urlPath + "): " + data.slice(0, 200).replace(/\n/g, " "))); }
      });
    });
    req.on("error", function (err) {
      const msg = (err && (err.message || err.code || String(err))) || "unknown error";
      reject(new Error(msg + " — " + urlPath));
    });
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout — " + urlPath)); });
    req.write(bodyStr);
    req.end();
  });
}

// ── ScopeGuard API helpers ────────────────────────────────────────────────

async function ensureSession() {
  if (serverSessionId) return serverSessionId;

  // Phase 1: discovery — learn server protocol & capabilities
  let discovery;
  try {
    debug("ensureSession: GET " + BASE_URL + "/api/desktop/external/discovery");
    discovery = await httpGet("/api/desktop/external/discovery");
    debug("ensureSession: discovery ok, protocol=" + (discovery.protocol || "(not specified)"));
  } catch (err) {
    debug("ensureSession failed at discovery: " + err.message);
    throw new Error("discovery failed: " + err.message);
  }

  // Phase 2: initialize — establish a session
  const initBody = {
    clientName: CLIENT_NAME,
    clientVersion: "0.1.0",
    protocolVersion: discovery.protocol || "scopeguard-external-v1",
    executorId: EXECUTOR_ID,
    mode: "connected",
  };

  let initRes;
  try {
    debug("ensureSession: POST " + BASE_URL + "/api/desktop/external/initialize");
    initRes = await httpPost("/api/desktop/external/initialize", initBody);
    debug("ensureSession: initialize responded, ok=" + initRes.ok);
  } catch (err) {
    debug("ensureSession failed at initialize: " + err.message);
    throw new Error("initialize failed: " + err.message);
  }

  // Validate initialize response
  if (!initRes.ok) {
    const detail = initRes.message || JSON.stringify(initRes);
    debug("ensureSession: initialize rejected: " + detail);
    throw new Error("initialize rejected: " + detail);
  }

  if (!initRes.sessionId) {
    const detail = JSON.stringify(initRes).slice(0, 200);
    debug("ensureSession: initialize response missing sessionId");
    throw new Error("initialize response malformed: missing sessionId — " + detail);
  }

  serverSessionId = initRes.sessionId;
  serverCapabilities = initRes.serverCapabilities || {};
  debug("ensureSession: session established, id=" + serverSessionId);
  // Start periodic heartbeat to keep session presence alive
  if (sessionHeartbeatId) clearInterval(sessionHeartbeatId);
  sessionHeartbeatId = setInterval(function () {
    if (!serverSessionId) return;
    httpPost("/api/desktop/external/ping", { sessionId: serverSessionId, clientName: CLIENT_NAME }).catch(function () {
      debug("heartbeat failed — session may have expired");
    });
  }, HEARTBEAT_INTERVAL_MS);
  debug("heartbeat started: interval=" + HEARTBEAT_INTERVAL_MS + "ms");
  return serverSessionId;
}

async function pingSession() {
  if (!serverSessionId) return;
  try {
    await httpPost("/api/desktop/external/ping", { sessionId: serverSessionId, clientName: CLIENT_NAME });
  } catch {
    // non-fatal
  }
}

// ── Tool implementations ──────────────────────────────────────────────────

async function toolStatus(args) {
  await ensureSession();
  await pingSession();
  const [clientsRes, pendingRes] = await Promise.all([
    httpGet("/api/desktop/external/clients").catch(function () { return { clients: [] }; }),
    httpGet("/api/desktop/external/pending" + (EXECUTOR_ID ? "?executorId=" + encodeURIComponent(EXECUTOR_ID) : "")).catch(function () { return { assignments: [] }; }),
  ]);
  return {
    content: [{ type: "text", text: JSON.stringify({
      server: BASE_URL,
      session: serverSessionId,
      executorId: EXECUTOR_ID,
      protocol: "scopeguard-external-v1",
      connectedClients: clientsRes.clients || [],
      pendingCount: (pendingRes.assignments || []).length,
      clientName: CLIENT_NAME,
    }, null, 2) }],
  };
}

async function toolListPending(args) {
  await ensureSession();
  const filterExecutor = (args && args.executorId) || EXECUTOR_ID;
  const pendingRes = await httpGet("/api/desktop/external/pending" + (filterExecutor ? "?executorId=" + encodeURIComponent(filterExecutor) : ""));
  const assignments = pendingRes.assignments || [];
  return {
    content: [{ type: "text", text: JSON.stringify({
      count: assignments.length,
      assignments: assignments.map(function (a) {
        return {
          assignmentId: a.assignmentId,
          taskId: a.taskId,
          assignedExecutor: a.assignedExecutor,
          createdAt: a.createdAt,
        };
      }),
    }, null, 2) }],
  };
}

async function toolClaimAssignment(args) {
  await ensureSession();
  if (!args || !args.assignmentId) {
    return { isError: true, content: [{ type: "text", text: "assignmentId is required." }] };
  }
  const claimRes = await httpPost("/api/desktop/external/pending/" + encodeURIComponent(args.assignmentId) + "/claim", {
    sessionId: serverSessionId,
  });
  if (!claimRes.ok) {
    return { isError: true, content: [{ type: "text", text: "Claim failed: " + (claimRes.message || JSON.stringify(claimRes)) }] };
  }
  const handoff = claimRes.handoff || {};
  return {
    content: [{ type: "text", text: JSON.stringify({
      assignmentId: args.assignmentId,
      taskId: handoff.taskId,
      title: handoff.title,
      goal: handoff.goal,
      allowedFiles: handoff.allowedFiles,
      acceptanceCriteria: handoff.acceptanceCriteria,
      commands: handoff.commands,
      projectRoot: handoff.projectRoot,
      preferredExecutor: handoff.preferredExecutor,
    }, null, 2) }],
  };
}

async function toolCancelAssignment(args) {
  await ensureSession();
  if (!args || !args.assignmentId) {
    return { isError: true, content: [{ type: "text", text: "assignmentId is required." }] };
  }
  var cancelRes = await httpPost("/api/desktop/external/pending/" + encodeURIComponent(args.assignmentId) + "/cancel", {})
    .catch(function (err) {
      return { error: err.message };
    });
  if (cancelRes.error || !cancelRes.ok) {
    return { isError: true, content: [{ type: "text", text: "Cancel failed: " + (cancelRes.error || cancelRes.message || JSON.stringify(cancelRes)) }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: true,
      assignmentId: args.assignmentId,
      status: "canceled",
    }, null, 2) }],
  };
}

async function toolFinishAssignment(args) {
  await ensureSession();
  if (!args || !args.assignmentId || !args.taskId) {
    return { isError: true, content: [{ type: "text", text: "assignmentId and taskId are required." }] };
  }

  const externalSessionId = "mcp-" + Date.now();

  // Start run
  const startRes = await httpPost("/api/desktop/tasks/" + encodeURIComponent(args.taskId) + "/external-run/start", {
    executorId: EXECUTOR_ID,
    externalSessionId: externalSessionId,
    sessionId: serverSessionId,
  }).catch(function (err) {
    return { error: err.message };
  });
  if (startRes.error) {
    return { isError: true, content: [{ type: "text", text: "Start run failed: " + startRes.error }] };
  }

  // Finish run
  const finishRes = await httpPost("/api/desktop/tasks/" + encodeURIComponent(args.taskId) + "/external-run/finish", {
    executorId: EXECUTOR_ID,
    externalSessionId: externalSessionId,
    success: args.success !== false,
    stdout: args.stdout || "",
    stderr: args.stderr || "",
    resultSummary: args.resultSummary || "Completed via MCP bridge.",
    changedFiles: args.changedFiles || [],
    exitCode: typeof args.exitCode === "number" ? args.exitCode : 0,
    sessionId: serverSessionId,
  }).catch(function (err) {
    return { error: err.message };
  });
  if (finishRes.error) {
    return { isError: true, content: [{ type: "text", text: "Finish run failed: " + finishRes.error }] };
  }

  // Complete assignment
  const completeRes = await httpPost("/api/desktop/external/pending/" + encodeURIComponent(args.assignmentId) + "/complete", {
    sessionId: serverSessionId,
  }).catch(function () {
    return { ok: false };
  });

  return {
    content: [{ type: "text", text: JSON.stringify({
      taskId: args.taskId,
      assignmentId: args.assignmentId,
      runCompleted: !finishRes.error,
      assignmentCompleted: completeRes && completeRes.ok,
    }, null, 2) }],
  };
}

async function toolSubmitReview(args) {
  await ensureSession();
  if (!args || !args.taskId || !args.status || !args.suggestion) {
    return { isError: true, content: [{ type: "text", text: "taskId, status, and suggestion are required." }] };
  }
  if (args.status !== "ready_for_review" && args.status !== "needs_attention") {
    return { isError: true, content: [{ type: "text", text: "status must be 'ready_for_review' or 'needs_attention'." }] };
  }
  const revRes = await httpPost("/api/desktop/tasks/" + encodeURIComponent(args.taskId) + "/external-review", {
    executorId: EXECUTOR_ID,
    externalSessionId: "review-" + Date.now(),
    status: args.status,
    suggestion: args.suggestion,
    sessionId: serverSessionId,
  }).catch(function (err) {
    return { error: err.message };
  });
  if (revRes.error) {
    return { isError: true, content: [{ type: "text", text: "Review submission failed: " + revRes.error }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: revRes.ok,
      taskId: args.taskId,
      reviewStatus: args.status,
    }, null, 2) }],
  };
}

// ── MCP request router ────────────────────────────────────────────────────

function handleMcpRequest(request) {
  const id = request.id;
  const method = request.method;
  const params = request.params || {};

  if (method === "initialize") {
    mcpInitialized = true;
    debug("initialize called, protocolVersion=" + (params.protocolVersion || "(not specified)") + ", client=" + JSON.stringify(params.clientInfo));
    return Promise.resolve({
      jsonrpc: "2.0",
      id: id,
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: { name: "scopeguard-mcp-bridge", version: "0.1.0" },
      },
    });
  }

  if (method === "notifications/initialized") {
    mcpSessionReady = true;
    debug("notifications/initialized received — MCP handshake complete");
    return Promise.resolve(null); // no response for notifications
  }

  if (method === "tools/list") {
    debug("tools/list called — advertising 6 tools: scopeguard_status, scopeguard_list_pending, scopeguard_claim_assignment, scopeguard_cancel_assignment, scopeguard_finish_assignment, scopeguard_submit_review");
    return Promise.resolve({
      jsonrpc: "2.0",
      id: id,
      result: {
        tools: [
          {
            name: "scopeguard_status",
            description: "Get ScopeGuard connection status, connected clients, and pending assignment count.",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "scopeguard_list_pending",
            description: "List pending assignments for the configured executor or a specific executor.",
            inputSchema: {
              type: "object",
              properties: {
                executorId: { type: "string", description: "Filter by executor ID (default: configured executor)" },
              },
              required: [],
            },
          },
          {
            name: "scopeguard_claim_assignment",
            description: "Claim a pending assignment and return the task handoff with structured task details.",
            inputSchema: {
              type: "object",
              properties: {
                assignmentId: { type: "string", description: "The assignment ID to claim" },
              },
              required: ["assignmentId"],
            },
          },
          {
            name: "scopeguard_finish_assignment",
            description: "Report results for an assignment: starts a run, finishes it, and completes the assignment. Use after executing the claimed task.",
            inputSchema: {
              type: "object",
              properties: {
                assignmentId: { type: "string", description: "The claimed assignment ID" },
                taskId: { type: "string", description: "The task ID from the handoff" },
                success: { type: "boolean", description: "Whether execution succeeded (default: true)" },
                resultSummary: { type: "string", description: "Brief summary of what was done" },
                stdout: { type: "string", description: "Execution stdout text" },
                stderr: { type: "string", description: "Execution stderr text" },
                changedFiles: { type: "array", items: { type: "string" }, description: "List of changed file paths" },
                exitCode: { type: "number", description: "Process exit code" },
              },
              required: ["assignmentId", "taskId"],
            },
          },
          {
            name: "scopeguard_submit_review",
            description: "Submit a structured review result for a task after evaluating the execution output. Must be called before finishing a review assignment.",
            inputSchema: {
              type: "object",
              properties: {
                taskId: { type: "string", description: "The task ID to submit review for" },
                status: { type: "string", enum: ["ready_for_review", "needs_attention"], description: "Review verdict: ready_for_review = passed, needs_attention = changes requested" },
                suggestion: { type: "string", description: "Detailed review feedback explaining the verdict" },
              },
              required: ["taskId", "status", "suggestion"],
            },
          },
          {
            name: "scopeguard_cancel_assignment",
            description: "Cancel a pending or claimed execution assignment and reset the task to ready for re-queue.",
            inputSchema: {
              type: "object",
              properties: {
                assignmentId: { type: "string", description: "The assignment ID to cancel" },
              },
              required: ["assignmentId"],
            },
          },
        ],
      },
    });
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    debug("tools/call called: " + toolName);

    let handler;
    if (toolName === "scopeguard_status") handler = toolStatus;
    else if (toolName === "scopeguard_list_pending") handler = toolListPending;
    else if (toolName === "scopeguard_claim_assignment") handler = toolClaimAssignment;
    else if (toolName === "scopeguard_cancel_assignment") handler = toolCancelAssignment;
    else if (toolName === "scopeguard_finish_assignment") handler = toolFinishAssignment;
    else if (toolName === "scopeguard_submit_review") handler = toolSubmitReview;
    else {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: id,
        error: { code: -32601, message: "Tool not found: " + toolName },
      });
    }

    return handler(toolArgs).then(function (result) {
      return {
        jsonrpc: "2.0",
        id: id,
        result: result,
      };
    }).catch(function (err) {
      debug("tools/call error for " + toolName + ": " + err.message);
      return {
        jsonrpc: "2.0",
        id: id,
        error: { code: -32000, message: err.message },
      };
    });
  }

  if (method === "prompts/list") {
    return Promise.resolve({
      jsonrpc: "2.0",
      id: id,
      result: {
        prompts: [
          {
            name: "scopeguard_run_once",
            description: "Execute one ScopeGuard task: checks status, lists pending, claims one assignment, executes the task, and reports results. Use this to process queued ScopeGuard tasks.",
            arguments: [],
          },
        ],
      },
    });
  }

  if (method === "prompts/get") {
    const promptName = params.name;
    if (promptName === "scopeguard_run_once") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: id,
        result: {
          description: "Execute one ScopeGuard task assignment",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: [
                  "Run the ScopeGuard task workflow using MCP tools:",
                  "",
                  "CRITICAL: Your output must be ONLY the final report below. No other output allowed.",
                  "",
                  "Final report format (choose exactly one):",
                  "",
                  "1. If no pending assignment was found:",
                  "   status: idle",
                  "   result: No pending assignments found.",
                  "",
                  "2. If an assignment was claimed and finished:",
                  "   status: succeeded / failed",
                  "   result: one-line summary from finish_assignment response",
                  "",
                  "3. If a tool call failed:",
                  "   status: failed",
                  "   result: <error message>",
                  "",
                  "Execution steps (call tools in order, stop at first applicable result):",
                  "",
                  "1. Call scopeguard_status. If it fails, output status: failed and stop.",
                  "2. Call scopeguard_list_pending.",
                  "   - If 0 assignments: output status: idle / result: No pending assignments found. Stop immediately.",
                  "   - Do not reference prior conversation. Do not reuse old results. Do not invent tasks.",
                  "3. Call scopeguard_claim_assignment with the first assignmentId.",
                  "   - If claim fails: output status: failed / result: <error>. Stop.",
                  "4. Execute the task using the returned handoff. Work within allowedFiles only.",
                  "5. If the handoff contains a review assignment (title mentions 'Review assignment'), evaluate the task result against acceptance criteria, then call scopeguard_submit_review with your review verdict.",
                  "   - status: 'ready_for_review' if criteria are met, 'needs_attention' if changes are needed.",
                  "   - suggestion: detailed feedback explaining your verdict.",
                  "6. Call scopeguard_finish_assignment with results. Do not skip this step.",
                  "7. Output the final report. Only one line per field. No additional text.",
                  "",
                  "Forbidden:",
                  "- Do NOT output anything before the final report.",
                  "- Do NOT reference prior conversation context or old execution results.",
                  "- Do NOT invent tasks — only claim what list_pending returns.",
                  "- If list_pending returned 0, the ONLY valid output is 'status: idle'.",
                ].join("\n"),
              },
            },
          ],
        },
      });
    }
    return Promise.resolve({
      jsonrpc: "2.0",
      id: id,
      error: { code: -32601, message: "Prompt not found: " + promptName },
    });
  }

  if (method === "ping") {
    debug("ping received from host");
    return Promise.resolve({
      jsonrpc: "2.0",
      id: id,
      result: {},
    });
  }

  if (method === "resources/list") {
    debug("resources/list called — returning empty list");
    return Promise.resolve({
      jsonrpc: "2.0",
      id: id,
      result: { resources: [] },
    });
  }

  // Unknown method
  debug("unknown method: " + method);
  return Promise.resolve({
    jsonrpc: "2.0",
    id: id,
    error: { code: -32601, message: "Method not found: " + method },
  });
}

// ── Stdio transport ───────────────────────────────────────────────────────

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", function (chunk) {
  buffer += chunk;

  // MCP uses newline-delimited JSON
  var newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    // Handle asynchronously
    handleMcpRequest(request).then(function (response) {
      if (response) respond(response);
    }).catch(function (err) {
      process.stderr.write("[scopeguard-mcp] Internal error processing request: " + (err && err.message || err) + "\n");
      if (request.id != null) {
        respond({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Internal error" } });
      }
    });
  }
});

function respond(msg) {
  // Use synchronous write to bypass Node.js stream buffering.
  // When stdout is connected to a pipe (standard MCP scenario),
  // process.stdout.write may buffer, causing the MCP host to never
  // receive our JSON-RPC responses. fs.writeSync flushes immediately.
  const text = JSON.stringify(msg) + "\n";
  try {
    fs.writeSync(process.stdout.fd, text);
  } catch (e) {
    process.stderr.write("[scopeguard-mcp] Fatal: cannot write to stdout: " + e.message + "\n");
    process.exit(1);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────

process.stderr.write("[scopeguard-mcp] Starting MCP bridge...\n");
process.stderr.write("[scopeguard-mcp] Server: " + BASE_URL + " | Executor: " + EXECUTOR_ID + "\n");
process.stderr.write("[scopeguard-mcp] Protocol: scopeguard-external-v1 | MCP: " + MCP_VERSION + "\n");
if (DEBUG) {
  process.stderr.write("[scopeguard-mcp:debug] Debug mode enabled\n");
  process.stderr.write("[scopeguard-mcp:debug] Platform: " + process.platform + " | Node: " + process.version + "\n");
  process.stderr.write("[scopeguard-mcp:debug] stdin isTTY: " + process.stdin.isTTY + " | stdout isTTY: " + process.stdout.isTTY + "\n");
}
process.stderr.write("[scopeguard-mcp] Ready. Waiting for MCP host to initialize...\n");

// Startup health monitor — warns if host never sends initialize
const STARTUP_TIMEOUT = 30000;
setTimeout(function () {
  if (!mcpInitialized) {
    process.stderr.write("[scopeguard-mcp] Warning: No MCP initialize request received within 30s.\n");
    process.stderr.write("[scopeguard-mcp] Warning: Check that this MCP server is configured in your MCP host settings (e.g. claude_desktop_config.json).\n");
  }
}, STARTUP_TIMEOUT);

// Keep process alive
process.stdin.resume();

// ── Error handling ────────────────────────────────────────────────────────

process.on("unhandledRejection", function (err) {
  process.stderr.write("[scopeguard-mcp] Unhandled rejection: " + (err && err.message || err) + "\n");
});

process.on("uncaughtException", function (err) {
  process.stderr.write("[scopeguard-mcp] Uncaught exception: " + err.message + "\n");
  // Don't exit — try to keep running for robustness
});

process.on("SIGINT", function () {
  process.stderr.write("[scopeguard-mcp] Shutting down.\n");
  process.exit(0);
});

process.on("SIGTERM", function () {
  process.exit(0);
});
