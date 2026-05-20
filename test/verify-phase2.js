// ── Phase 2 Verification: Review Actor + dependsOn ──
// Run with: node test/verify-phase2.js
const { startBoardServer } = require("../apps/server/dist/index.js");
const dataPath = require("node:path").join(process.cwd(), ".scopeguard");

const fs = require("fs");
const path = require("path");
let BEARER_TOKEN = "";
try {
  const tokenPath = path.join(dataPath, "config", "external-api-token.json");
  const tokenData = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  BEARER_TOKEN = tokenData.token || "";
} catch { /* no token file */ }

function apiFetch(url, opts) {
  if (!opts) opts = {};
  var headers = Object.assign({}, opts.headers || {});
  if (url.indexOf("/external/") >= 0 || url.indexOf("/external-") >= 0) {
    headers["authorization"] = "Bearer " + BEARER_TOKEN;
  }
  return fetch(url, Object.assign({}, opts, { headers })).then(function (r) { return r.json(); });
}

async function main() {
  console.log("=== Phase 2 Verification Suite ===\n");

  const server = await startBoardServer(process.cwd(), 19875);
  var base = "http://127.0.0.1:19875";
  function api(p) { return base + p; }

  try {
    // Get project
    var pj = await apiFetch(api("/api/desktop/projects"));
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project found"); return; }
    var pid = project.id;
    console.log("Project:", project.name, "id:", pid);

    // ═══════════════════════════════════════
    // VERIFICATION A: Review Actor
    // ═══════════════════════════════════════
    console.log("\n═══ VERIFICATION A: Real Review Actor ═══\n");

    var commitRes = await apiFetch(api("/api/desktop/projects/" + encodeURIComponent(pid) + "/commit-plan"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [{
          title: "VERIFY-A: Add test section",
          goal: "Add a section to README.md",
          allowedFiles: ["README.md"],
          acceptanceCriteria: ["README.md updated"],
          commands: ["echo ok"],
          preferredExecutor: "claude-cli",
        }]
      })
    });
    var taskA = commitRes.committed && commitRes.committed[0];
    if (!taskA) { console.log("FAIL: commit result:", JSON.stringify(commitRes)); return; }
    console.log("1. Task created: id=" + taskA.id + " title=" + taskA.title);

    // Queue
    var queueRes = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/queue-assignment"), { method: "POST" });
    console.log("2. Queued: assignmentId=" + (queueRes.assignment ? queueRes.assignment.assignmentId : "?"));

    // list_pending
    var pending1 = await apiFetch(api("/api/desktop/external/pending?executorId=claude-cli"));
    var foundPending = (pending1.assignments || []).some(function (a) { return a.taskId === taskA.id; });
    console.log("3. list_pending includes task A: " + foundPending + " (count=" + (pending1.assignments || []).length + ")");

    var claimId = (pending1.assignments || []).find(function (a) { return a.taskId === taskA.id; }).assignmentId;

    // Claim
    var claimRes = await apiFetch(api("/api/desktop/external/pending/" + encodeURIComponent(claimId) + "/claim"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "verify-session" })
    });
    console.log("4. Claimed: ok=" + claimRes.ok);

    // Initialize an external session first
    var initRes = await apiFetch(api("/api/desktop/external/initialize"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-test", executorId: "claude-cli", mode: "connected" })
    });
    var sessionId = initRes.sessionId || "verify-session";
    console.log("   Session: id=" + sessionId);

    // Start external run
    var startRes = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/start"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "v-run-1", sessionId: sessionId })
    });
    console.log("5. Run started: ok=" + startRes.ok);

    // Finish run (auto-creates review)
    var finishRes = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/finish"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "v-run-1", success: true,
        resultSummary: "Done.", changedFiles: ["README.md"], sessionId: sessionId })
    });
    console.log("6. Run finished: ok=" + finishRes.ok);

    // Check auto-review reviewId
    var taskAfterRun = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskA.id)));
    var autoReviewId = taskAfterRun.task && taskAfterRun.task.latestReviewSummary ? taskAfterRun.task.latestReviewSummary.reviewId : "null";
    console.log("7. Auto-review reviewId: " + autoReviewId + " (should be review-...)");

    // Check review assignment in pending
    var pending2 = await apiFetch(api("/api/desktop/external/pending?executorId=claude-cli"));
    var reviewAssignment = null;
    if (pending2.assignments) {
      for (var i = 0; i < pending2.assignments.length; i++) {
        if (pending2.assignments[i].taskId === taskA.id && pending2.assignments[i].kind === "review") {
          reviewAssignment = pending2.assignments[i];
        }
      }
    }
    console.log("8. Review assignment in pending: " + (reviewAssignment ? reviewAssignment.assignmentId : "NONE"));

    if (reviewAssignment) {
      // Try complete WITHOUT submit_review (should be blocked)
      var completeNoReview = await apiFetch(api("/api/desktop/external/pending/" + encodeURIComponent(reviewAssignment.assignmentId) + "/complete"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
      });
      console.log("9. Complete review WITHOUT submit_review: ok=" + completeNoReview.ok + " code=" + (completeNoReview.code || "?") + " (expect REVIEW_REQUIRED)");

      // Claim review
      var claimReviewRes = await apiFetch(api("/api/desktop/external/pending/" + encodeURIComponent(reviewAssignment.assignmentId) + "/claim"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
      });
      console.log("10. Review claimed: ok=" + claimReviewRes.ok);

      // Submit real review
      var reviewSubmitRes = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-review"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "v-review-1",
          status: "ready_for_review", suggestion: "All criteria met. Looks good.", sessionId: sessionId })
      });
      console.log("11. External review submitted: ok=" + reviewSubmitRes.ok);

      // Check reviewId after external review
      var taskAfterReview = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskA.id)));
      var externalReviewId = taskAfterReview.task && taskAfterReview.task.latestReviewSummary ? taskAfterReview.task.latestReviewSummary.reviewId : "null";
      console.log("12. After review, reviewId: " + externalReviewId + " (should be external-...)");

      // Complete review AFTER submit_review (should pass)
      var completeWithReview = await apiFetch(api("/api/desktop/external/pending/" + encodeURIComponent(reviewAssignment.assignmentId) + "/complete"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
      });
      console.log("13. Complete review AFTER submit_review: ok=" + completeWithReview.ok + " (expect true)");
    }

    // ═══════════════════════════════════════
    // VERIFICATION B: dependsOn
    // ═══════════════════════════════════════
    console.log("\n═══ VERIFICATION B: dependsOn Multi-Task ═══\n");

    var commitRes2 = await apiFetch(api("/api/desktop/projects/" + encodeURIComponent(pid) + "/commit-plan"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "VERIFY-B-A: Add X to README", goal: "Add X section", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "VERIFY-B-B: Add X to README.zh-CN.md", goal: "Add Chinese X section", allowedFiles: ["README.zh-CN.md"],
            acceptanceCriteria: ["README.zh-CN.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" }
        ]
      })
    });
    var taskB1 = commitRes2.committed && commitRes2.committed[0];
    var taskB2 = commitRes2.committed && commitRes2.committed[1];
    if (!taskB1 || !taskB2) { console.log("FAIL: commit result:", JSON.stringify(commitRes2)); return; }

    // Set dependsOn on task B2
    var taskB2Path = path.join(dataPath, "tasks", taskB2.id, "task.json");
    var taskB2Data = JSON.parse(fs.readFileSync(taskB2Path, "utf-8"));
    taskB2Data.dependsOn = [taskB1.id];
    fs.writeFileSync(taskB2Path, JSON.stringify(taskB2Data, null, 2) + "\n", "utf-8");
    console.log("1. Tasks: A=" + taskB1.id + " B=" + taskB2.id + " dependsOn: " + taskB2.id + " -> " + taskB1.id);

    // Queue B first
    var queueB = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskB2.id) + "/queue-assignment"), { method: "POST" });
    console.log("2. Queued B first: assignmentId=" + (queueB.assignment ? queueB.assignment.assignmentId : "?"));

    // list_pending before A completed — should NOT include B
    var pendingBeforeA = await apiFetch(api("/api/desktop/external/pending?executorId=claude-cli"));
    var bBefore = pendingBeforeA.assignments ? pendingBeforeA.assignments.some(function (a) { return a.taskId === taskB2.id; }) : false;
    console.log("3. list_pending before A done: includes B=" + bBefore + " (expect false) count=" + ((pendingBeforeA.assignments || []).length));

    // Queue task A
    var queueA = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskB1.id) + "/queue-assignment"), { method: "POST" });
    console.log("4. Queued A: assignmentId=" + (queueA.assignment ? queueA.assignment.assignmentId : "?"));

    // Complete task A: claim → execute → finish → approve (skip review)
    var pA = await apiFetch(api("/api/desktop/external/pending?executorId=claude-cli"));
    var aPending = pA.assignments ? pA.assignments.find(function (a) { return a.taskId === taskB1.id; }) : null;
    if (aPending) {
      await apiFetch(api("/api/desktop/external/pending/" + encodeURIComponent(aPending.assignmentId) + "/claim"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
      });
      await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskB1.id) + "/external-run/start"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "v-b-a", sessionId: sessionId })
      });
      await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskB1.id) + "/external-run/finish"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "v-b-a", success: true,
          resultSummary: "Done.", changedFiles: ["README.md"], sessionId: sessionId })
      });
      // Approve task A
      var approveA = await apiFetch(api("/api/desktop/tasks/" + encodeURIComponent(taskB1.id) + "/approve"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText: "Approved." })
      });
      console.log("5. Task A approved: ok=" + approveA.ok + " rawStatus=" + ((approveA.task || {}).rawStatus));
    }

    // list_pending after A completed — should NOW include B
    var pendingAfterA = await apiFetch(api("/api/desktop/external/pending?executorId=claude-cli"));
    var bAfter = pendingAfterA.assignments ? pendingAfterA.assignments.some(function (a) { return a.taskId === taskB2.id; }) : false;
    console.log("6. list_pending after A done: includes B=" + bAfter + " (expect true)");
    if (pendingAfterA.assignments) {
      for (var j = 0; j < pendingAfterA.assignments.length; j++) {
        var aa = pendingAfterA.assignments[j];
        console.log("   - pending: " + aa.assignmentId + " task=" + aa.taskId + " kind=" + (aa.kind || "?"));
      }
    }

    // ═══════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════
    console.log("\n═══ VERIFICATION SUMMARY ═══\n");
    console.log("Review Actor:");
    console.log("  Auto-review reviewId prefix 'review-': " + autoReviewId.startsWith("review-"));
    console.log("  External-review reviewId prefix 'external-': " + (typeof externalReviewId === "string" ? externalReviewId.startsWith("external-") : "N/A"));
    console.log("  Finish without submit_review BLOCKED: " + (completeNoReview && !completeNoReview.ok));
    console.log("  Finish after submit_review PASSED: " + (completeWithReview && completeWithReview.ok));
    console.log("");
    console.log("dependsOn:");
    console.log("  B excluded from pending when A not done: " + !bBefore);
    console.log("  B appears in pending after A completed: " + bAfter);

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
