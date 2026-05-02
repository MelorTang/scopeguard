(function () {
  const { createElement: h, useEffect, useMemo, useState } = React;

  const STATUS_COLUMNS = [
    { key: "backlog", label: "Backlog" },
    { key: "planned", label: "Planned" },
    { key: "ready", label: "Ready" },
    { key: "blocked", label: "Blocked" },
    { key: "in_progress", label: "In Progress" },
    { key: "needs_review", label: "Needs Review" },
    { key: "test_failed", label: "Test Failed" },
    { key: "conflict", label: "Conflict" },
    { key: "approved", label: "Approved" },
    { key: "merged", label: "Merged" },
    { key: "closed", label: "Closed" }
  ];
  const VERIFY_ENABLED = new Set(["needs_review", "test_failed", "approved", "conflict"]);
  const FIX_SCOPE_ENABLED = new Set(["test_failed", "needs_review", "conflict"]);
  const REVIEW_ENABLED = new Set(["ready", "blocked", "needs_review", "test_failed", "approved", "merged", "conflict", "closed"]);
  const OPEN_REVIEW_ENABLED = new Set(["ready", "blocked", "needs_review", "test_failed", "approved", "merged", "conflict", "closed"]);
  const DISCARD_ENABLED = new Set(["ready", "blocked", "in_progress", "needs_review", "test_failed", "conflict"]);

  function App() {
    const [project, setProject] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [locks, setLocks] = useState({ locks: [] });
    const [selectedTaskId, setSelectedTaskId] = useState(null);
    const [error, setError] = useState("");
    const [actionMessage, setActionMessage] = useState("");
    const [runningAction, setRunningAction] = useState("");
    const [reviewContent, setReviewContent] = useState("");
    const [nextData, setNextData] = useState({ safeToRun: [], blocked: [], notScheduled: [] });
    const [scheduleData, setScheduleData] = useState({ batches: [], blocked: [] });

    function loadBoardData() {
      return Promise.all([
        fetch("/api/project").then(function (r) { return r.json(); }),
        fetch("/api/tasks").then(function (r) { return r.json(); }),
        fetch("/api/locks").then(function (r) { return r.json(); }),
        fetch("/api/scheduler/next").then(function (r) { return r.json(); }),
        fetch("/api/scheduler/schedule").then(function (r) { return r.json(); })
      ]).then(function (data) {
        const projectData = data[0];
        const taskData = data[1];
        const lockData = data[2];
        const nextResult = data[3];
        const scheduleResult = data[4];

        setProject(projectData);
        setTasks(Array.isArray(taskData) ? taskData : []);
        setLocks(lockData && typeof lockData === "object" ? lockData : { locks: [] });
        setNextData(nextResult && nextResult.ok ? nextResult : { safeToRun: [], blocked: [], notScheduled: [] });
        setScheduleData(scheduleResult && scheduleResult.ok ? scheduleResult : { batches: [], blocked: [] });

        if (Array.isArray(taskData) && taskData.length > 0 && !selectedTaskId) {
          setSelectedTaskId(taskData[0].id);
        }
      });
    }

    async function refreshAll() {
      await loadBoardData();
    }

    useEffect(function () {
      loadBoardData().catch(function (err) {
        setError(err && err.message ? err.message : "Failed to load board data.");
      });
    }, []);

    function runTaskAction(taskId, action, options) {
      setRunningAction(action + ":" + taskId);
      setActionMessage("Running " + action + " for " + taskId + "...");
      setError("");
      setReviewContent("");

      fetch("/api/tasks/" + encodeURIComponent(taskId) + "/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: options && options.body ? JSON.stringify(options.body) : ""
      }).then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      }).then(function (result) {
        const body = result.body || {};
        setActionMessage(body.message || (action + " finished for " + taskId + "."));
        if (action === "review" && body.recommendation) {
          setActionMessage((body.message || "Review completed.") + " Recommendation: " + body.recommendation);
        }
        return loadBoardData();
      }).catch(function (err) {
        setError(err && err.message ? err.message : ("Failed to run " + action + " for " + taskId + "."));
      }).finally(function () {
        setRunningAction("");
      });
    }

    function openReview(taskId) {
      setRunningAction("open-review:" + taskId);
      setActionMessage("Loading review for " + taskId + "...");
      setError("");
      fetch("/api/tasks/" + encodeURIComponent(taskId) + "/review")
        .then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
        .then(function (result) {
          const body = result.body || {};
          if (result.status >= 400 || !body.ok) {
            setActionMessage(body.message || "Review report not found.");
            setReviewContent("");
            return;
          }
          setReviewContent(body.content || "");
          setActionMessage("Review loaded for " + taskId + ".");
        })
        .catch(function (err) {
          setError(err && err.message ? err.message : "Failed to open review.");
        })
        .finally(function () {
          setRunningAction("");
        });
    }

    function handleDiscard(taskId) {
      const confirmed = window.confirm("Discard task " + taskId + "? This will remove its worktree/branch and archive artifacts.");
      if (!confirmed) {
        return;
      }
      runTaskAction(taskId, "discard");
    }

    function handleClose(taskId) {
      void closeTask(taskId);
    }

    function handleReopen(taskId) {
      void reopenTask(taskId);
    }

    async function closeTask(taskId) {
      const confirmed = window.confirm(
        "Close task " + taskId + "? This removes it from scheduling but does not delete artifacts."
      );
      if (!confirmed) {
        return;
      }

      setRunningAction("close:" + taskId);
      setActionMessage("Closing " + taskId + "...");
      setError("");

      try {
        const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "manual" })
        });
        const result = await response.json().catch(function () { return {}; });
        if (!response.ok || result.ok === false) {
          setActionMessage("Close failed: " + (result.message || response.statusText));
          return;
        }

        setActionMessage(result.message || ("Closed task " + taskId + "."));
        await refreshAll();
      } catch (err) {
        setActionMessage("Close failed: " + (err && err.message ? err.message : "Unknown error"));
      } finally {
        setRunningAction("");
      }
    }

    async function reopenTask(taskId) {
      const confirmed = window.confirm("Reopen task " + taskId + "?");
      if (!confirmed) {
        return;
      }

      setRunningAction("reopen:" + taskId);
      setActionMessage("Reopening " + taskId + "...");
      setError("");

      try {
        const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/reopen", {
          method: "POST"
        });
        const result = await response.json().catch(function () { return {}; });
        if (!response.ok || result.ok === false) {
          setActionMessage("Reopen failed: " + (result.message || response.statusText));
          return;
        }

        setActionMessage(result.message || ("Reopened task " + taskId + "."));
        await refreshAll();
      } catch (err) {
        setActionMessage("Reopen failed: " + (err && err.message ? err.message : "Unknown error"));
      } finally {
        setRunningAction("");
      }
    }

    function refreshSchedule() {
      setRunningAction("refresh-schedule");
      setActionMessage("Refreshing scheduling...");
      setError("");
      Promise.all([
        fetch("/api/scheduler/next").then(function (r) { return r.json(); }),
        fetch("/api/scheduler/schedule").then(function (r) { return r.json(); })
      ]).then(function (data) {
        const nextResult = data[0];
        const scheduleResult = data[1];
        setNextData(nextResult && nextResult.ok ? nextResult : { safeToRun: [], blocked: [], notScheduled: [] });
        setScheduleData(scheduleResult && scheduleResult.ok ? scheduleResult : { batches: [], blocked: [] });
        setActionMessage("Scheduling refreshed.");
      }).catch(function (err) {
        setError(err && err.message ? err.message : "Failed to refresh scheduling.");
      }).finally(function () {
        setRunningAction("");
      });
    }

    const taskByStatus = useMemo(function () {
      const bucket = {};
      for (const column of STATUS_COLUMNS) {
        bucket[column.key] = [];
      }

      for (const task of tasks) {
        if (!bucket[task.status]) {
          bucket[task.status] = [];
        }

        bucket[task.status].push(task);
      }

      return bucket;
    }, [tasks]);

    const selectedTask = useMemo(function () {
      return tasks.find(function (task) { return task.id === selectedTaskId; }) || null;
    }, [tasks, selectedTaskId]);

    return h("div", { className: "container" }, [
      h("h1", { key: "title" }, "ScopeGuard"),
      project ? h("div", { key: "project", className: "section" }, "Project: " + (project.config ? project.config.projectName : "Unknown")) : null,
      project && project.warning ? h("div", { key: "warning", className: "section meta" }, project.warning) : null,
      error ? h("div", { key: "error", className: "section" }, "Error: " + error) : null,
      actionMessage ? h("div", { key: "action", className: "section meta" }, actionMessage) : null,
      h("div", { key: "grid", className: "grid" }, [
        h("div", { key: "board" }, [
          h("h2", { key: "board-title" }, "Task Board"),
          h("div", { className: "panel section", key: "scheduling" }, [
            h("div", { key: "sched-header", className: "actions" }, [
              h("h3", { key: "sched-title" }, "Scheduling"),
              h("button", { key: "refresh-schedule", disabled: runningAction.length > 0, onClick: refreshSchedule }, "Refresh Schedule")
            ]),
            h("div", { key: "safe", className: "section" }, [
              h("strong", { key: "safe-title" }, "Safe to run now"),
              h("div", { key: "safe-body", className: "pre" }, (nextData.safeToRun || []).length === 0
                ? "None"
                : nextData.safeToRun.map(function (task) {
                    return task.id + " [" + task.agentType + "] " + task.title + "\nLocks: " + (task.lockedFiles || []).join(", ");
                  }).join("\n\n"))
            ]),
            h("div", { key: "batches", className: "section" }, [
              h("strong", { key: "batches-title" }, "Parallel batches"),
              h("div", { key: "batches-body", className: "pre" }, (scheduleData.batches || []).length === 0
                ? "None"
                : scheduleData.batches.map(function (batch, idx) {
                    const lines = ["Batch " + (idx + 1)];
                    for (const task of batch) {
                      lines.push("- " + task.id + " [" + task.agentType + "] " + task.title);
                      lines.push("  Locks: " + (task.lockedFiles || []).join(", "));
                    }
                    return lines.join("\n");
                  }).join("\n\n"))
            ]),
            h("div", { key: "blocked", className: "section" }, [
              h("strong", { key: "blocked-title" }, "Blocked"),
              h("div", { key: "blocked-body", className: "pre" }, (nextData.blocked || []).length === 0
                ? "None"
                : nextData.blocked.map(function (item) {
                    const lines = [item.id + " " + item.title];
                    for (const reason of (item.reasons || [])) {
                      lines.push("- " + reason);
                    }
                    return lines.join("\n");
                  }).join("\n\n"))
            ]),
            h("div", { key: "not-scheduled", className: "meta" }, "Not scheduled: " + ((nextData.notScheduled || []).length))
          ]),
          h("div", { key: "columns", className: "columns" }, STATUS_COLUMNS.map(function (column) {
            const cards = (taskByStatus[column.key] || []).map(function (task) {
              const verifyDisabled = runningAction.length > 0 || !VERIFY_ENABLED.has(task.status);
              const fixScopeDisabled = runningAction.length > 0 || !FIX_SCOPE_ENABLED.has(task.status);
              const reviewDisabled = runningAction.length > 0 || !REVIEW_ENABLED.has(task.status);
              const openReviewDisabled = runningAction.length > 0 || !OPEN_REVIEW_ENABLED.has(task.status);
              const discardDisabled = runningAction.length > 0 || !DISCARD_ENABLED.has(task.status);
              const closeVisible = task.status !== "closed";
              const reopenVisible = task.status === "closed";
              return h("div", {
                className: "card",
                key: task.id,
                onClick: function () { setSelectedTaskId(task.id); }
              }, [
                h("div", { key: "id" }, task.id + " · " + task.title),
                h("div", { className: "meta", key: "meta" }, [
                  h("span", { key: "status", className: "status-badge status-" + task.status }, task.status),
                  h("span", { key: "sep" }, " | " + task.agentType + " | " + task.riskLevel)
                ]),
                h("div", { className: "meta", key: "counts" }, "Allowed " + task.allowedFiles.length + " · Locked " + task.lockedFiles.length),
                h("div", { className: "actions", key: "actions", onClick: function (e) { e.stopPropagation(); } }, [
                  h("button", {
                    key: "verify",
                    disabled: verifyDisabled,
                    title: verifyDisabled ? "Verify requires an executed task with a worktree." : "",
                    onClick: function () { runTaskAction(task.id, "verify"); }
                  }, "Verify"),
                  h("button", {
                    key: "fix",
                    disabled: fixScopeDisabled,
                    title: fixScopeDisabled ? "Fix Scope is useful after verification finds out-of-scope changes." : "",
                    onClick: function () { runTaskAction(task.id, "fix-scope"); }
                  }, "Fix Scope"),
                  h("button", {
                    key: "review",
                    disabled: reviewDisabled,
                    title: reviewDisabled ? "Review is unavailable while task is running." : "",
                    onClick: function () { runTaskAction(task.id, "review"); }
                  }, "Review"),
                  h("button", {
                    key: "open-review",
                    disabled: openReviewDisabled,
                    onClick: function () { openReview(task.id); }
                  }, "Open Review"),
                  h("button", {
                    key: "discard",
                    disabled: discardDisabled,
                    title: discardDisabled ? "Approved or merged tasks cannot be discarded." : "",
                    onClick: function () { handleDiscard(task.id); }
                  }, "Discard"),
                  closeVisible ? h("button", {
                    key: "close",
                    disabled: runningAction.length > 0,
                    onClick: function () { handleClose(task.id); }
                  }, "Close") : null,
                  reopenVisible ? h("button", {
                    key: "reopen",
                    disabled: runningAction.length > 0,
                    onClick: function () { handleReopen(task.id); }
                  }, "Reopen") : null
                ])
              ]);
            });

            return h("div", { className: "column", key: column.key }, [
              h("div", { className: "column-title", key: "label" }, column.label)
            ].concat(cards));
          }))
        ]),
        h("div", { key: "side" }, [
          h("div", { className: "panel section", key: "details" }, [
            h("h3", { key: "details-title" }, "Task Details"),
            selectedTask ? h("div", { key: "details-body" }, [
              section("Description", selectedTask.description || ""),
              section("Allowed Files", JSON.stringify(selectedTask.allowedFiles, null, 2)),
              section("Locked Files", JSON.stringify(selectedTask.lockedFiles, null, 2)),
              section("Forbidden Files", JSON.stringify(selectedTask.forbiddenFiles, null, 2)),
              section("Dependencies", JSON.stringify(selectedTask.dependencies, null, 2)),
              section("Acceptance Criteria", JSON.stringify(selectedTask.acceptanceCriteria, null, 2)),
              section("Commands", JSON.stringify(selectedTask.commands, null, 2)),
              section("Branch", String(selectedTask.branchName)),
              section("Worktree Path", String(selectedTask.worktreePath)),
              section("Diff Path", String(selectedTask.diffPath)),
              section("Test Log Path", String(selectedTask.testLogPath)),
              section("Result Summary", String(selectedTask.resultSummary))
            ]) : h("div", { key: "empty", className: "meta" }, "Select a task to view details.")
          ]),
          h("div", { className: "panel", key: "locks" }, [
            h("h3", { key: "locks-title" }, "Active Locks"),
            h("div", { className: "pre", key: "locks-body" }, JSON.stringify((locks.locks || []).filter(function (lock) {
              return lock.status === "active";
            }), null, 2))
          ]),
          h("div", { className: "panel", key: "review-content" }, [
            h("h3", { key: "review-title" }, "Review Content"),
            h("div", { className: "pre", key: "review-body" }, reviewContent || "Open Review to view review.md content.")
          ])
        ])
      ])
    ]);
  }

  function section(title, value) {
    return React.createElement("div", { className: "section", key: title }, [
      React.createElement("strong", { key: "k" }, title),
      React.createElement("div", { className: "pre", key: "v" }, value)
    ]);
  }

  ReactDOM.createRoot(document.getElementById("app")).render(h(App));
})();

