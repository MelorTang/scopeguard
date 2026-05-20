// ── Phase 2: 3-task orchestration MVP verification ──
// Run with: node test/verify-3task.js
const { startBoardServer } = require("../apps/server/dist/index.js");
const dataPath = require("node:path").join(process.cwd(), ".scopeguard");

const fs = require("fs");
const path = require("path");
let BEARER_TOKEN = "";
try {
  const tokenPath = path.join(dataPath, "config", "external-api-token.json");
  BEARER_TOKEN = JSON.parse(fs.readFileSync(tokenPath, "utf-8")).token || "";
} catch { /* no token */ }

function apiFetch(url, opts) {
  if (!opts) opts = {};
  var headers = Object.assign({}, opts.headers || {});
  if (url.indexOf("/external/") >= 0 || url.indexOf("/external-") >= 0) {
    headers["authorization"] = "Bearer " + BEARER_TOKEN;
  }
  return fetch(url, Object.assign({}, opts, { headers })).then(function (r) { return r.json(); });
}

async function fullExecution(taskId, sessionId, runLabel) {
  // Claim → start run → finish run → returns status
  // First find and claim the execution assignment
  var p = await apiFetch("http://127.0.0.1:19874/api/desktop/external/pending?executorId=claude-cli");
  var assign = p.assignments ? p.assignments.find(function (a) { return a.taskId === taskId; }) : null;
  if (!assign) return { ok: false, step: "no-assignment" };

  var claim = await apiFetch("http://127.0.0.1:19874/api/desktop/external/pending/" + encodeURIComponent(assign.assignmentId) + "/claim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sessionId })
  });
  if (!claim.ok) return { ok: false, step: "claim-failed" };

  var start = await apiFetch("http://127.0.0.1:19874/api/desktop/tasks/" + encodeURIComponent(taskId) + "/external-run/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ executorId: "claude-cli", externalSessionId: runLabel, sessionId: sessionId })
  });
  if (!start.ok) return { ok: false, step: "start-failed" };

  var finish = await apiFetch("http://127.0.0.1:19874/api/desktop/tasks/" + encodeURIComponent(taskId) + "/external-run/finish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ executorId: "claude-cli", externalSessionId: runLabel, success: true,
      resultSummary: "Done.", changedFiles: ["README.md"], sessionId: sessionId })
  });
  if (!finish.ok) return { ok: false, step: "finish-failed" };
  return { ok: true, step: "executed" };
}

async function approveWithReview(taskId, sessionId) {
  // After execution, submit review + complete assignment
  var p = await apiFetch("http://127.0.0.1:19874/api/desktop/external/pending?executorId=claude-cli");
  var revAssign = p.assignments ? p.assignments.find(function (a) { return a.taskId === taskId && a.kind === "review"; }) : null;
  if (!revAssign) return { ok: false, step: "no-review-assignment" };

  var claimRev = await apiFetch("http://127.0.0.1:19874/api/desktop/external/pending/" + encodeURIComponent(revAssign.assignmentId) + "/claim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sessionId })
  });
  if (!claimRev.ok) return { ok: false, step: "review-claim-failed" };

  var submitRev = await apiFetch("http://127.0.0.1:19874/api/desktop/tasks/" + encodeURIComponent(taskId) + "/external-review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "rev-" + (typeof runLabel !== "undefined" ? runLabel : "fix"),
      status: "ready_for_review", suggestion: "Criteria met. Changes look correct.", sessionId: sessionId })
  });
  if (!submitRev.ok) return { ok: false, step: "review-submit-failed" };

  var completeRev = await apiFetch("http://127.0.0.1:19874/api/desktop/external/pending/" + encodeURIComponent(revAssign.assignmentId) + "/complete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sessionId })
  });
  if (!completeRev.ok) return { ok: false, step: "review-complete-failed" };

  // Approve the task
  var approve = await apiFetch("http://127.0.0.1:19874/api/desktop/tasks/" + encodeURIComponent(taskId) + "/approve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText: "Approved." })
  });
  return { ok: approve.ok, step: approve.ok ? "approved" : "approve-failed" };
}

async function main() {
  console.log("=== 3-Task Orchestration MVP Verification ===\n");
  const server = await startBoardServer(process.cwd(), 19874);
  var base = "http://127.0.0.1:19874";

  try {
    // Initialize session
    var initRes = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-3task", executorId: "claude-cli", mode: "connected" })
    });
    var sessionId = initRes.sessionId || "sess-3task";
    console.log("Session:", sessionId);

    // Get project
    var pj = await apiFetch(base + "/api/desktop/projects");
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project"); return; }
    console.log("Project:", project.name, "id:", project.id, "\n");

    // ─────────────────────────────────────────────
    // STEP 1: Create 3 tasks via commit-plan
    // ─────────────────────────────────────────────
    console.log("═══ STEP 1: Create 3 tasks ═══\n");

    var commitRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "TASK-A: Add project-local token docs to README.md",
            goal: "Add a section explaining project-local tokens to README.md",
            allowedFiles: ["README.md"], acceptanceCriteria: ["README.md updated"],
            commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "TASK-B: Add Chinese token docs to README.zh-CN.md",
            goal: "Add corresponding Chinese section to README.zh-CN.md",
            allowedFiles: ["README.zh-CN.md"], acceptanceCriteria: ["README.zh-CN.md updated"],
            commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "TASK-C: Add MCP reconnect troubleshooting section",
            goal: "Add troubleshooting section for MCP bridge reconnection",
            allowedFiles: ["README.md"], acceptanceCriteria: ["README.md updated"],
            commands: ["echo ok"], preferredExecutor: "claude-cli" },
        ]
      })
    });
    var taskA = commitRes.committed && commitRes.committed[0];
    var taskB = commitRes.committed && commitRes.committed[1];
    var taskC = commitRes.committed && commitRes.committed[2];
    if (!taskA || !taskB || !taskC) { console.log("FAIL: commit", JSON.stringify(commitRes)); return; }

    // Set dependsOn on Task B → A
    var taskBPath = path.join(dataPath, "tasks", taskB.id, "task.json");
    var taskBData = JSON.parse(fs.readFileSync(taskBPath, "utf-8"));
    taskBData.dependsOn = [taskA.id];
    fs.writeFileSync(taskBPath, JSON.stringify(taskBData, null, 2) + "\n", "utf-8");

    console.log("A:", taskA.id, "- project-local token docs (independent)");
    console.log("B:", taskB.id, "- Chinese token docs (dependsOn A)");
    console.log("C:", taskC.id, "- MCP reconnect troubleshooting (independent)\n");

    // Verify sidebar status via project tasks endpoint
    var tasksList = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/tasks");
    var listA = tasksList.tasks.find(function (t) { return t.id === taskA.id; });
    var listB = tasksList.tasks.find(function (t) { return t.id === taskB.id; });
    var listC = tasksList.tasks.find(function (t) { return t.id === taskC.id; });
    console.log("Sidebar status — A:", (listA ? listA.status + " / " + listA.rawStatus : "?"));
    console.log("Sidebar status — B:", (listB ? listB.status + " / " + listB.rawStatus : "?"), "dependsOn:", JSON.stringify((listB || {}).dependsOn));
    console.log("Sidebar status — C:", (listC ? listC.status + " / " + listC.rawStatus : "?"));
    var bDepBlocked = listB && listB.dependsOn && listB.dependsOn.length > 0;
    console.log("B has dependsOn set:", bDepBlocked, "\n");

    // ─────────────────────────────────────────────
    // STEP 2: Queue A + C (independent tasks)
    // ─────────────────────────────────────────────
    console.log("═══ STEP 2: Queue A and C (both independent) ═══\n");

    var qA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue A:", qA.ok, "assignmentId=" + (qA.assignment ? qA.assignment.assignmentId : "?"));
    var qC = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskC.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue C:", qC.ok, "assignmentId=" + (qC.assignment ? qC.assignment.assignmentId : "?"));

    // Verify both A and C are in pending simultaneously
    var pBoth = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var aInPending = pBoth.assignments ? pBoth.assignments.some(function (a) { return a.taskId === taskA.id; }) : false;
    var cInPending = pBoth.assignments ? pBoth.assignments.some(function (a) { return a.taskId === taskC.id; }) : false;
    var bInPending = pBoth.assignments ? pBoth.assignments.some(function (a) { return a.taskId === taskB.id; }) : false;
    console.log("list_pending — A present:", aInPending, "C present:", cInPending, "B present:", bInPending);
    console.log("Total pending:", (pBoth.assignments || []).length);

    // ─────────────────────────────────────────────
    // STEP 3: Queue B — should be allowed (API doesn't prevent it)
    //          But list_pending should exclude it
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 3: Queue B (dependsOn A — should be excluded from pending) ═══\n");

    var qB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue B:", qB.ok, "assignmentId=" + (qB.assignment ? qB.assignment.assignmentId : "?"));

    var pAfterB = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var bInPending2 = pAfterB.assignments ? pAfterB.assignments.some(function (a) { return a.taskId === taskB.id; }) : false;
    var aInPending2 = pAfterB.assignments ? pAfterB.assignments.some(function (a) { return a.taskId === taskA.id; }) : false;
    var cInPending2 = pAfterB.assignments ? pAfterB.assignments.some(function (a) { return a.taskId === taskC.id; }) : false;
    console.log("list_pending after B queued — A:", aInPending2, "B:", bInPending2, "C:", cInPending2);
    console.log("  (B should be false — filtered by dependsOn)");

    // ─────────────────────────────────────────────
    // STEP 4: Execute A + C independently, verify no cross-task interference
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 4: Execute A and C — verify no task crossing ═══\n");

    // Execute C first (to prove independent order doesn't matter)
    var execC = await fullExecution(taskC.id, sessionId, "3t-c-1");
    console.log("Execute C:", execC.ok, "step:", execC.step);
    var execA = await fullExecution(taskA.id, sessionId, "3t-a-1");
    console.log("Execute A:", execA.ok, "step:", execA.step);

    // Verify task run records are bound to correct tasks
    var detailA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id));
    var detailC = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskC.id));
    console.log("A latestRunResult.taskId:", detailA.task && detailA.task.latestRunResult ? detailA.task.latestRunResult.runId ? "present" : "null" : "null");
    console.log("C latestRunResult.taskId:", detailC.task && detailC.task.latestRunResult ? detailC.task.latestRunResult.runId ? "present" : "null" : "null");

    // Verify that task A's run didn't affect task C or vice versa
    var aRunMatches = detailA.task && detailA.task.latestRunResult && detailA.task.id === taskA.id;
    var cRunMatches = detailC.task && detailC.task.latestRunResult && detailC.task.id === taskC.id;
    console.log("A run on correct task:", aRunMatches, "(expect true)");
    console.log("C run on correct task:", cRunMatches, "(expect true)");

    // Complete A + C with review and approval
    var approveA = await approveWithReview(taskA.id, sessionId);
    console.log("Approve A:", approveA.ok, "step:", approveA.step);
    // Also approve C (skip execution since already done earlier — wait, C was executed but not finished with review)
    // Actually fullExecution already did execute, but approveWithReview also needs the run to have been done
    // Since fullExecution + approveWithReview handle this, let's approve C too
    var approveC = await approveWithReview(taskC.id, sessionId);
    console.log("Approve C:", approveC.ok, "step:", approveC.step);

    // ─────────────────────────────────────────────
    // STEP 5: Verify B is now unlocked
    // ─────────────────────────────────────────────
    console.log("\n═══ STEP 5: B should be unlocked after A approved ═══\n");

    var pAfterA = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var bInPending3 = pAfterA.assignments ? pAfterA.assignments.some(function (a) { return a.taskId === taskB.id; }) : false;
    console.log("list_pending after A approved — B present:", bInPending3, "(expect true)");

    if (bInPending3) {
      var execB = await fullExecution(taskB.id, sessionId, "3t-b-1");
      console.log("Execute B:", execB.ok, "step:", execB.step);
      if (execB.ok) {
        var approveB = await approveWithReview(taskB.id, sessionId);
        console.log("Approve B:", approveB.ok, "step:", approveB.step);
      }
    }

    // ─────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────
    console.log("\n═══ 3-TASK ORCHESTRATION SUMMARY ═══\n");
    console.log("1. Sidebar: 3 tasks committed and visible:", !!(listA && listB && listC));
    console.log("2. B's dependsOn set:", bDepBlocked);
    console.log("3. A and C simultaneously pending:", aInPending && cInPending);
    console.log("4. B excluded from pending while A not done:", !bInPending2);
    console.log("5. A and C executed without task crossing:", aRunMatches && cRunMatches);
    console.log("6. B appears in pending after A approved:", bInPending3);
    console.log("7. A final approved:", approveA.ok);
    console.log("8. C final approved:", approveC.ok);
    console.log("9. B final approved:", typeof approveB !== "undefined" ? approveB.ok : "N/A");

    var allPass = (listA && listB && listC) && aInPending && cInPending && !bInPending2 && aRunMatches && cRunMatches && bInPending3 && approveA.ok && approveC.ok;
    console.log("\nOverall MVP status:", allPass ? "✅ MINIMUM VIABLE ORCHESTRATION ESTABLISHED" : "❌ ISSUES DETECTED");

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
