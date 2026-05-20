// ── Dual-Executor Verification ──
// Verifies that two executors using the SAME project token
// are properly isolated for queue/list/claim/run operations.
// Run with: node test/verify-multi-executor.js
const { startBoardServer } = require("../apps/server/dist/index.js");
const dataPath = require("node:path").join(process.cwd(), ".scopeguard");

const fs = require("fs");
const path = require("path");
let BEARER_TOKEN = "";
try {
  BEARER_TOKEN = JSON.parse(fs.readFileSync(path.join(dataPath, "config", "external-api-token.json"), "utf-8")).token || "";
} catch { /* no token */ }

function apiFetch(url, opts) {
  if (!opts) opts = {};
  var headers = Object.assign({}, opts.headers || {});
  if (url.indexOf("/external/") >= 0 || url.indexOf("/external-") >= 0) {
    headers["authorization"] = "Bearer " + BEARER_TOKEN;
  }
  return fetch(url, Object.assign({}, opts, { headers })).then(function (r) { return r.json(); });
}

async function main() {
  console.log("=== Dual-Executor Verification ===\n");
  console.log("(" + BEARER_TOKEN.slice(0, 8) + "... same token for both executors)\n");

  const server = await startBoardServer(process.cwd(), 19878);
  var base = "http://127.0.0.1:19878";

  try {
    // Initialize session for claude-cli
    var initA = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-multi-a", executorId: "claude-cli", mode: "connected" })
    });
    var sessionA = initA.sessionId || "sess-a";
    console.log("Session A (claude-cli):", sessionA);

    // Initialize session for codex-cli (same token!)
    var initB = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-multi-b", executorId: "codex-cli", mode: "connected" })
    });
    var sessionB = initB.sessionId || "sess-b";
    console.log("Session B (codex-cli):", sessionB);

    // Get project
    var pj = await apiFetch(base + "/api/desktop/projects");
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project"); return; }

    // ─────────────────────────────────────────────
    // STEP 1: Create two tasks for different executors
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 1: Create task A (claude-cli), task B (codex-cli) ═══\n");

    var commitRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "MEX-A: Task for claude-cli", goal: "Add section A", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "MEX-B: Task for codex-cli", goal: "Add section B", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "codex-cli" },
        ]
      })
    });
    var taskA = commitRes.committed && commitRes.committed[0];
    var taskB = commitRes.committed && commitRes.committed[1];
    if (!taskA || !taskB) { console.log("FAIL: commit"); return; }
    console.log("A:", taskA.id, "executor: claude-cli");
    console.log("B:", taskB.id, "executor: codex-cli");

    // ─────────────────────────────────────────────
    // STEP 2: Queue both tasks
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 2: Queue both tasks ═══\n");

    var qA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue A:", qA.ok, "executor=" + (qA.assignment ? qA.assignment.assignedExecutor : "?"));
    var aAssignId = qA.assignment ? qA.assignment.assignmentId : null;

    var qB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue B:", qB.ok, "executor=" + (qB.assignment ? qB.assignment.assignedExecutor : "?"));
    var bAssignId = qB.assignment ? qB.assignment.assignmentId : null;

    // ─────────────────────────────────────────────
    // STEP 3: list_pending per executor
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 3: Verify list_pending isolation ═══\n");

    var pA = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var aInClaude = pA.assignments ? pA.assignments.some(function (a) { return a.taskId === taskA.id; }) : false;
    var bInClaude = pA.assignments ? pA.assignments.some(function (a) { return a.taskId === taskB.id; }) : false;
    console.log("claude-cli sees A:", aInClaude, "(expect true)");
    console.log("claude-cli sees B:", bInClaude, "(expect false)");

    var pB = await apiFetch(base + "/api/desktop/external/pending?executorId=codex-cli");
    var aInCodex = pB.assignments ? pB.assignments.some(function (a) { return a.taskId === taskA.id; }) : false;
    var bInCodex = pB.assignments ? pB.assignments.some(function (a) { return a.taskId === taskB.id; }) : false;
    console.log("codex-cli sees A:", aInCodex, "(expect false)");
    console.log("codex-cli sees B:", bInCodex, "(expect true)");

    // ─────────────────────────────────────────────
    // STEP 4: Claim with correct vs wrong executor
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 4: Verify claim executor enforcement ═══\n");

    // Claim A with claude-cli session — should succeed
    var claimA = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(aAssignId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionA })
    });
    console.log("Claim A as claude-cli:", claimA.ok, "(expect true)");

    // Claim B with claude-cli session — should FAIL (wrong executor)
    var claimBWrong = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(bAssignId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionA })
    });
    console.log("Claim B as claude-cli (should fail):", !claimBWrong.ok, claimBWrong.code || "", "(expect true — EXECUTOR_MISMATCH)");

    // Claim B with codex-cli session — should succeed
    var claimBRight = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(bAssignId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionB })
    });
    console.log("Claim B as codex-cli:", claimBRight.ok, "(expect true)");

    // ─────────────────────────────────────────────
    // STEP 5: Run-start with correct vs wrong executor
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 5: Verify run-start executor enforcement ═══\n");

    // Start run on A as codex-cli — should FAIL (wrong executor)
    var runAWrong = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "codex-cli", externalSessionId: "mex-wrong", sessionId: sessionB })
    });
    console.log("Start run on A as codex-cli (should fail):", !runAWrong.ok, runAWrong.code || "", "(expect true — EXECUTOR_MISMATCH)");

    // Start run on A as claude-cli — should succeed
    var runARight = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "mex-a", sessionId: sessionA })
    });
    console.log("Start run on A as claude-cli:", runARight.ok, "(expect true)");

    // ─────────────────────────────────────────────
    // STEP 6: Execute both tasks to completion
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 6: Complete both tasks ═══\n");

    // Finish A
    var finishA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/finish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "mex-a", success: true,
        resultSummary: "Done A.", changedFiles: ["README.md"], sessionId: sessionA })
    });
    console.log("Finish A:", finishA.ok, "(expect true)");

    // Complete A's review + approve
    var pAfterA = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var revA = pAfterA.assignments ? pAfterA.assignments.find(function (a) { return a.taskId === taskA.id && a.kind === "review"; }) : null;
    if (revA) {
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(revA.assignmentId) + "/claim", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionA })
      });
      await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "rev-a",
          status: "ready_for_review", suggestion: "OK.", sessionId: sessionA })
      });
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(revA.assignmentId) + "/complete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionA })
      });
    }
    var approveA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/approve", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText: "A approved." })
    });
    console.log("Approve A:", approveA.ok, "(expect true)");

    // Start + finish B
    var runB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/external-run/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "codex-cli", externalSessionId: "mex-b", sessionId: sessionB })
    });
    console.log("Start run on B as codex-cli:", runB.ok, "(expect true)");

    var finishB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/external-run/finish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "codex-cli", externalSessionId: "mex-b", success: true,
        resultSummary: "Done B.", changedFiles: ["README.md"], sessionId: sessionB })
    });
    console.log("Finish B:", finishB.ok, "(expect true)");

    // Complete B's review + approve
    var pAfterB = await apiFetch(base + "/api/desktop/external/pending?executorId=codex-cli");
    var revB = pAfterB.assignments ? pAfterB.assignments.find(function (a) { return a.taskId === taskB.id && a.kind === "review"; }) : null;
    if (revB) {
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(revB.assignmentId) + "/claim", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionB })
      });
      await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/external-review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ executorId: "codex-cli", externalSessionId: "rev-b",
          status: "ready_for_review", suggestion: "OK.", sessionId: sessionB })
      });
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(revB.assignmentId) + "/complete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionB })
      });
    }
    var approveB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/approve", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText: "B approved." })
    });
    console.log("Approve B:", approveB.ok, "(expect true)");

    // ─────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────
    console.log("\n═══ DUAL-EXECUTOR VERIFICATION SUMMARY ═══\n");
    console.log("1.  A queued with executor claude-cli:", qA.assignment && qA.assignment.assignedExecutor === "claude-cli", "(expect true)");
    console.log("2.  B queued with executor codex-cli:", qB.assignment && qB.assignment.assignedExecutor === "codex-cli", "(expect true)");
    console.log("3.  claude-cli sees only A in pending:", aInClaude && !bInClaude, "(expect true)");
    console.log("4.  codex-cli sees only B in pending:", !aInCodex && bInCodex, "(expect true)");
    console.log("5.  Claim A as claude-cli succeeds:", claimA.ok, "(expect true)");
    console.log("6.  Claim B as claude-cli rejected:", !claimBWrong.ok, "(expect true — EXECUTOR_MISMATCH)");
    console.log("7.  Claim B as codex-cli succeeds:", claimBRight.ok, "(expect true)");
    console.log("8.  Run-start A as codex-cli rejected:", !runAWrong.ok, "(expect true — EXECUTOR_MISMATCH)");
    console.log("9.  Run-start A as claude-cli succeeds:", runARight.ok, "(expect true)");
    console.log("10. Approve A succeeds:", approveA.ok, "(expect true)");
    console.log("11. Run-start B as codex-cli succeeds:", runB.ok, "(expect true)");
    console.log("12. Approve B succeeds:", approveB.ok, "(expect true)");

    var pass = (qA.assignment && qA.assignment.assignedExecutor === "claude-cli")
      && (qB.assignment && qB.assignment.assignedExecutor === "codex-cli")
      && aInClaude && !bInClaude && !aInCodex && bInCodex
      && claimA.ok && !claimBWrong.ok && claimBRight.ok
      && !runAWrong.ok && runARight.ok && approveA.ok && runB.ok && approveB.ok;

    console.log("\nOverall:", pass ? "✅ ALL PASSED" : "❌ ISSUES DETECTED");

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
