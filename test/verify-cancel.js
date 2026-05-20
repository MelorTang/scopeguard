// ── Assignment Recovery / Cancel Semantics Verification ──
// Run with: node test/verify-cancel.js
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

async function executeAndApprove(taskId, sessionId, base, label) {
  var p = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
  var assign = p.assignments ? p.assignments.find(function (a) { return a.taskId === taskId; }) : null;
  if (!assign) return { ok: false, step: "no-assignment" };

  var claim = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(assign.assignmentId) + "/claim", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
  });
  if (!claim.ok) return { ok: false, step: "claim-failed" };

  var start = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskId) + "/external-run/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ executorId: "claude-cli", externalSessionId: label, sessionId: sessionId })
  });
  if (!start.ok) return { ok: false, step: "start-failed" };

  var finish = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskId) + "/external-run/finish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ executorId: "claude-cli", externalSessionId: label, success: true,
      resultSummary: "Done.", changedFiles: ["README.md"], sessionId: sessionId })
  });
  if (!finish.ok) return { ok: false, step: "finish-failed" };

  // Submit review + approve
  var p2 = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
  var rev = p2.assignments ? p2.assignments.find(function (a) { return a.taskId === taskId && a.kind === "review"; }) : null;
  if (rev) {
    await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(rev.assignmentId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
    });
    await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskId) + "/external-review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "rev-" + label,
        status: "ready_for_review", suggestion: "OK.", sessionId: sessionId })
    });
    await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(rev.assignmentId) + "/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
    });
  }
  var approve = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskId) + "/approve", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText: label + " approved." })
  });
  return { ok: approve.ok, step: approve.ok ? "approved" : "approve-failed" };
}

async function taskInPending(taskId, base) {
  var p = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
  return p.assignments ? p.assignments.some(function (a) { return a.taskId === taskId; }) : false;
}

async function main() {
  console.log("=== Assignment Recovery / Cancel Semantics Verification ===\n");
  const server = await startBoardServer(process.cwd(), 19876);
  var base = "http://127.0.0.1:19876";

  try {
    var initRes = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-cancel", executorId: "claude-cli", mode: "connected" })
    });
    var sessionId = initRes.sessionId || "sess-cancel";

    var pj = await apiFetch(base + "/api/desktop/projects");
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project"); return; }

    // ═══════════════════════════════════════════════════════════════
    // SCENARIO A: Cancel frees parallelizable slot
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ Scenario A: Cancel frees parallelizable slot ═══\n");

    var commitRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "CNL-A: Task A", goal: "Add section A to README.md", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli",
            parallelizable: false },
          { title: "CNL-B: Task B", goal: "Add section B to README.md", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli",
            parallelizable: false },
        ]
      })
    });
    var taskA = commitRes.committed && commitRes.committed[0];
    var taskB = commitRes.committed && commitRes.committed[1];
    if (!taskA || !taskB) { console.log("FAIL: commit"); return; }
    console.log("A:", taskA.id, "parallelizable:", taskA.parallelizable);
    console.log("B:", taskB.id, "parallelizable:", taskB.parallelizable);

    // Queue A and B
    var qA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue A:", qA.ok, "id=" + (qA.assignment ? qA.assignment.assignmentId : "?"));
    var qB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue B:", qB.ok, "id=" + (qB.assignment ? qB.assignment.assignmentId : "?"));
    var aAssignId = qA.assignment ? qA.assignment.assignmentId : null;

    // Claim A (makes B blocked by parallelizable)
    var claimA = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(aAssignId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
    });
    console.log("Claim A:", claimA.ok);

    // Check: B is NOT in pending (A is claimed, blocking)
    var b1 = await taskInPending(taskB.id, base);
    console.log("B in pending (A claimed):", b1, "(expect false — A is claimed, blocks parallelizable:false)");

    // Cancel A's assignment
    var cancelA = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(aAssignId) + "/cancel", {
      method: "POST"
    });
    console.log("Cancel A:", cancelA.ok, "status=" + (cancelA.assignment ? cancelA.assignment.status : "?"));

    // Check: A's assignment is now canceled
    var aCanceled = cancelA.assignment && cancelA.assignment.status === "canceled";
    console.log("A assignment status is 'canceled':", aCanceled, "(expect true)");

    // Check: B IS now in pending (slot freed)
    var b2 = await taskInPending(taskB.id, base);
    console.log("B in pending (A canceled):", b2, "(expect true — slot freed)");

    // Verify A's task status is back to 'ready'
    var detailA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id));
    var aReady = detailA.task && detailA.task.rawStatus === "ready";
    console.log("A task status is 'ready':", aReady, "(expect true — available for re-queue)");
    // Verify A no longer has latestRunResult or latestReviewSummary
    var aNoRun = detailA.task && !detailA.task.latestRunResult;
    var aNoReview = detailA.task && !detailA.task.latestReviewSummary;
    console.log("A latestRunResult cleared:", aNoRun, "(expect true)");
    console.log("A latestReviewSummary cleared:", aNoReview, "(expect true)");

    // Execute and approve B
    var execB = await executeAndApprove(taskB.id, sessionId, base, "cnl-b");
    console.log("B executed and approved:", execB.ok, execB.step);

    // ═══════════════════════════════════════════════════════════════
    // SCENARIO B: Cancel allows re-queue
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Scenario B: Cancel allows re-queue ═══\n");

    var commitRes2 = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "CNL-C: Task C", goal: "Add section C to README.md", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli",
            parallelizable: false },
        ]
      })
    });
    var taskC = commitRes2.committed && commitRes2.committed[0];
    if (!taskC) { console.log("FAIL: commit2"); return; }
    console.log("C:", taskC.id);

    // Queue C
    var qC = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskC.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue C:", qC.ok, "id=" + (qC.assignment ? qC.assignment.assignmentId : "?"));
    var cAssignId = qC.assignment ? qC.assignment.assignmentId : null;

    // Claim C
    var claimC = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(cAssignId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
    });
    console.log("Claim C:", claimC.ok);

    // Cancel C
    var cancelC = await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(cAssignId) + "/cancel", {
      method: "POST"
    });
    console.log("Cancel C:", cancelC.ok, "status=" + (cancelC.assignment ? cancelC.assignment.status : "?"));

    // Re-queue C — should succeed (no active pending/claimed assignment)
    var qC2 = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskC.id) + "/queue-assignment", { method: "POST" });
    console.log("Re-queue C:", qC2.ok, "id=" + (qC2.assignment ? qC2.assignment.assignmentId : "?"));
    var canRequeue = qC2.ok && qC2.assignment && qC2.assignment.status === "pending";
    console.log("Re-queue succeeded:", canRequeue, "(expect true — fresh assignment created)");

    // Execute and approve C from the new assignment
    var execC = await executeAndApprove(taskC.id, sessionId, base, "cnl-c");
    console.log("C executed and approved:", execC.ok, execC.step);

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ CANCEL VERIFICATION SUMMARY ═══\n");
    console.log("Scenario A (cancel frees parallelizable slot):");
    console.log("  1. B blocked while A claimed:", !b1, "(expect true)");
    console.log("  2. Cancel returns canceled status:", aCanceled, "(expect true)");
    console.log("  3. B visible after A canceled:", b2, "(expect true)");
    console.log("  4. A task status back to Ready:", aReady, "(expect true)");
    console.log("  5. A latestRunResult cleared:", aNoRun, "(expect true)");
    console.log("  6. A latestReviewSummary cleared:", aNoReview, "(expect true)");
    console.log("");
    console.log("Scenario B (cancel allows re-queue):");
    console.log("  7. Re-queue succeeds after cancel:", canRequeue, "(expect true)");
    console.log("  8. Final execution succeeds:", execC.ok, "(expect true)");

    var pass = !b1 && aCanceled && b2 && aReady && aNoRun && aNoReview && canRequeue && execC.ok;
    console.log("\nOverall:", pass ? "✅ ALL PASSED" : "❌ ISSUES DETECTED");

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
