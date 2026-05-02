import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { closeTask, dataPath, discardTask, fixScopeTask, generateReviewReport, getReviewReportContent, reopenTask, verifyTask } from "@scopeguard/core";
import { getNextTasks, getSchedule } from "@scopeguard/core";

type TaskRecord = {
  id: string;
  title: string;
  status: string;
  agentType: string;
  riskLevel: string;
  description: string;
  allowedFiles: string[];
  commands: string[];
  branchName: string | null;
  worktreePath: string | null;
};

type Column = {
  label: string;
  statuses: string[];
};

type ViewMode = "board" | "details" | "review" | "discard_confirm" | "close_confirm" | "next" | "schedule";

const COLUMNS: Column[] = [
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Ready", statuses: ["ready", "blocked"] },
  { label: "Running", statuses: ["in_progress"] },
  { label: "Review", statuses: ["needs_review"] },
  { label: "Failed", statuses: ["test_failed", "conflict"] },
  { label: "Approved", statuses: ["approved"] },
  { label: "Merged", statuses: ["merged"] },
  { label: "Closed", statuses: ["closed"] },
];

export function runTuiBoard(gitRoot: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("TUI requires an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  let tasks = loadTasks(gitRoot);
  let selectedIndex = tasks.length > 0 ? 0 : -1;
  let mode: ViewMode = "board";
  let lastMessage = "";
  let reviewText = "";
  let nextData = getNextTasks(gitRoot);
  let scheduleData = getSchedule(gitRoot);
  let closed = false;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  hideCursor();
  render();

  const onKeypress = (_str: string, key: readline.Key): void => {
    if (closed) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      close();
      return;
    }

    if (key.name === "q") {
      close();
      return;
    }

    if (mode === "discard_confirm") {
      if (key.name === "escape" || key.name === "n") {
        mode = "board";
        lastMessage = "Discard canceled.";
        render();
        return;
      }
      if (key.name === "y") {
        const task = getSelectedTask(tasks, selectedIndex);
        if (!task) {
          lastMessage = "No task selected.";
          mode = "board";
          render();
          return;
        }
        const allowed = new Set(["ready", "blocked", "in_progress", "needs_review", "test_failed", "conflict"]);
        if (!allowed.has(task.status)) {
          lastMessage = `Task ${task.id} cannot be discarded in status ${task.status}.`;
          mode = "board";
          render();
          return;
        }
        lastMessage = `Running discard for ${task.id}...`;
        render();
        const result = discardTask(gitRoot, task.id, { toStatus: "ready" });
        tasks = loadTasks(gitRoot);
        nextData = getNextTasks(gitRoot);
        scheduleData = getSchedule(gitRoot);
        selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
        lastMessage = result.message;
        mode = "board";
        render();
        return;
      }
      return;
    }

    if (mode === "close_confirm") {
      if (key.name === "escape" || key.name === "n") {
        mode = "board";
        lastMessage = "Close canceled.";
        render();
        return;
      }
      if (key.name === "y") {
        const task = getSelectedTask(tasks, selectedIndex);
        if (!task) {
          lastMessage = "No task selected.";
          mode = "board";
          render();
          return;
        }
        lastMessage = `Running close for ${task.id}...`;
        render();
        const result = closeTask(gitRoot, task.id, "manual");
        tasks = loadTasks(gitRoot);
        nextData = getNextTasks(gitRoot);
        scheduleData = getSchedule(gitRoot);
        selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
        if (result.ok) {
          lastMessage = result.warning ? `${result.message} ${result.warning}` : result.message;
        } else {
          lastMessage = result.message;
        }
        mode = "board";
        render();
      }
      return;
    }

    if (mode === "review") {
      if (key.name === "escape" || key.name === "b") {
        mode = "board";
        render();
      }
      return;
    }

    if (mode === "next" || mode === "schedule") {
      if (key.name === "escape" || key.name === "b") {
        mode = "board";
        render();
        return;
      }
      if (key.name === "r") {
        nextData = getNextTasks(gitRoot);
        scheduleData = getSchedule(gitRoot);
        lastMessage = "Scheduler refreshed.";
        render();
      }
      return;
    }

    if (mode === "details") {
      if (key.name === "escape" || key.name === "b") {
        mode = "board";
        render();
      }
      return;
    }

    if (key.name === "r") {
      tasks = loadTasks(gitRoot);
      nextData = getNextTasks(gitRoot);
      scheduleData = getSchedule(gitRoot);
      selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
      lastMessage = `Refreshed ${tasks.length} task(s).`;
      render();
      return;
    }

    if (key.name === "down") {
      if (tasks.length > 0) {
        selectedIndex = Math.min(selectedIndex + 1, tasks.length - 1);
        render();
      }
      return;
    }

    if (key.name === "up") {
      if (tasks.length > 0) {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        render();
      }
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      if (tasks.length > 0 && selectedIndex >= 0) {
        mode = "details";
        render();
      }
      return;
    }

    if (key.name === "v") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      lastMessage = `Running verify for ${task.id}...`;
      render();
      const result = verifyTask(gitRoot, task.id);
      tasks = loadTasks(gitRoot);
      nextData = getNextTasks(gitRoot);
      scheduleData = getSchedule(gitRoot);
      selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
      lastMessage = result.message;
      render();
      return;
    }

    if (key.name === "f") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      lastMessage = `Running fix-scope for ${task.id}...`;
      render();
      const result = fixScopeTask(gitRoot, task.id);
      tasks = loadTasks(gitRoot);
      nextData = getNextTasks(gitRoot);
      scheduleData = getSchedule(gitRoot);
      selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
      lastMessage = result.message;
      render();
      return;
    }

    if (key.name === "p") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      lastMessage = `Running review for ${task.id}...`;
      render();
      const result = generateReviewReport(gitRoot, task.id);
      tasks = loadTasks(gitRoot);
      nextData = getNextTasks(gitRoot);
      scheduleData = getSchedule(gitRoot);
      selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
      if (result.ok) {
        lastMessage = `${result.message} Recommendation: ${result.recommendation}`;
      } else {
        lastMessage = result.message;
      }
      render();
      return;
    }

    if (key.name === "o") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      const result = getReviewReportContent(gitRoot, task.id);
      if (!result.ok) {
        lastMessage = "Review report not found. Press p to generate it.";
        render();
        return;
      }
      reviewText = result.content;
      mode = "review";
      lastMessage = `Opened review for ${task.id}.`;
      render();
      return;
    }

    if (key.name === "d") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      const allowed = new Set(["ready", "blocked", "in_progress", "needs_review", "test_failed", "conflict"]);
      if (!allowed.has(task.status)) {
        lastMessage = `Task ${task.id} cannot be discarded in status ${task.status}.`;
        render();
        return;
      }
      mode = "discard_confirm";
      render();
      return;
    }

    if (key.name === "c") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      if (task.status === "merged") {
        lastMessage = `Task ${task.id} is merged and cannot be closed.`;
        render();
        return;
      }
      if (task.status === "closed") {
        lastMessage = `Task ${task.id} is already closed.`;
        render();
        return;
      }
      mode = "close_confirm";
      render();
      return;
    }

    if (key.name === "u") {
      const task = getSelectedTask(tasks, selectedIndex);
      if (!task) {
        lastMessage = "No task selected.";
        render();
        return;
      }
      if (task.status !== "closed") {
        lastMessage = `Task ${task.id} is not closed.`;
        render();
        return;
      }
      lastMessage = `Running reopen for ${task.id}...`;
      render();
      const result = reopenTask(gitRoot, task.id);
      tasks = loadTasks(gitRoot);
      nextData = getNextTasks(gitRoot);
      scheduleData = getSchedule(gitRoot);
      selectedIndex = normalizeSelectionIndex(selectedIndex, tasks.length);
      lastMessage = result.message;
      render();
      return;
    }

    if (key.name === "n") {
      mode = "next";
      render();
      return;
    }

    if (key.name === "s") {
      mode = "schedule";
      render();
    }
  };

  process.stdin.on("keypress", onKeypress);

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    process.stdin.off("keypress", onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    showCursor();
    clearScreen();
  }

  function render(): void {
    clearScreen();
    const selectedTask = getSelectedTask(tasks, selectedIndex);
    if (mode === "discard_confirm") {
      renderDiscardConfirm(selectedTask, lastMessage);
      return;
    }
    if (mode === "close_confirm") {
      renderCloseConfirm(selectedTask, lastMessage);
      return;
    }
    if (mode === "review") {
      renderReview(selectedTask, reviewText, lastMessage);
      return;
    }
    if (mode === "next") {
      renderNextView(nextData, lastMessage);
      return;
    }
    if (mode === "schedule") {
      renderScheduleView(scheduleData, lastMessage);
      return;
    }
    if (mode === "details") {
      renderDetails(selectedTask, lastMessage);
      return;
    }
    renderBoard(tasks, selectedIndex, lastMessage);
  }
}

function renderBoard(tasks: TaskRecord[], selectedIndex: number, lastMessage: string): void {
  const width = Math.max(100, process.stdout.columns || 120);
  const divider = "-".repeat(Math.min(width, 140));
  const labelWidth = 13;
  const colPadding = " ";

  process.stdout.write("ScopeGuard TUI\n\n");
  process.stdout.write(COLUMNS.map((col) => padRight(col.label, labelWidth)).join(colPadding));
  process.stdout.write("\n");
  process.stdout.write(`${divider}\n`);

  const idsByColumn = COLUMNS.map((col) =>
    tasks.filter((task) => col.statuses.includes(task.status)).map((task) => task.id),
  );
  const maxRows = Math.max(1, ...idsByColumn.map((rows) => rows.length));
  for (let row = 0; row < maxRows; row += 1) {
    const line = idsByColumn
      .map((rows) => {
        const value = rows[row] ?? "";
        return padRight(value, labelWidth);
      })
      .join(colPadding);
    process.stdout.write(`${line}\n`);
  }

  process.stdout.write("\n");
  process.stdout.write("Task List\n");
  process.stdout.write(`${divider}\n`);
  if (tasks.length === 0) {
    process.stdout.write("(no tasks found)\n");
  } else {
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      const marker = i === selectedIndex ? ">" : " ";
      process.stdout.write(`${marker} ${task.id} ${task.title} [${task.status.toUpperCase()}]\n`);
    }
  }

  process.stdout.write("\n");
  process.stdout.write("Controls:\n");
  process.stdout.write("up/down select task  Enter details  v verify  f fix-scope  p review  o open-review  d discard  c close  u reopen  n next  s schedule  r refresh  q quit\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function renderDetails(task: TaskRecord | null, lastMessage: string): void {
  process.stdout.write("ScopeGuard TUI - Task Details\n\n");
  if (!task) {
    process.stdout.write("No task selected.\n\n");
  } else {
    process.stdout.write(`Task: ${task.id}\n`);
    process.stdout.write(`Title: ${task.title}\n`);
    process.stdout.write(`Status: ${task.status}\n`);
    process.stdout.write(`Agent: ${task.agentType}\n`);
    process.stdout.write(`Risk: ${task.riskLevel}\n`);
    process.stdout.write("Allowed files:\n");
    if (task.allowedFiles.length === 0) {
      process.stdout.write("- (none)\n");
    } else {
      for (const item of task.allowedFiles) {
        process.stdout.write(`- ${item}\n`);
      }
    }
    process.stdout.write("Commands:\n");
    if (task.commands.length === 0) {
      process.stdout.write("- (none)\n");
    } else {
      for (const cmd of task.commands) {
        process.stdout.write(`- ${cmd}\n`);
      }
    }
    process.stdout.write(`Branch: ${task.branchName ?? ""}\n`);
    process.stdout.write(`Worktree: ${task.worktreePath ?? ""}\n`);
    process.stdout.write("Description:\n");
    process.stdout.write(`${task.description || "(empty)"}\n`);
    process.stdout.write("\n");
  }

  process.stdout.write("Controls: b back   Esc back   q quit\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function renderReview(task: TaskRecord | null, reviewText: string, lastMessage: string): void {
  const taskId = task?.id ?? "unknown";
  process.stdout.write(`Review Report: ${taskId}\n\n`);
  process.stdout.write(`${reviewText}\n`);
  process.stdout.write("\nControls:\n");
  process.stdout.write("b / Esc back   q quit\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function renderNextView(
  nextData: {
    safeToRun: Array<{ id: string; title: string; agentType: string; lockedFiles: string[] }>;
    blocked: Array<{ id: string; title: string; reasons: string[] }>;
    notScheduled: Array<{ id: string; title: string; status: string }>;
  },
  lastMessage: string,
): void {
  process.stdout.write("Next Tasks\n\n");
  process.stdout.write("Safe to run now:\n");
  if (!nextData.safeToRun || nextData.safeToRun.length === 0) {
    process.stdout.write("- none\n");
  } else {
    for (const task of nextData.safeToRun) {
      process.stdout.write(`- ${task.id} [${task.agentType}] ${task.title}\n`);
      process.stdout.write(`  Locks: ${(task.lockedFiles || []).join(", ")}\n`);
    }
  }
  process.stdout.write("\nBlocked:\n");
  if (!nextData.blocked || nextData.blocked.length === 0) {
    process.stdout.write("- none\n");
  } else {
    for (const item of nextData.blocked) {
      process.stdout.write(`- ${item.id} ${item.title}\n`);
      for (const reason of item.reasons || []) {
        process.stdout.write(`  - ${reason}\n`);
      }
    }
  }
  process.stdout.write("\nNot scheduled:\n");
  if (!nextData.notScheduled || nextData.notScheduled.length === 0) {
    process.stdout.write("- none\n");
  } else {
    for (const item of nextData.notScheduled) {
      process.stdout.write(`- ${item.id} status: ${item.status}\n`);
    }
  }
  process.stdout.write("\nControls:\n");
  process.stdout.write("b / Esc back   r refresh   q quit\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function renderScheduleView(
  scheduleData: {
    batches: Array<Array<{ id: string; title: string; agentType: string; lockedFiles: string[] }>>;
    blocked: Array<{ id: string; title: string; reasons: string[] }>;
  },
  lastMessage: string,
): void {
  process.stdout.write("Schedule\n\n");
  if (!scheduleData.batches || scheduleData.batches.length === 0) {
    process.stdout.write("No runnable batches.\n");
  } else {
    for (let i = 0; i < scheduleData.batches.length; i += 1) {
      const batch = scheduleData.batches[i] || [];
      process.stdout.write(`Batch ${i + 1}:\n`);
      for (const task of batch) {
        process.stdout.write(`- ${task.id} [${task.agentType}] ${task.title}\n`);
        process.stdout.write(`  Locks: ${(task.lockedFiles || []).join(", ")}\n`);
      }
      process.stdout.write("\n");
    }
  }
  process.stdout.write("Blocked:\n");
  if (!scheduleData.blocked || scheduleData.blocked.length === 0) {
    process.stdout.write("- none\n");
  } else {
    for (const item of scheduleData.blocked) {
      process.stdout.write(`- ${item.id} ${item.title}\n`);
      for (const reason of item.reasons || []) {
        process.stdout.write(`  - ${reason}\n`);
      }
    }
  }
  process.stdout.write("\nControls:\n");
  process.stdout.write("b / Esc back   r refresh   q quit\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function renderDiscardConfirm(task: TaskRecord | null, lastMessage: string): void {
  if (!task) {
    process.stdout.write("No task selected.\n\n");
    process.stdout.write("Press n or Esc to go back.\n");
    return;
  }
  process.stdout.write(`Discard task ${task.id}?\n`);
  process.stdout.write("This will remove its worktree/branch and archive artifacts.\n\n");
  process.stdout.write("Press y to confirm, n to cancel.\n");
  process.stdout.write("Esc also cancels.\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function renderCloseConfirm(task: TaskRecord | null, lastMessage: string): void {
  if (!task) {
    process.stdout.write("No task selected.\n\n");
    process.stdout.write("Press n or Esc to go back.\n");
    return;
  }
  process.stdout.write(`Close task ${task.id}?\n`);
  process.stdout.write("This removes it from scheduling but does not delete artifacts.\n\n");
  process.stdout.write("Press y to confirm, n to cancel.\n");
  process.stdout.write("Esc also cancels.\n");
  if (lastMessage.length > 0) {
    process.stdout.write(`\nLast: ${lastMessage}\n`);
  }
}

function loadTasks(gitRoot: string): TaskRecord[] {
  const tasksRoot = dataPath(gitRoot, "tasks");
  if (!existsSync(tasksRoot)) {
    return [];
  }

  const rows: TaskRecord[] = [];
  const entries = readdirSync(tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const taskPath = join(tasksRoot, entry.name, "task.json");
    if (!existsSync(taskPath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(taskPath, "utf-8")) as TaskRecord;
      rows.push(parsed);
    } catch {
      continue;
    }
  }

  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function getSelectedTask(tasks: TaskRecord[], selectedIndex: number): TaskRecord | null {
  if (selectedIndex < 0 || selectedIndex >= tasks.length) {
    return null;
  }
  return tasks[selectedIndex] ?? null;
}

function normalizeSelectionIndex(currentIndex: number, size: number): number {
  if (size <= 0) {
    return -1;
  }
  if (currentIndex < 0) {
    return 0;
  }
  if (currentIndex >= size) {
    return size - 1;
  }
  return currentIndex;
}

function clearScreen(): void {
  process.stdout.write("\x1Bc");
}

function hideCursor(): void {
  process.stdout.write("\x1B[?25l");
}

function showCursor(): void {
  process.stdout.write("\x1B[?25h");
}

function padRight(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return `${value}${" ".repeat(width - value.length)}`;
}
