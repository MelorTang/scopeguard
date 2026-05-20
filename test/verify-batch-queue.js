// ── Batch Queue Verification ──
// Run with: node test/verify-batch-queue.js
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

async function main() {
  console.log("=== Batch Queue Verification ===\n");
  const server = await startBoardServer(process.cwd(), 19877);
  var base = "http://127.0.0.1:19877";

  try {
    var initRes = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-batch", executorId: "claude-cli", mode: "connected" })
    });
    var sessionId = initRes.sessionId || "sess-batch";

    var pj = await apiFetch(base + "/api/desktop/projects");
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project"); return; }

    // ═══════════════════════════════════════════════════════════════
    // Create 3-task project: A (ready), B (dependsOn A), C (ready)
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ Create 3-task project: A (ready), B (dependsOn A), C (ready) ═══\n");

    var commitRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "BAT-A: Task A", goal: "Add section A", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "BAT-B: Task B", goal: "Add section B", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "BAT-C: Task C", goal: "Add section C", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
        ]
      })
    });
    var taskA = commitRes.committed && commitRes.committed[0];
    var taskB = commitRes.committed && commitRes.committed[1];
    var taskC = commitRes.committed && commitRes.committed[2];
    if (!taskA || !taskB || !taskC) { console.log("FAIL: commit"); return; }
    console.log("A:", taskA.id, "title:", taskA.title);
    console.log("B:", taskB.id, "title:", taskB.title);
    console.log("C:", taskC.id, "title:", taskC.title);

    // Set dependsOn on B → A
    var taskBPath = path.join(dataPath, "tasks", taskB.id, "task.json");
    var taskBData = JSON.parse(fs.readFileSync(taskBPath, "utf-8"));
    taskBData.dependsOn = [taskA.id];
    fs.writeFileSync(taskBPath, JSON.stringify(taskBData, null, 2) + "\n", "utf-8");
    console.log("B dependsOn set to:", taskBData.dependsOn);

    // ═══════════════════════════════════════════════════════════════
    // Check 1: Project summary shows correct counts before batch
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Check 1: Project summary before batch ═══\n");

    var tasksRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/tasks");
    var summary = tasksRes.summary || {};
    console.log("Summary:", JSON.stringify(summary, null, 2));
    var c1_readyAtLeast = summary.readyToQueue >= 2; // A and C ready; B blocked by dependency
    var c1_noQueued = summary.queued === 0;
    console.log("readyToQueue >= 2:", c1_readyAtLeast, "(expect true — A and C ready, B blocked by dependency)");
    console.log("blockedByDependency >= 1:", summary.blockedByDependency >= 1, "(expect true — B blocked by dependency)");
    console.log("queued=0:", c1_noQueued, "(expect true)");

    // ═══════════════════════════════════════════════════════════════
    // Check 2: Batch queue — A and C should queue, B should skip (dependsOn A)
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Check 2: Batch queue — A and C queued, B skipped ═══\n");

    var batchRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/queue-ready", {
      method: "POST"
    });
    console.log("Batch queue result:", JSON.stringify({
      ok: batchRes.ok,
      queuedCount: (batchRes.queued || []).length,
      skippedCount: (batchRes.skipped || []).length,
      queuedIds: batchRes.queued || [],
      skippedInfo: (batchRes.skipped || []).map(function (s) { return { id: s.taskId, code: s.code }; }),
    }, null, 2));

    var aQueued = batchRes.queued && batchRes.queued.indexOf(taskA.id) >= 0;
    var bSkipped = batchRes.skipped && batchRes.skipped.some(function (s) { return s.taskId === taskB.id; });
    var cQueued = batchRes.queued && batchRes.queued.indexOf(taskC.id) >= 0;

    console.log("A queued:", aQueued, "(expect true — ready, no dependsOn)");
    console.log("B skipped (dependsOn A):", bSkipped, "(expect true — A not approved yet)");
    console.log("C queued:", cQueued, "(expect true — ready, no dependsOn)");

    // ═══════════════════════════════════════════════════════════════
    // Check 3: Execute and approve A
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Check 3: Execute and approve A ═══\n");

    var execA = await executeAndApprove(taskA.id, sessionId, base, "bat-a");
    console.log("A executed and approved:", execA.ok, execA.step, "(expect true)");

    // ═══════════════════════════════════════════════════════════════
    // Check 4: After A done, summary shows B ready to queue
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Check 4: Summary after A approved — B should be ready ═══\n");

    var tasksRes2 = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/tasks");
    var summary2 = tasksRes2.summary || {};
    console.log("Summary:", JSON.stringify(summary2, null, 2));

    // After A is approved, B's dep is satisfied. But A has a completed assignment,
    // so dispatchInfo shows "dispatched" for A (it has a completed assignment? No — it was completed).
    // Actually, after approve, A is in "approved" status. B's dependsOn is now satisfied.
    // But B might not appear in readyToQueue if it was already queued earlier...
    // Wait, B was SKIPPED during batch queue, so it was never queued.
    // After A is approved, B should show as readyToQueue.
    var c2_bReady = summary2.readyToQueue >= 1; // At least B should be ready to queue
    console.log("readyToQueue >= 1 (B should be ready):", c2_bReady, "(expect true)");

    // ═══════════════════════════════════════════════════════════════
    // Check 5: Batch queue again — B should now queue
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Check 5: Batch queue again — B should queue now ═══\n");

    var batchRes2 = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/queue-ready", {
      method: "POST"
    });
    var bQueued = batchRes2.queued && batchRes2.queued.indexOf(taskB.id) >= 0;
    console.log("B queued in 2nd batch:", bQueued, "(expect true — A is approved, dep satisfied)");

    // Execute and approve B
    if (bQueued) {
      var execB = await executeAndApprove(taskB.id, sessionId, base, "bat-b");
      console.log("B executed and approved:", execB.ok, execB.step, "(expect true)");
    }

    // ═══════════════════════════════════════════════════════════════
    // Check 6: Execute C
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ Check 6: Execute C (was queued in first batch) ═══\n");

    var execC = await executeAndApprove(taskC.id, sessionId, base, "bat-c");
    console.log("C executed and approved:", execC.ok, execC.step, "(expect true)");

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ BATCH QUEUE VERIFICATION SUMMARY ═══\n");
    console.log("1. Summary shows readyToQueue >= 2 (A+C ready):", c1_readyAtLeast, "(expect true)");
    console.log("2. Summary shows queued=0 initially:", c1_noQueued, "(expect true)");
    console.log("3. A queued in batch:", aQueued, "(expect true)");
    console.log("4. B skipped (dependsOn A):", bSkipped, "(expect true)");
    console.log("5. C queued in batch:", cQueued, "(expect true)");
    console.log("6. A executed and approved:", execA.ok, "(expect true)");
    console.log("7. B ready after A approved:", c2_bReady, "(expect true)");
    console.log("8. B queued in 2nd batch:", bQueued, "(expect true)");
    console.log("9. B executed and approved:", typeof execB !== "undefined" ? execB.ok : "N/A", "(expect true)");
    console.log("10. C executed and approved:", execC.ok, "(expect true)");

    var pass = c1_readyAtLeast && c1_noQueued && aQueued && bSkipped && cQueued && execA.ok && c2_bReady && bQueued && execC.ok;
    console.log("\nOverall:", pass ? "✅ ALL PASSED" : "❌ ISSUES DETECTED");

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
