/**
 * Rewind Extension - Git-based file restoration for pi branching
 *
 * Creates worktree snapshots at the start of each agent loop (when user sends a message)
 * so /fork and /tree navigation can restore code state.
 * Supports: restore files + conversation, files only, conversation only, undo last restore.
 *
 * Updated for pi-coding-agent v0.35.0+ (unified extensions system)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec as execCb } from "child_process";
import { readFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(execCb);

const REF_PREFIX = "refs/pi-checkpoints/";
const BEFORE_RESTORE_PREFIX = "before-restore-";
const MAX_CHECKPOINTS = 100;
const STATUS_KEY = "rewind";
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

let cachedSilentCheckpoints: boolean | null = null;

function getSilentCheckpointsSetting(): boolean {
  if (cachedSilentCheckpoints !== null) {
    return cachedSilentCheckpoints;
  }
  try {
    const settingsContent = readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(settingsContent);
    cachedSilentCheckpoints = settings.rewind?.silentCheckpoints === true;
    return cachedSilentCheckpoints;
  } catch {
    cachedSilentCheckpoints = false;
    return false;
  }
}

/**
 * Sanitize entry ID for use in git ref names.
 * Git refs can't contain: space, ~, ^, :, ?, *, [, \, or control chars.
 * Entry IDs are typically alphanumeric but we sanitize just in case.
 */
function sanitizeForRef(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, "_");
}

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, string>();
  let resumeCheckpoint: string | null = null;
  let repoRoot: string | null = null;
  let isGitRepo = false;
  let sessionId: string | null = null;
  
  // Pending checkpoint: worktree state captured at turn_start, waiting for turn_end
  // to associate with the correct user message entry ID
  let pendingCheckpoint: { commitSha: string; timestamp: number } | null = null;
  
  /**
   * Update the footer status with checkpoint count
   */
  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (getSilentCheckpointsSetting()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const count = checkpoints.size;
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "◆ ") + theme.fg("muted", `${count} checkpoint${count === 1 ? "" : "s"}`));
  }
  
  /**
   * Reset all state for a fresh session
   */
  function resetState() {
    checkpoints.clear();
    resumeCheckpoint = null;
    repoRoot = null;
    isGitRepo = false;
    sessionId = null;
    pendingCheckpoint = null;
    cachedSilentCheckpoints = null;
  }

  /**
   * Rebuild the checkpoints map from existing git refs.
   * Supports two formats for backward compatibility:
   * - New format: `checkpoint-{sessionId}-{timestamp}-{entryId}` (session-scoped)
   * - Old format: `checkpoint-{timestamp}-{entryId}` (pre-v1.7.0, loaded for current session)
   * This allows checkpoint restoration to work across session resumes.
   */
  async function rebuildCheckpointsMap(exec: ExecFn, currentSessionId: string): Promise<void> {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=-creatordate",  // Newest first - we keep first match per entry
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);

      for (const ref of refs) {
        // Get checkpoint ID by removing prefix
        const checkpointId = ref.replace(REF_PREFIX, "");

        // Skip non-checkpoint refs (before-restore, resume)
        if (!checkpointId.startsWith("checkpoint-")) continue;
        if (checkpointId.startsWith("checkpoint-resume-")) continue;

        // Try new format first: checkpoint-{sessionId}-{timestamp}-{entryId}
        // Session ID is a UUID (36 chars with hyphens)
        // Timestamp is always numeric (13 digits for ms since epoch)
        // Entry ID comes after the timestamp, may contain hyphens
        const newFormatMatch = checkpointId.match(/^checkpoint-([a-f0-9-]{36})-(\d+)-(.+)$/);
        if (newFormatMatch) {
          const refSessionId = newFormatMatch[1];
          const entryId = newFormatMatch[3];
          // Only load checkpoints from the current session, keep newest (first seen)
          if (refSessionId === currentSessionId && !checkpoints.has(entryId)) {
            checkpoints.set(entryId, checkpointId);
          }
          continue;
        }

        // Try old format: checkpoint-{timestamp}-{entryId} (pre-v1.7.0)
        // Load these for backward compatibility - they belong to whoever resumes the session
        const oldFormatMatch = checkpointId.match(/^checkpoint-(\d+)-(.+)$/);
        if (oldFormatMatch) {
          const entryId = oldFormatMatch[2];
          // Keep newest (first seen), prefer new-format if exists
          if (!checkpoints.has(entryId)) {
            checkpoints.set(entryId, checkpointId);
          }
        }
      }

    } catch {
      // Silent failure - checkpoints will be recreated as needed
    }
  }

  async function findBeforeRestoreRef(exec: ExecFn, currentSessionId: string): Promise<{ refName: string; commitSha: string } | null> {
    try {
      // Look for before-restore refs scoped to this session
      const result = await exec("git", [
        "for-each-ref",
        "--sort=-creatordate",
        "--count=1",
        "--format=%(refname) %(objectname)",
        `${REF_PREFIX}${BEFORE_RESTORE_PREFIX}${currentSessionId}-*`,
      ]);

      const line = result.stdout.trim();
      if (!line) return null;

      const parts = line.split(" ");
      if (parts.length < 2 || !parts[0] || !parts[1]) return null;
      return { refName: parts[0], commitSha: parts[1] };
    } catch {
      return null;
    }
  }

  async function getRepoRoot(exec: ExecFn): Promise<string> {
    if (repoRoot) return repoRoot;
    const result = await exec("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = result.stdout.trim();
    return repoRoot;
  }

  /**
   * Capture current worktree state as a git commit (without affecting HEAD).
   * Uses execAsync directly (instead of pi.exec) because we need to set
   * GIT_INDEX_FILE environment variable for an isolated index.
   */
  async function captureWorktree(): Promise<string> {
    const root = await getRepoRoot(pi.exec);
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-"));
    const tmpIndex = join(tmpDir, "index");

    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      await execAsync("git add -A", { cwd: root, env });
      const { stdout: treeSha } = await execAsync("git write-tree", { cwd: root, env });

      const result = await pi.exec("git", ["commit-tree", treeSha.trim(), "-m", "rewind backup"]);
      return result.stdout.trim();
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function restoreWithBackup(
    exec: ExecFn,
    targetRef: string,
    currentSessionId: string,
    notify: (msg: string, level: "info" | "warning" | "error") => void
  ): Promise<boolean> {
    try {
      const existingBackup = await findBeforeRestoreRef(exec, currentSessionId);

      const backupCommit = await captureWorktree();
      // Include session ID in before-restore ref to scope it per-session
      const newBackupId = `${BEFORE_RESTORE_PREFIX}${currentSessionId}-${Date.now()}`;
      await exec("git", [
        "update-ref",
        `${REF_PREFIX}${newBackupId}`,
        backupCommit,
      ]);

      if (existingBackup) {
        await exec("git", ["update-ref", "-d", existingBackup.refName]);
      }

      await exec("git", ["checkout", targetRef, "--", "."]);
      return true;
    } catch (err) {
      notify(`Failed to restore: ${err}`, "error");
      return false;
    }
  }

  async function createCheckpointFromWorktree(exec: ExecFn, checkpointId: string): Promise<boolean> {
    try {
      const commitSha = await captureWorktree();
      await exec("git", [
        "update-ref",
        `${REF_PREFIX}${checkpointId}`,
        commitSha,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find the most recent user message in the current branch.
   * Used at turn_end to find the user message that triggered the agent loop.
   */
  function findUserMessageEntry(sessionManager: { getLeafId(): string | null; getBranch(id?: string): any[] }): { id: string } | null {
    const leafId = sessionManager.getLeafId();
    if (!leafId) return null;
    
    const branch = sessionManager.getBranch(leafId);
    // Walk backwards to find the most recent user message
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "user") {
        return entry;
      }
    }
    return null;
  }

  async function pruneCheckpoints(exec: ExecFn, currentSessionId: string) {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);
      // Filter to only regular checkpoints from THIS session (not backups, resume, or other sessions)
      const checkpointRefs = refs.filter(r => {
        if (r.includes(BEFORE_RESTORE_PREFIX)) return false;
        if (r.includes("checkpoint-resume-")) return false;
        // Only include refs from current session
        const checkpointId = r.replace(REF_PREFIX, "");
        return checkpointId.startsWith(`checkpoint-${currentSessionId}-`);
      });

      if (checkpointRefs.length > MAX_CHECKPOINTS) {
        const toDelete = checkpointRefs.slice(0, checkpointRefs.length - MAX_CHECKPOINTS);
        for (const ref of toDelete) {
          await exec("git", ["update-ref", "-d", ref]);

          // Remove from in-memory map ONLY if this is the currently mapped checkpoint.
          // There might be a newer checkpoint for the same entry that we're keeping.
          const checkpointId = ref.replace(REF_PREFIX, "");
          const match = checkpointId.match(/^checkpoint-([a-f0-9-]{36})-(\d+)-(.+)$/);
          if (match) {
            const entryId = match[3];
            if (checkpoints.get(entryId) === checkpointId) {
              checkpoints.delete(entryId);
            }
          }
        }
      }
    } catch {
      // Silent failure - pruning is not critical
    }
  }

  /**
   * Initialize the extension for the current session/repo
   */
  async function initializeForSession(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    // Reset all state for fresh initialization
    resetState();

    // Capture session ID for scoping checkpoints
    sessionId = ctx.sessionManager.getSessionId();

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      isGitRepo = result.stdout.trim() === "true";
    } catch {
      isGitRepo = false;
    }

    if (!isGitRepo) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    // Rebuild checkpoints map from existing git refs (for resumed sessions)
    // Only loads checkpoints belonging to this session
    await rebuildCheckpointsMap(pi.exec, sessionId);

    // Create a resume checkpoint for the current state
    const checkpointId = `checkpoint-resume-${Date.now()}`;

    try {
      const success = await createCheckpointFromWorktree(pi.exec, checkpointId);
      if (success) {
        resumeCheckpoint = checkpointId;
      }
    } catch {
      // Silent failure - resume checkpoint is optional
    }
    
    updateStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await initializeForSession(ctx);
  });
  
  pi.on("session_switch", async (_event, ctx) => {
    await initializeForSession(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isGitRepo) return;
    
    // Only capture at the start of a new agent loop (first turn).
    // This is when a user message triggers the agent - we want to snapshot
    // the file state BEFORE any tools execute.
    if (event.turnIndex !== 0) return;

    try {
      // Capture worktree state now, but don't create the ref yet.
      // At this point, the user message hasn't been appended to the session,
      // so we don't know its entry ID. We'll create the ref at turn_end.
      const commitSha = await captureWorktree();
      pendingCheckpoint = { commitSha, timestamp: event.timestamp };
    } catch {
      pendingCheckpoint = null;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isGitRepo) return;
    if (!pendingCheckpoint) return;
    if (!sessionId) return;
    
    // Only process at end of first turn - by now the user message has been
    // appended to the session and we can find its entry ID.
    if (event.turnIndex !== 0) return;

    try {
      const userEntry = findUserMessageEntry(ctx.sessionManager);
      if (!userEntry) return;

      const entryId = userEntry.id;
      const sanitizedEntryId = sanitizeForRef(entryId);
      // Include session ID in checkpoint name to scope it per-session
      const checkpointId = `checkpoint-${sessionId}-${pendingCheckpoint.timestamp}-${sanitizedEntryId}`;

      // Create the git ref for this checkpoint
      await pi.exec("git", [
        "update-ref",
        `${REF_PREFIX}${checkpointId}`,
        pendingCheckpoint.commitSha,
      ]);

      checkpoints.set(sanitizedEntryId, checkpointId);
      await pruneCheckpoints(pi.exec, sessionId);
      updateStatus(ctx);
      if (!getSilentCheckpointsSetting()) {
        ctx.ui.notify(`Checkpoint ${checkpoints.size} saved`, "info");
      }
    } catch {
      // Silent failure - checkpoint creation is not critical
    } finally {
      pendingCheckpoint = null;
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!sessionId) return;

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      if (result.stdout.trim() !== "true") return;
    } catch {
      return;
    }

    const sanitizedEntryId = sanitizeForRef(event.entryId);
    let checkpointId = checkpoints.get(sanitizedEntryId);
    let usingResumeCheckpoint = false;

    if (!checkpointId && resumeCheckpoint) {
      checkpointId = resumeCheckpoint;
      usingResumeCheckpoint = true;
    }

    const beforeRestoreRef = await findBeforeRestoreRef(pi.exec, sessionId);
    const hasUndo = !!beforeRestoreRef;

    const options: string[] = [];

    if (checkpointId) {
      if (usingResumeCheckpoint) {
        options.push("Restore to session start (files + conversation)");
        options.push("Conversation only (keep current files)");
        options.push("Restore to session start (files only, keep conversation)");
      } else {
        options.push("Restore all (files + conversation)");
        options.push("Conversation only (keep current files)");
        options.push("Code only (restore files, keep conversation)");
      }
    } else {
      // No checkpoint available - still allow conversation-only branch
      options.push("Conversation only (keep current files)");
    }

    if (hasUndo) {
      options.push("Undo last file rewind");
    }

    const choice = await ctx.ui.select("Restore Options", options);

    if (!choice) {
      ctx.ui.notify("Rewind cancelled", "info");
      return { cancel: true };
    }

    if (choice.startsWith("Conversation only")) {
      return;
    }

    const isCodeOnly = choice === "Code only (restore files, keep conversation)" ||
      choice === "Restore to session start (files only, keep conversation)";

    if (choice === "Undo last file rewind") {
      const success = await restoreWithBackup(
        pi.exec,
        beforeRestoreRef!.commitSha,
        sessionId,
        ctx.ui.notify.bind(ctx.ui)
      );
      if (success) {
        ctx.ui.notify("Files restored to before last rewind", "info");
      }
      return { cancel: true };
    }

    if (!checkpointId) {
      ctx.ui.notify("No checkpoint available", "error");
      return { cancel: true };
    }

    const ref = `${REF_PREFIX}${checkpointId}`;
    const success = await restoreWithBackup(
      pi.exec,
      ref,
      sessionId,
      ctx.ui.notify.bind(ctx.ui)
    );
    
    if (!success) {
      // File restore failed - cancel the branch operation entirely
      // (restoreWithBackup already notified the user of the error)
      return { cancel: true };
    }
    
    ctx.ui.notify(
      usingResumeCheckpoint
        ? "Files restored to session start"
        : "Files restored from checkpoint",
      "info"
    );

    if (isCodeOnly) {
      return { skipConversationRestore: true };
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!sessionId) return;

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      if (result.stdout.trim() !== "true") return;
    } catch {
      return;
    }

    const targetId = event.preparation.targetId;
    const sanitizedTargetId = sanitizeForRef(targetId);
    let checkpointId = checkpoints.get(sanitizedTargetId);
    let usingResumeCheckpoint = false;

    if (!checkpointId && resumeCheckpoint) {
      checkpointId = resumeCheckpoint;
      usingResumeCheckpoint = true;
    }

    const beforeRestoreRef = await findBeforeRestoreRef(pi.exec, sessionId);
    const hasUndo = !!beforeRestoreRef;

    const options: string[] = [];

    if (checkpointId) {
      if (usingResumeCheckpoint) {
        options.push("Restore files to session start");
      } else {
        options.push("Restore files to that point");
      }
    }

    // Always offer "Keep current files" - user may want to navigate without restoring
    options.push("Keep current files");

    if (hasUndo) {
      options.push("Undo last file rewind");
    }

    options.push("Cancel navigation");

    const choice = await ctx.ui.select("Restore Options", options);

    if (!choice || choice === "Cancel navigation") {
      ctx.ui.notify("Navigation cancelled", "info");
      return { cancel: true };
    }

    if (choice === "Keep current files") {
      return;
    }

    if (choice === "Undo last file rewind") {
      const success = await restoreWithBackup(
        pi.exec,
        beforeRestoreRef!.commitSha,
        sessionId,
        ctx.ui.notify.bind(ctx.ui)
      );
      if (success) {
        ctx.ui.notify("Files restored to before last rewind", "info");
      }
      return { cancel: true };
    }

    if (!checkpointId) {
      ctx.ui.notify("No checkpoint available", "error");
      return { cancel: true };
    }

    const ref = `${REF_PREFIX}${checkpointId}`;
    const success = await restoreWithBackup(
      pi.exec,
      ref,
      sessionId,
      ctx.ui.notify.bind(ctx.ui)
    );
    
    if (!success) {
      // File restore failed - cancel navigation
      // (restoreWithBackup already notified the user of the error)
      return { cancel: true };
    }
    
    ctx.ui.notify(
      usingResumeCheckpoint
        ? "Files restored to session start"
        : "Files restored to checkpoint",
      "info"
    );
  });

}
