// ── Batch Cancel Verification ──
// Verifies that "Cancel active dispatches" clears all pending/claimed
// execution assignments in a project and resets tasks to ready.
// Run with: node test/verify-batch-cancel.js
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
  console.log("=== Batch Cancel Verification ===\n");
  const server = await startBoardServer(process.cwd(), 19880);
  var base = "http://127.0.0.1:19880";

  try {
    var initRes = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-bc", executorId: "claude-cli", mode: "connected" })
    });
    var sessionId = initRes.sessionId || "sess-bc";

    var pj = await apiFetch(base + "/api/desktop/projects");
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project"); return; }

    // ═══════════════════════════════════════════════════════════════
    // Create 3 tasks: A, B (dependsOn A), C — all ready to queue
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ Create tasks A (ready), B (dependsOn A), C (ready) ═══\n");

    var commitRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "BC-A: Task A", goal: "Add A", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "BC-B: Task B", goal: "Add B", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
          { title: "BC-C: Task C", goal: "Add C", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli" },
        ]
      })
    });
    var taskA = commitRes.committed && commitRes.committed[0];
    var taskB = commitRes.committed && commitRes.committed[1];
    var taskC = commitRes.committed && commitRes.committed[2];
    if (!taskA || !taskB || !taskC) { console.log("FAIL: commit"); return; }

    // Set B dependsOn A
    var taskBPath = path.join(dataPath, "tasks", taskB.id, "task.json");
    var taskBData = JSON.parse(fs.readFileSync(taskBPath, "utf-8"));
    taskBData.dependsOn = [taskA.id];
    fs.writeFileSync(taskBPath, JSON.stringify(taskBData, null, 2) + "\n", "utf-8");
    console.log("A:", taskA.id, "B:", taskB.id, "(dependsOn A)", "C:", taskC.id);

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Batch queue → A and C queued, B skipped
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ STEP 1: Batch queue — A and C queued, B skipped ═══\n");

    var bq = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/queue-ready", { method: "POST" });
    console.log("Queued:", (bq.queued || []).length, "Skipped:", (bq.skipped || []).length);
    var aQueued = bq.queued && bq.queued.indexOf(taskA.id) >= 0;
    var bSkipped = bq.skipped && bq.skipped.some(function (s) { return s.taskId === taskB.id; });
    var cQueued = bq.queued && bq.queued.indexOf(taskC.id) >= 0;
    console.log("A queued:", aQueued, "(expect true)");
    console.log("B skipped (dependsOn):", bSkipped, "(expect true)");
    console.log("C queued:", cQueued, "(expect true)");

    // Verify project summary shows 2 queued
    var tl = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/tasks");
    console.log("Summary before cancel: queued=" + tl.summary.queued + " (expect >= 2)");
    var hadQueued = tl.summary.queued >= 2;

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Cancel active dispatches
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ STEP 2: Cancel active dispatches ═══\n");

    var cancelRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/cancel-dispatches", {
      method: "POST"
    });
    console.log("Cancel result:", JSON.stringify({
      ok: cancelRes.ok,
      canceledCount: (cancelRes.canceled || []).length,
      skippedCount: (cancelRes.skipped || []).length,
    }, null, 2));

    var aCanceled = cancelRes.canceled && cancelRes.canceled.indexOf(taskA.id) >= 0;
    var cCanceled = cancelRes.canceled && cancelRes.canceled.indexOf(taskC.id) >= 0;
    console.log("A canceled:", aCanceled, "(expect true)");
    console.log("C canceled:", cCanceled, "(expect true)");

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Verify tasks returned to ready state
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ STEP 3: Verify tasks returned to ready state ═══\n");

    var tl2 = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/tasks");
    console.log("Summary after cancel:", JSON.stringify(tl2.summary, null, 2));

    var aReady = tl2.tasks.filter(function (t) { return t.id === taskA.id; })[0];
    var cReady = tl2.tasks.filter(function (t) { return t.id === taskC.id; })[0];
    console.log("A rawStatus:", aReady ? aReady.rawStatus : "?", "(expect 'ready')");
    console.log("C rawStatus:", cReady ? cReady.rawStatus : "?", "(expect 'ready')");
    var aStatusOk = aReady && aReady.rawStatus === "ready";
    var cStatusOk = cReady && cReady.rawStatus === "ready";
    var queuedNowZero = tl2.summary.queued === 0;

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Can re-queue after cancel
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ STEP 4: Can re-queue after cancel ═══\n");

    var bq2 = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/queue-ready", { method: "POST" });
    console.log("Re-queue after cancel: queued=" + (bq2.queued || []).length);
    var aRequeued = bq2.queued && bq2.queued.indexOf(taskA.id) >= 0;
    var cRequeued = bq2.queued && bq2.queued.indexOf(taskC.id) >= 0;
    console.log("A re-queued:", aRequeued, "(expect true)");
    console.log("C re-queued:", cRequeued, "(expect true)");

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ BATCH CANCEL VERIFICATION SUMMARY ═══\n");
    console.log("1.  A and C queued initially:", aQueued && cQueued, "(expect true)");
    console.log("2.  B skipped (dependsOn):", bSkipped, "(expect true)");
    console.log("3.  Summary shows queued >= 2:", hadQueued, "(expect true)");
    console.log("4.  A canceled:", aCanceled, "(expect true)");
    console.log("5.  C canceled:", cCanceled, "(expect true)");
    console.log("6.  A status back to 'ready':", aStatusOk, "(expect true)");
    console.log("7.  C status back to 'ready':", cStatusOk, "(expect true)");
    console.log("8.  Summary queued=0 after cancel:", queuedNowZero, "(expect true)");
    console.log("9.  A re-queued:", aRequeued, "(expect true)");
    console.log("10. C re-queued:", cRequeued, "(expect true)");

    var pass = aQueued && cQueued && bSkipped && hadQueued && aCanceled && cCanceled && aStatusOk && cStatusOk && queuedNowZero && aRequeued && cRequeued;
    console.log("\nOverall:", pass ? "✅ ALL PASSED" : "❌ ISSUES DETECTED");

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
