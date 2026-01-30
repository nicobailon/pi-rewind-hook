/**
 * Rewind Extension - Git-based file restoration for pi branching
 *
 * Creates worktree snapshots at the start of each agent loop (when user sends a message)
 * so /branch and tree navigation can restore code state.
 * Supports: restore files + conversation, files only, conversation only, undo last restore.
 *
 * Updated for pi-coding-agent v0.35.0+ (unified extensions system)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec as execCb } from "child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import {
  ensureTraceDir,
  readTraces,
  appendTrace,
  collectTraceShas,
  cleanOrphanedTraceRefs,
  type TraceRecord,
} from "./trace";
import { createDiffEngine } from "./diff";
import { looksLikeGitCommit, handleCommitDetected } from "./persist";
import { blameCommitted, blameUncommitted, type BlameResult } from "./blame";

const execAsync = promisify(execCb);

const REF_PREFIX = "refs/pi-checkpoints/";
const BEFORE_RESTORE_PREFIX = "before-restore-";
const MAX_CHECKPOINTS = 100;
const STATUS_KEY = "rewind";
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

let cachedSilentCheckpoints: boolean | null = null;
let cachedTraceHook: boolean | null = null;

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

function getTraceHookSetting(): boolean {
  if (cachedTraceHook !== null) {
    return cachedTraceHook;
  }
  try {
    const settingsContent = readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(settingsContent);
    cachedTraceHook = settings.rewind?.traceHook === true;
    return cachedTraceHook;
  } catch {
    cachedTraceHook = false;
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

  // Trace state
  let traceBeforeSha: string | null = null;
  let cachedModel: string | null = null;
  const diffCache = new Map<string, Map<string, import("./diff").DiffHunk[]>>();
  
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
    cachedTraceHook = null;
    traceBeforeSha = null;
    cachedModel = null;
    diffCache.clear();
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

  function installPostCommitHook(root: string): void {
    const hookDir = join(root, ".git", "hooks");
    if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });
    const hookPath = join(hookDir, "post-commit");
    const hookScript = new URL("./post-commit-hook.js", import.meta.url).pathname;
    const callLine = `node "${hookScript}"`;

    if (!existsSync(hookPath)) {
      writeFileSync(hookPath, `#!/bin/sh\n${callLine}\n`, "utf-8");
      chmodSync(hookPath, 0o755);
    } else {
      const content = readFileSync(hookPath, "utf-8");
      if (!content.includes("post-commit-hook.js")) {
        writeFileSync(hookPath, content.trimEnd() + `\n${callLine}\n`, "utf-8");
        chmodSync(hookPath, 0o755);
      }
    }
  }

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

    // Initialize trace directory and clean orphaned refs
    try {
      const root = await getRepoRoot(pi.exec);
      ensureTraceDir(root);
      const traces = readTraces(root);
      await cleanOrphanedTraceRefs(pi.exec, collectTraceShas(traces));

      if (getTraceHookSetting()) {
        installPostCommitHook(root);
      }
    } catch {
      // Silent failure - trace init is not critical
    }

    // Rebuild checkpoints map from existing git refs (for resumed sessions)
    // Only loads checkpoints belonging to this session
    await rebuildCheckpointsMap(pi.exec, sessionId);

    // Create a resume checkpoint for the current state (session-scoped like other checkpoints)
    const checkpointId = `checkpoint-resume-${sessionId}-${Date.now()}`;

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
      traceBeforeSha = commitSha;
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

  pi.on("model_select", (event) => {
    cachedModel = `${event.model.provider}/${event.model.id}`;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isGitRepo) return;
    if (!traceBeforeSha) return;

    try {
      const afterCommitSha = await captureWorktree();
      const root = await getRepoRoot(pi.exec);

      const diffResult = await pi.exec("git", [
        "diff-tree", "--numstat", "-r", "-z", traceBeforeSha, afterCommitSha,
      ]);
      const rawEntries = diffResult.stdout.split("\0").filter(Boolean);
      if (rawEntries.length === 0) return;

      const files: import("./trace").TraceRecord["files"] = [];
      const additions: Record<string, number> = {};
      const deletions: Record<string, number> = {};

      for (const entry of rawEntries) {
        const parts = entry.split("\t");
        if (parts.length < 3) continue;
        const [added, deleted, filePath] = parts;
        files.push({
          path: filePath,
          conversations: [{
            contributor: {
              type: "ai" as const,
              ...(cachedModel ? { model_id: cachedModel } : {}),
            },
            ranges: [],
          }],
        });
        if (added !== "-") additions[filePath] = parseInt(added, 10);
        if (deleted !== "-") deletions[filePath] = parseInt(deleted, 10);
      }

      if (files.length === 0) return;

      let headSha = "";
      try {
        const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
        headSha = headResult.stdout.trim();
      } catch { /* empty repo */ }

      let userMessage = "";
      let assistantMessage = "";
      try {
        if (event.messages) {
          for (const msg of event.messages) {
            if ("role" in msg && msg.role === "user" && "content" in msg && !userMessage) {
              const content = msg.content;
              if (typeof content === "string") {
                userMessage = content;
              } else if (Array.isArray(content)) {
                const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text);
                userMessage = textParts.join("\n");
              }
            }
            if ("role" in msg && msg.role === "assistant" && "content" in msg && !assistantMessage) {
              const content = msg.content;
              if (typeof content === "string") {
                assistantMessage = content;
              } else if (Array.isArray(content)) {
                const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text);
                assistantMessage = textParts.join("\n");
              }
            }
          }
        }
      } catch { /* transcript capture is best-effort */ }

      const pkgVersion = (() => {
        try {
          const pkgPath = new URL("./package.json", import.meta.url);
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          return pkg.version || "0.0.0";
        } catch {
          return "0.0.0";
        }
      })();

      const userEntry = findUserMessageEntry(ctx.sessionManager);
      const record: TraceRecord = {
        version: "1.0",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...(headSha ? { vcs: { type: "git", revision: headSha } } : {}),
        tool: { name: "pi-rewind-hook", version: pkgVersion },
        files,
        metadata: {
          "pi.session_id": sessionId || "",
          "pi.entry_id": userEntry?.id || "",
          "pi.before_sha": traceBeforeSha,
          "pi.after_sha": afterCommitSha,
          "pi.user_message": userMessage,
          ...(assistantMessage ? { "pi.assistant_message": assistantMessage } : {}),
          "pi.additions": additions,
          "pi.deletions": deletions,
        },
      };

      appendTrace(root, record);

      await pi.exec("git", [
        "update-ref", `refs/pi-trace-shas/${traceBeforeSha}`, traceBeforeSha,
      ]);
      await pi.exec("git", [
        "update-ref", `refs/pi-trace-shas/${afterCommitSha}`, afterCommitSha,
      ]);
    } catch {
      // Silent failure - trace capture is not critical
    } finally {
      traceBeforeSha = null;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isGitRepo) return;
    if (!("input" in event) || !event.input) return;
    const input = event.input as Record<string, unknown>;
    if (typeof input.command !== "string") return;
    if (!looksLikeGitCommit(input.command)) return;
    if ("isError" in event && event.isError) return;

    try {
      const root = await getRepoRoot(pi.exec);

      let userMessage = "";
      try {
        const entry = findUserMessageEntry(ctx.sessionManager);
        if (entry) {
          const leafId = ctx.sessionManager.getLeafId();
          if (leafId) {
            const branch = ctx.sessionManager.getBranch(leafId);
            const userEntry = branch.find((e: any) => e.id === entry.id);
            if (userEntry?.message?.content) {
              const c = userEntry.message.content;
              userMessage = typeof c === "string" ? c :
                Array.isArray(c) ? c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
            }
          }
        }
      } catch { /* best-effort */ }

      const result = await handleCommitDetected({
        exec: pi.exec,
        repoRoot: root,
        traceBeforeSha,
        captureWorktree,
        diffCache,
        sessionId: sessionId || "",
        cachedModel,
        findUserMessageEntry: () => findUserMessageEntry(ctx.sessionManager),
        userMessage,
      });
      traceBeforeSha = result.newTraceBeforeSha;
    } catch {
      // Silent failure - commit persistence is not critical
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

    try {
      const root = await getRepoRoot(pi.exec);
      const traces = readTraces(root);
      const matchingTrace = traces.find(
        t => t.metadata?.["pi.entry_id"] === event.entryId ||
             t.metadata?.["pi.entry_id"] === sanitizedEntryId
      );
      if (matchingTrace) {
        const adds = matchingTrace.metadata?.["pi.additions"] as Record<string, number> | undefined;
        const dels = matchingTrace.metadata?.["pi.deletions"] as Record<string, number> | undefined;
        const fileCount = matchingTrace.files.length;
        const totalAdds = adds ? Object.values(adds).reduce((s, v) => s + v, 0) : 0;
        const totalDels = dels ? Object.values(dels).reduce((s, v) => s + v, 0) : 0;
        ctx.ui.notify(
          `This message changed ${fileCount} file${fileCount === 1 ? "" : "s"} (+${totalAdds}, -${totalDels} lines)`,
          "info"
        );
      }
    } catch { /* trace context is best-effort */ }

    const beforeRestoreRef = await findBeforeRestoreRef(pi.exec, sessionId);
    const hasUndo = !!beforeRestoreRef;

    const options: string[] = [];

    // Conversation-only (non-file-restorative) first as most common action
    options.push("Conversation only (keep current files)");
    
    if (checkpointId) {
      if (usingResumeCheckpoint) {
        options.push("Restore to session start (files + conversation)");
        options.push("Restore to session start (files only, keep conversation)");
      } else {
        options.push("Restore all (files + conversation)");
        options.push("Code only (restore files, keep conversation)");
      }
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

    // Keep current files first as most common action (non-file-restorative navigation)
    options.push("Keep current files");

    if (checkpointId) {
      if (usingResumeCheckpoint) {
        options.push("Restore files to session start");
      } else {
        options.push("Restore files to that point");
      }
    }

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

  // /trace command registration
  let cachedTraceFiles: string[] = [];

  pi.registerCommand("trace", {
    description: "View prompt-to-code attribution. Usage: /trace or /trace blame <file> [startLine-endLine]",
    getArgumentCompletions(prefix: string) {
      if (!prefix || !prefix.trim()) {
        return [{ value: "blame", label: "blame — show per-line prompt attribution" }];
      }
      const trimmed = prefix.trim();
      if ("blame".startsWith(trimmed) && trimmed !== "blame") {
        return [{ value: "blame", label: "blame — show per-line prompt attribution" }];
      }
      if (trimmed.startsWith("blame ")) {
        const filePrefix = trimmed.slice(6).trim();
        return cachedTraceFiles
          .filter(f => f.startsWith(filePrefix))
          .map(f => ({ value: `blame ${f}`, label: f }));
      }
      return null;
    },
    async handler(args: string, ctx: ExtensionContext) {
      if (!isGitRepo) {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }

      try {
        const root = await getRepoRoot(pi.exec);
        const traces = readTraces(root);
        cachedTraceFiles = [...new Set(traces.flatMap(t => t.files.map(f => f.path)))];

        const trimmedArgs = (args || "").trim();

        if (trimmedArgs.startsWith("blame")) {
          await handleBlameCommand(trimmedArgs.slice(5).trim(), ctx, root);
        } else {
          await handleTurnBrowser(ctx, traces);
        }
      } catch (err) {
        ctx.ui.notify(`Trace error: ${err}`, "error");
      }
    },
  });

  async function handleBlameCommand(
    blameArgs: string,
    ctx: ExtensionContext,
    root: string,
  ) {
    if (!blameArgs) {
      ctx.ui.notify("Usage: /trace blame <file> [startLine-endLine]", "error");
      return;
    }

    let filePath: string;
    let startLine: number | undefined;
    let endLine: number | undefined;

    const rangeMatch = blameArgs.match(/^(.+?)\s+(\d+)(?:-(\d+))?$/);
    if (rangeMatch) {
      filePath = rangeMatch[1];
      startLine = parseInt(rangeMatch[2], 10);
      endLine = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : startLine;
    } else {
      filePath = blameArgs;
    }

    const statusResult = await pi.exec("git", ["status", "--porcelain", "--", filePath]);
    const isDirty = statusResult.stdout.trim().length > 0;

    const computeLineDiff = createDiffEngine(pi.exec, diffCache);

    let results: BlameResult[];

    if (isDirty) {
      results = await blameUncommitted(
        filePath,
        () => readTraces(root),
        computeLineDiff,
        captureWorktree,
        startLine,
        endLine,
      );
    } else {
      results = await blameCommitted(pi.exec, filePath, startLine, endLine);
    }

    if (results.length === 0) {
      ctx.ui.notify("No blame results", "warning");
      return;
    }

    const rangeLabel = startLine
      ? endLine && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`
      : "all";
    const header = `${filePath}:${rangeLabel} -- prompt attribution${isDirty ? " (uncommitted)" : ""}`;

    const lines: string[] = [header, "─".repeat(60)];

    if (isDirty) {
      lines.push("File has uncommitted changes -- showing current session only.");
      lines.push("Commit for full history.");
      lines.push("");
    }

    let i = 0;
    while (i < results.length) {
      const entry = results[i];
      const attr = entry.attribution;
      let label: string;
      let detail = "";

      if (typeof attr === "string") {
        label = `(${attr})`;
      } else {
        const msg = attr.userMessage.length > 55
          ? attr.userMessage.slice(0, 55) + "..."
          : attr.userMessage;
        const ref = attr.commitSha ? attr.commitSha.slice(0, 7) : attr.traceId.slice(0, 8);
        label = `${ref}  "${msg}"`;
        if (attr.modelId || attr.timestamp) {
          const parts: string[] = [];
          if (attr.modelId) parts.push(attr.modelId);
          const ts = new Date(attr.timestamp);
          if (!isNaN(ts.getTime())) {
            parts.push(ts.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
          }
          detail = parts.join("  ");
        }
      }

      let rangeEnd = i;
      while (
        rangeEnd + 1 < results.length &&
        JSON.stringify(results[rangeEnd + 1].attribution) === JSON.stringify(entry.attribution)
      ) {
        rangeEnd++;
      }

      const startLn = results[i].lineNumber;
      const endLn = results[rangeEnd].lineNumber;
      const lineRange = startLn === endLn ? ` ${startLn}` : ` ${startLn}-${endLn}`;
      lines.push(`${lineRange.padEnd(10)} ${label}`);
      if (detail) {
        lines.push(`${"".padEnd(10)} ${detail}`);
      }

      i = rangeEnd + 1;
    }

    lines.push("─".repeat(60));
    lines.push(" q to close");

    const output = lines.join("\n");

    await new Promise<void>((done) => {
      ctx.ui.custom((_tui, _theme, keybindings, resolve) => {
        keybindings.add({ key: "q", handler: () => { resolve(); done(); } });
        keybindings.add({ key: "escape", handler: () => { resolve(); done(); } });
        return output;
      });
    });
  }

  async function handleTurnBrowser(
    ctx: ExtensionContext,
    traces: import("./trace").TraceRecord[],
  ) {
    if (traces.length === 0) {
      ctx.ui.notify("No trace data -- no prompts have been tracked yet", "warning");
      return;
    }

    const items = traces.map((t, i) => {
      const msg = (t.metadata?.["pi.user_message"] as string || "").slice(0, 60);
      const fileCount = t.files.length;
      const adds = t.metadata?.["pi.additions"] as Record<string, number> | undefined;
      const dels = t.metadata?.["pi.deletions"] as Record<string, number> | undefined;
      const totalAdds = adds ? Object.values(adds).reduce((s, v) => s + v, 0) : 0;
      const totalDels = dels ? Object.values(dels).reduce((s, v) => s + v, 0) : 0;
      return `${i + 1}. "${msg}" — ${fileCount} file${fileCount === 1 ? "" : "s"} (+${totalAdds}, -${totalDels})`;
    }).reverse();

    const choice = await ctx.ui.select("Recent Traces", items);
    if (!choice) return;

    const idx = parseInt(choice.split(".")[0], 10) - 1;
    if (idx < 0 || idx >= traces.length) return;

    const trace = traces[idx];
    const fileItems = trace.files.map(f => {
      const adds = (trace.metadata?.["pi.additions"] as Record<string, number>)?.[f.path] ?? 0;
      const dels = (trace.metadata?.["pi.deletions"] as Record<string, number>)?.[f.path] ?? 0;
      return `${f.path} (+${adds}, -${dels})`;
    });

    const fileChoice = await ctx.ui.select("Files Changed", fileItems);
    if (!fileChoice) return;

    const selectedPath = fileChoice.split(" (+")[0];
    const beforeSha = trace.metadata?.["pi.before_sha"] as string;
    const afterSha = trace.metadata?.["pi.after_sha"] as string;
    if (!beforeSha || !afterSha) return;

    const computeLineDiff = createDiffEngine(pi.exec, diffCache);
    const hunks = await computeLineDiff(beforeSha, afterSha, selectedPath);

    const diffLines: string[] = [`--- ${selectedPath}`, `+++ ${selectedPath}`, ""];
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (hunk.type === "add") diffLines.push(`+${line}`);
        else if (hunk.type === "delete") diffLines.push(`-${line}`);
        else diffLines.push(` ${line}`);
      }
    }

    diffLines.push("", " q to close");
    const output = diffLines.join("\n");

    await new Promise<void>((done) => {
      ctx.ui.custom((_tui, _theme, keybindings, resolve) => {
        keybindings.add({ key: "q", handler: () => { resolve(); done(); } });
        keybindings.add({ key: "escape", handler: () => { resolve(); done(); } });
        return output;
      });
    });
  }

}
