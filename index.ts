/**
 * Rewind Extension - Git-based file restoration for pi branching
 *
 * Creates worktree snapshots at each turn so /branch can restore code state.
 * Supports: restore files + conversation, files only, conversation only, undo last restore.
 *
 * Updated for pi-coding-agent v0.35.0+ (unified extensions system)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec as execCb } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(execCb);

const REF_PREFIX = "refs/pi-checkpoints/";
const BEFORE_RESTORE_PREFIX = "before-restore-";
const MAX_CHECKPOINTS = 100;

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

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

  console.error(`[rewind] Extension loaded`);

  /**
   * Rebuild the checkpoints map from existing git refs.
   * Parses refs like `checkpoint-{timestamp}-{entryId}` to reconstruct the mapping.
   * This allows checkpoint restoration to work across session resumes.
   */
  async function rebuildCheckpointsMap(exec: ExecFn): Promise<void> {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=creatordate",
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

        // Parse: checkpoint-{timestamp}-{entryId}
        // Timestamp is always numeric (13 digits for ms since epoch)
        // Entry ID comes after the timestamp, may contain hyphens
        const match = checkpointId.match(/^checkpoint-(\d+)-(.+)$/);
        if (match) {
          const entryId = match[2];
          // Only keep the most recent checkpoint for each entry (Map overwrites)
          checkpoints.set(entryId, checkpointId);
        }
      }

      if (checkpoints.size > 0) {
        console.error(`[rewind] Rebuilt checkpoints map: ${checkpoints.size} entries`);
      }
    } catch (err) {
      console.error(`[rewind] Failed to rebuild checkpoints map: ${err}`);
    }
  }

  async function findBeforeRestoreRef(exec: ExecFn): Promise<{ refName: string; commitSha: string } | null> {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=-creatordate",
        "--count=1",
        "--format=%(refname) %(objectname)",
        `${REF_PREFIX}${BEFORE_RESTORE_PREFIX}*`,
      ]);

      const line = result.stdout.trim();
      if (!line) return null;

      const [refName, commitSha] = line.split(" ");
      return { refName, commitSha };
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

  async function captureWorktree(exec: ExecFn): Promise<string> {
    const root = await getRepoRoot(exec);
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-"));
    const tmpIndex = join(tmpDir, "index");

    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      await execAsync("git add -A", { cwd: root, env });
      const { stdout: treeSha } = await execAsync("git write-tree", { cwd: root, env });

      const { stdout: commitSha } = await execAsync(
        `git commit-tree ${treeSha.trim()} -m "rewind backup"`,
        { cwd: root }
      );
      return commitSha.trim();
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function restoreWithBackup(
    exec: ExecFn,
    targetRef: string,
    notify: (msg: string, level: "info" | "warning" | "error") => void
  ): Promise<boolean> {
    try {
      const existingBackup = await findBeforeRestoreRef(exec);

      const backupCommit = await captureWorktree(exec);
      const newBackupId = `${BEFORE_RESTORE_PREFIX}${Date.now()}`;
      await exec("git", [
        "update-ref",
        `${REF_PREFIX}${newBackupId}`,
        backupCommit,
      ]);
      console.error(`[rewind] Created backup: ${newBackupId}`);

      if (existingBackup) {
        await exec("git", ["update-ref", "-d", existingBackup.refName]);
        console.error(`[rewind] Deleted old backup: ${existingBackup.refName}`);
      }

      await exec("git", ["checkout", targetRef, "--", "."]);
      return true;
    } catch (err) {
      console.error(`[rewind] Failed to restore: ${err}`);
      notify(`Failed to restore files: ${err}`, "error");
      return false;
    }
  }

  async function createCheckpointFromWorktree(exec: ExecFn, checkpointId: string): Promise<boolean> {
    try {
      const commitSha = await captureWorktree(exec);
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

  async function pruneCheckpoints(exec: ExecFn) {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);
      // Filter to only regular checkpoints (not backups or resume checkpoints)
      const checkpointRefs = refs.filter(r =>
        !r.includes(BEFORE_RESTORE_PREFIX) &&
        !r.includes("checkpoint-resume-")
      );

      if (checkpointRefs.length > MAX_CHECKPOINTS) {
        const toDelete = checkpointRefs.slice(0, checkpointRefs.length - MAX_CHECKPOINTS);
        for (const ref of toDelete) {
          await exec("git", ["update-ref", "-d", ref]);
          console.error(`[rewind] Pruned old checkpoint: ${ref}`);

          // Remove from in-memory map ONLY if this is the currently mapped checkpoint.
          // There might be a newer checkpoint for the same entry that we're keeping.
          const checkpointId = ref.replace(REF_PREFIX, "");
          const match = checkpointId.match(/^checkpoint-(\d+)-(.+)$/);
          if (match) {
            const entryId = match[2];
            if (checkpoints.get(entryId) === checkpointId) {
              checkpoints.delete(entryId);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[rewind] Failed to prune checkpoints: ${err}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      isGitRepo = result.stdout.trim() === "true";
    } catch {
      isGitRepo = false;
    }

    if (!isGitRepo) return;

    // Rebuild checkpoints map from existing git refs (for resumed sessions)
    await rebuildCheckpointsMap(pi.exec);

    // Create a resume checkpoint for the current state
    const checkpointId = `checkpoint-resume-${Date.now()}`;

    try {
      const success = await createCheckpointFromWorktree(pi.exec, checkpointId);
      if (success) {
        resumeCheckpoint = checkpointId;
        console.error(`[rewind] Created resume checkpoint: ${checkpointId}`);
      }
    } catch (err) {
      console.error(`[rewind] Failed to create resume checkpoint: ${err}`);
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isGitRepo) return;

    // Get the current leaf entry - at turn_start, this is the USER message
    // that triggered this turn. Associate checkpoint with this entry so
    // navigating to this message restores files to this point.
    const leaf = ctx.sessionManager.getLeafEntry();
    if (!leaf) {
      console.error(`[rewind] No leaf entry available, skipping checkpoint creation`);
      return;
    }

    // Include entry ID in checkpoint name for persistence across sessions
    // Format: checkpoint-{timestamp}-{entryId}
    const entryId = leaf.id;
    const sanitizedEntryId = sanitizeForRef(entryId);
    const checkpointId = `checkpoint-${event.timestamp}-${sanitizedEntryId}`;

    try {
      const success = await createCheckpointFromWorktree(pi.exec, checkpointId);
      if (success) {
        checkpoints.set(sanitizedEntryId, checkpointId);
        console.error(`[rewind] Created checkpoint ${checkpointId} for entry ${entryId}`);
        await pruneCheckpoints(pi.exec);
      }
    } catch (err) {
      console.error(`[rewind] Failed to create checkpoint: ${err}`);
    }
  });

  pi.on("session_before_branch", async (event, ctx) => {
    if (!ctx.hasUI) return;

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

    const beforeRestoreRef = await findBeforeRestoreRef(pi.exec);
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
        ctx.ui.notify.bind(ctx.ui)
      );
      if (success) {
        ctx.ui.notify("Files restored to before last rewind", "info");
      }
      return { cancel: true };
    }

    const ref = `${REF_PREFIX}${checkpointId}`;
    const success = await restoreWithBackup(
      pi.exec,
      ref,
      ctx.ui.notify.bind(ctx.ui)
    );
    if (success) {
      ctx.ui.notify(
        usingResumeCheckpoint
          ? "Files restored to session start"
          : "Files restored from checkpoint",
        "info"
      );
    }

    if (isCodeOnly) {
      return { skipConversationRestore: true };
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!ctx.hasUI) return;

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

    const beforeRestoreRef = await findBeforeRestoreRef(pi.exec);
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
        ctx.ui.notify.bind(ctx.ui)
      );
      if (success) {
        ctx.ui.notify("Files restored to before last rewind", "info");
      }
      return { cancel: true };
    }

    const ref = `${REF_PREFIX}${checkpointId}`;
    const success = await restoreWithBackup(
      pi.exec,
      ref,
      ctx.ui.notify.bind(ctx.ui)
    );
    if (success) {
      ctx.ui.notify(
        usingResumeCheckpoint
          ? "Files restored to session start"
          : "Files restored to checkpoint",
        "info"
      );
    }
  });

}
