import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
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

export default function (pi: HookAPI) {
  const checkpoints = new Map<number, string>();
  let resumeCheckpoint: string | null = null;
  let repoRoot: string | null = null;
  let isGitRepo = false;

  console.error(`[rewind] Hook loaded`);

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
    notify: (msg: string, level: "success" | "error" | "info") => void
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

  pi.on("session", async (event, ctx) => {
    if (event.reason !== "start") return;
    if (!ctx.hasUI) return;

    try {
      const result = await ctx.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      isGitRepo = result.stdout.trim() === "true";
    } catch {
      isGitRepo = false;
    }

    if (!isGitRepo) return;

    const checkpointId = `checkpoint-resume-${Date.now()}`;

    try {
      const success = await createCheckpointFromWorktree(ctx.exec, checkpointId);
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

    const checkpointId = `checkpoint-${event.timestamp}`;

    try {
      const success = await createCheckpointFromWorktree(ctx.exec, checkpointId);
      if (success) {
        checkpoints.set(event.turnIndex, checkpointId);
        console.error(
          `[rewind] Created checkpoint ${checkpointId} for turn ${event.turnIndex}`
        );
        await pruneCheckpoints(ctx.exec);
      }
    } catch (err) {
      console.error(`[rewind] Failed to create checkpoint: ${err}`);
    }
  });

  pi.on("session", async (event, ctx) => {
    if (event.reason !== "branch") return;
    if (!ctx.hasUI) return;
    if (!isGitRepo) return;

    let checkpointId = checkpoints.get(event.targetTurnIndex);
    let usingResumeCheckpoint = false;

    if (!checkpointId && resumeCheckpoint) {
      checkpointId = resumeCheckpoint;
      usingResumeCheckpoint = true;
    }

    const beforeRestoreRef = await findBeforeRestoreRef(ctx.exec);
    const hasUndo = !!beforeRestoreRef;

    if (!checkpointId && !hasUndo) {
      ctx.ui.notify(
        "No checkpoint available for this message",
        "info"
      );
      return;
    }

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
    }

    if (hasUndo) {
      options.push("Undo last file rewind");
    }

    const choice = await ctx.ui.select("Restore Options", options);

    if (!choice) {
      ctx.ui.notify("Rewind cancelled", "info");
      return;
    }

    if (choice.startsWith("Conversation only")) {
      return;
    }

    const isCodeOnly = choice === "Code only (restore files, keep conversation)" ||
      choice === "Restore to session start (files only, keep conversation)";

    if (choice === "Undo last file rewind") {
      const success = await restoreWithBackup(
        ctx.exec,
        beforeRestoreRef!.commitSha,
        ctx.ui.notify.bind(ctx.ui)
      );
      if (success) {
        ctx.ui.notify("Files restored to before last rewind", "success");
      }
      return { skipConversationRestore: true };
    }

    const ref = `${REF_PREFIX}${checkpointId}`;
    const success = await restoreWithBackup(
      ctx.exec,
      ref,
      ctx.ui.notify.bind(ctx.ui)
    );
    if (success) {
      ctx.ui.notify(
        usingResumeCheckpoint 
          ? "Files restored to session start" 
          : "Files restored from checkpoint",
        "success"
      );
    }

    if (isCodeOnly) {
      return { skipConversationRestore: true };
    }
  });

  async function pruneCheckpoints(exec: ExecFn) {
    try {
      const result = await exec("git", [
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);
      const currentResumeRef = resumeCheckpoint ? `${REF_PREFIX}${resumeCheckpoint}` : null;
      const checkpointRefs = refs.filter(r => 
        !r.includes(BEFORE_RESTORE_PREFIX) && r !== currentResumeRef
      );

      if (checkpointRefs.length > MAX_CHECKPOINTS) {
        const toDelete = checkpointRefs.slice(0, checkpointRefs.length - MAX_CHECKPOINTS);
        for (const ref of toDelete) {
          await exec("git", ["update-ref", "-d", ref]);
          console.error(`[rewind] Pruned old checkpoint: ${ref}`);
        }
      }
    } catch (err) {
      console.error(`[rewind] Failed to prune checkpoints: ${err}`);
    }
  }
}
