// ── Parallelizable verification ──
// Run with: node test/verify-parallelizable.js
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
  // Find and claim the execution assignment
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
  console.log("=== parallelizable Verification ===\n");
  const server = await startBoardServer(process.cwd(), 19873);
  var base = "http://127.0.0.1:19873";

  try {
    var initRes = await apiFetch(base + "/api/desktop/external/initialize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "verify-par", executorId: "claude-cli", mode: "connected" })
    });
    var sessionId = initRes.sessionId || "sess-par";

    var pj = await apiFetch(base + "/api/desktop/projects");
    var project = pj.projects && pj.projects[0];
    if (!project) { console.log("No project"); return; }

    // ═══════════════════════════════════════════════════════════════
    // SCENARIO A: Two parallelizable:false tasks
    //   Semantic: parallelizable:false blocks when the executor has
    //   a CLAIMED (actively executing) non-parallelizable task.
    //   Pending (unclaimed) tasks do NOT block each other.
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ Scenario A: Both parallelizable:false ═══\n");

    var commitRes = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "PAR-A: Add section A", goal: "Add section A to README.md", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli",
            parallelizable: false },
          { title: "PAR-B: Add section B", goal: "Add section B to README.md", allowedFiles: ["README.md"],
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

    // Queue both (order matters: A first, B second)
    var qA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue A:", qA.ok, "id=" + (qA.assignment ? qA.assignment.assignmentId : "?"));
    var qB = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskB.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue B:", qB.ok, "id=" + (qB.assignment ? qB.assignment.assignmentId : "?"));

    // ── Check 1: Both pending, nothing claimed → both visible ──
    var a1 = await taskInPending(taskA.id, base);
    var b1 = await taskInPending(taskB.id, base);
    console.log("\nCheck 1 (both pending, nothing claimed):");
    console.log("  A in pending:", a1, "(expect true — no claimed exec, no block)");
    console.log("  B in pending:", b1, "(expect true — no claimed exec, no block)");

    // ── Check 2: After claiming A, B should be blocked ──
    var pAll = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var aAssign = pAll.assignments ? pAll.assignments.find(function (a) { return a.taskId === taskA.id; }) : null;
    if (!aAssign) { console.log("FAIL: A assignment not in pending"); return; }
    await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(aAssign.assignmentId) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
    });

    var a2 = await taskInPending(taskA.id, base);
    var b2 = await taskInPending(taskB.id, base);
    console.log("\nCheck 2 (A claimed, B pending):");
    console.log("  A in pending:", a2, "(expect false — A is now claimed, not pending)");
    console.log("  B in pending:", b2, "(expect false — A is claimed+executing, blocks parallelizable:false)");

    // ── Check 3: After A finishes, B should appear ──
    // Start + Finish A's run (assignment auto-completes on finish)
    await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "par-a", sessionId: sessionId })
    });
    await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-run/finish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "par-a", success: true,
        resultSummary: "Done.", changedFiles: ["README.md"], sessionId: sessionId })
    });

    // Submit review + complete review assignment + approve A
    var pAfterRun = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var revA = pAfterRun.assignments ? pAfterRun.assignments.find(function (a) { return a.taskId === taskA.id && a.kind === "review"; }) : null;
    if (revA) {
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(revA.assignmentId) + "/claim", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
      });
      await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/external-review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ executorId: "claude-cli", externalSessionId: "rev-par-a",
          status: "ready_for_review", suggestion: "OK.", sessionId: sessionId })
      });
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(revA.assignmentId) + "/complete", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
      });
    }
    var approveA = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskA.id) + "/approve", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText: "A approved." })
    });
    console.log("A approved:", approveA.ok);

    var b3 = await taskInPending(taskB.id, base);
    console.log("\nCheck 3 (after A done):");
    console.log("  B in pending:", b3, "(expect true — no claimed exec for executor)");

    // Clean up B for next scenario
    var execB = await executeAndApprove(taskB.id, sessionId, base, "par-b");
    console.log("B cleanup:", execB.ok, execB.step, "\n");

    // ═══════════════════════════════════════════════════════════════
    // SCENARIO B: parallelizable:false + parallelizable:true
    //   The parallelizable:true task bypasses the block even if
    //   there's a claimed execution for the same executor.
    // ═══════════════════════════════════════════════════════════════
    console.log("═══ Scenario B: false + true (independent tasks) ═══\n");

    var commitRes2 = await apiFetch(base + "/api/desktop/projects/" + encodeURIComponent(project.id) + "/commit-plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "PAR-C: Add section C", goal: "Add section C to README.md", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli",
            parallelizable: false },
          { title: "PAR-D: Add section D", goal: "Add section D to README.md", allowedFiles: ["README.md"],
            acceptanceCriteria: ["README.md updated"], commands: ["echo ok"], preferredExecutor: "claude-cli",
            parallelizable: true },
        ]
      })
    });
    var taskC = commitRes2.committed && commitRes2.committed[0];
    var taskD = commitRes2.committed && commitRes2.committed[1];
    if (!taskC || !taskD) { console.log("FAIL: commit2"); return; }
    console.log("C:", taskC.id, "parallelizable:", taskC.parallelizable);
    console.log("D:", taskD.id, "parallelizable:", taskD.parallelizable);

    // Queue both
    var qC = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskC.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue C:", qC.ok);
    var qD = await apiFetch(base + "/api/desktop/tasks/" + encodeURIComponent(taskD.id) + "/queue-assignment", { method: "POST" });
    console.log("Queue D:", qD.ok);

    // ── Check: Both visible (nothing claimed) ──
    var c1 = await taskInPending(taskC.id, base);
    var d1 = await taskInPending(taskD.id, base);
    console.log("\nCheck (neither claimed yet):");
    console.log("  C(false) in pending:", c1, "(expect true — no claimed exec)");
    console.log("  D(true) in pending:", d1, "(expect true — parallelizable:true bypasses)");

    // ── After claiming C, D(true) should still be visible ──
    var pAll2 = await apiFetch(base + "/api/desktop/external/pending?executorId=claude-cli");
    var cAssign = pAll2.assignments ? pAll2.assignments.find(function (a) { return a.taskId === taskC.id; }) : null;
    if (cAssign) {
      await apiFetch(base + "/api/desktop/external/pending/" + encodeURIComponent(cAssign.assignmentId) + "/claim", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId })
      });
    }

    var c2 = await taskInPending(taskC.id, base);
    var d2 = await taskInPending(taskD.id, base);
    console.log("\nCheck (C claimed, D pending):");
    console.log("  C(false) in pending:", c2, "(expect false — C is now claimed)");
    console.log("  D(true) in pending:", d2, "(expect true — parallelizable:true bypasses claimed block)");

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log("\n═══ PARALLELIZABLE SUMMARY ═══\n");
    console.log("Scenario A (both false):");
    console.log("  1. Both visible when neither claimed:", a1 && b1, "(expect true)");
    console.log("  2. B hidden after A claimed:", !b2, "(expect true)");
    console.log("  3. B visible after A done:", b3, "(expect true)");
    console.log("");
    console.log("Scenario B (false + true):");
    console.log("  4. C(false) visible when nothing claimed:", c1, "(expect true)");
    console.log("  5. D(true) visible when nothing claimed:", d1, "(expect true)");
    console.log("  6. D(true) still visible after C claimed:", d2, "(expect true — bypasses)");

    var pass = a1 && b1 && !b2 && b3 && c1 && d1 && d2;
    console.log("\nOverall:", pass ? "✅ ALL PASSED" : "❌ ISSUES DETECTED");

  } finally {
    await server.close();
    console.log("\nDone.");
  }
}

main().catch(function (err) { console.error("FATAL:", err); process.exit(1); });
