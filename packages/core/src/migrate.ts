import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export type MigrationOptions = {
  dryRun?: boolean;
  force?: boolean;
  move?: boolean;
};

export type MigrationMode = "copy" | "move-with-backup";
export type MigrationStatus = "dry_run" | "migrated" | "noop" | "error";

export type MigrationResult = {
  ok: boolean;
  status: MigrationStatus;
  sourceDirName: ".agentboard";
  targetDirName: ".scopeguard";
  mode?: MigrationMode;
  backupDirName?: string;
  overwroteTarget?: boolean;
  actions: string[];
  message: string;
};

export function migrateDataDir(gitRoot: string, options: MigrationOptions = {}): MigrationResult {
  const sourceDirName = ".agentboard" as const;
  const targetDirName = ".scopeguard" as const;
  const sourceDir = join(gitRoot, sourceDirName);
  const targetDir = join(gitRoot, targetDirName);

  const sourceExists = existsSync(sourceDir);
  const targetExists = existsSync(targetDir);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const move = Boolean(options.move);

  if (!sourceExists) {
    if (targetExists) {
      return {
        ok: true,
        status: "noop",
        sourceDirName,
        targetDirName,
        actions: [],
        message: "ScopeGuard data directory already exists: .scopeguard\nNo migration needed.",
      };
    }

    return {
      ok: false,
      status: "error",
      sourceDirName,
      targetDirName,
      actions: [],
      message: "No legacy .agentboard directory found.\nRun: scopeguard init",
    };
  }

  if (targetExists && !force) {
    return {
      ok: false,
      status: "error",
      sourceDirName,
      targetDirName,
      actions: [],
      message: "Target .scopeguard already exists.\nUse --force to overwrite, or remove it manually.",
    };
  }

  const actions: string[] = [];
  if (targetExists && force) {
    actions.push("Overwrite existing .scopeguard because --force was provided.");
  }
  actions.push("Copy .agentboard to .scopeguard");
  if (move) {
    actions.push("Rename .agentboard to .agentboard.backup-YYYYMMDD-HHmmss");
  } else {
    actions.push("Keep .agentboard for compatibility");
  }

  if (dryRun) {
    return {
      ok: true,
      status: "dry_run",
      sourceDirName,
      targetDirName,
      mode: move ? "move-with-backup" : "copy",
      actions,
      message: "ScopeGuard migration dry run",
    };
  }

  let backupDirName: string | undefined;

  if (targetExists && force) {
    // Safety boundary: this command only ever removes the Git-root .scopeguard path.
    rmSync(targetDir, { recursive: true, force: true });
  }

  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  if (!existsSync(targetDir)) {
    return {
      ok: false,
      status: "error",
      sourceDirName,
      targetDirName,
      actions,
      message: "Migration failed: target .scopeguard was not created.",
    };
  }

  if (move) {
    backupDirName = generateUniqueBackupDirName(gitRoot);
    renameSync(sourceDir, join(gitRoot, backupDirName));
  }

  return {
    ok: true,
    status: "migrated",
    sourceDirName,
    targetDirName,
    mode: move ? "move-with-backup" : "copy",
    backupDirName,
    overwroteTarget: targetExists && force,
    actions,
    message: "Migrated ScopeGuard data directory.",
  };
}

export function formatMigrationResult(result: MigrationResult): string {
  if (result.status === "error" || result.status === "noop") {
    return result.message;
  }

  if (result.status === "dry_run") {
    const lines: string[] = [];
    lines.push("ScopeGuard migration dry run");
    lines.push("");
    lines.push("Source:");
    lines.push(result.sourceDirName);
    lines.push("");
    lines.push("Target:");
    lines.push(result.targetDirName);
    lines.push("");
    lines.push("Actions:");
    for (const action of result.actions) {
      lines.push(`- ${action}`);
    }
    lines.push("");
    lines.push("No files were changed.");
    return lines.join("\n");
  }

  const lines: string[] = [];
  if (result.overwroteTarget) {
    lines.push("Overwriting existing .scopeguard because --force was provided.");
    lines.push("");
  }
  lines.push("Migrated ScopeGuard data directory.");
  lines.push("");
  lines.push("Source:");
  lines.push(result.sourceDirName);
  lines.push("");
  lines.push("Target:");
  lines.push(result.targetDirName);
  lines.push("");
  lines.push("Mode:");
  lines.push(result.mode ?? "copy");
  if (result.backupDirName) {
    lines.push("");
    lines.push("Backup:");
    lines.push(result.backupDirName);
  }
  lines.push("");
  lines.push("Next:");
  lines.push("scopeguard doctor");
  return lines.join("\n");
}

function generateUniqueBackupDirName(gitRoot: string): string {
  const base = `.agentboard.backup-${formatTimestamp(new Date())}`;
  let candidate = base;
  let index = 1;

  while (existsSync(join(gitRoot, candidate))) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

function formatTimestamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}
