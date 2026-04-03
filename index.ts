/**
 * Rewind Extension - session-ledger based exact file restoration for pi branching
 *
 * Rewind v2 stores exact rewind metadata in hidden session custom entries and keeps
 * snapshot commits reachable through a single repo-local store ref.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec as execCb } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { mkdtemp, readdir, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";

const execAsync = promisify(execCb);

const STORE_REF = "refs/pi-rewind/store";
const STATUS_KEY = "rewind";
const FORK_PREFERENCE_SOURCE_ALLOWLIST = new Set(["fork-from-first"]);
const LEGACY_ZERO_SHA = "0000000000000000000000000000000000000000";
const RETENTION_SWEEP_THRESHOLD = 50;
const RETENTION_VERSION = 2;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

type GitExecResult = Awaited<ReturnType<ExecFn>>;

type BindingTuple = [entryId: string, snapshotIndex: number];

interface RewindSettings {
  rewind?: {
    silentCheckpoints?: boolean;
    retention?: {
      maxSnapshots?: number;
      maxAgeDays?: number;
      pinLabeledEntries?: boolean;
      scanMode?: "ancestor-only" | "repo-sessions";
      startupBudgetMs?: number;
    };
  };
}

type RewindRetentionSettings = NonNullable<NonNullable<RewindSettings["rewind"]>["retention"]>;

interface RewindTurnData {
  v: 2;
  snapshots: string[];
  bindings: BindingTuple[];
}

interface RewindOpData {
  v: 2;
  snapshots: string[];
  bindings?: BindingTuple[];
  current?: number;
  undo?: number;
}

interface ActivePromptCollector {
  snapshots: string[];
  bindings: BindingTuple[];
  promptText?: string;
  pendingUserCommitSha?: string;
}

interface ExactState {
  commitSha: string;
  treeSha: string;
}

interface ActiveBranchState {
  currentCommitSha?: string;
  currentTreeSha?: string;
  undoCommitSha?: string;
}

interface PendingResultingState {
  currentCommitSha: string;
  undoCommitSha?: string;
}

interface ParsedLedgerReference {
  commitSha: string;
  entryId?: string;
  timestamp: number;
  kind: "binding" | "current" | "undo";
}

interface ParsedSessionLedger {
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
  parentSession?: string;
  entryToCommit: Map<string, string>;
  labeledEntryIds: Set<string>;
  references: ParsedLedgerReference[];
  latestCurrentCommitSha?: string;
  latestUndoCommitSha?: string;
}

interface SessionLikeMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: string;
    timestamp?: number;
    content?: unknown;
  };
}

interface SessionLikeCustomEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
}

interface SessionLikeLabelEntry {
  type: "label";
  targetId: string;
  label?: string;
}

interface SessionLikeBranchSummaryEntry {
  type: "branch_summary";
  id: string;
}

interface SessionLikeGenericEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    timestamp?: number;
    content?: unknown;
  };
  customType?: string;
  data?: unknown;
  targetId?: string;
  label?: string;
}

type SessionLikeEntry =
  | SessionLikeMessageEntry
  | SessionLikeCustomEntry
  | SessionLikeLabelEntry
  | SessionLikeBranchSummaryEntry
  | SessionLikeGenericEntry;

let cachedSettings: RewindSettings | null = null;

function getSettingsFilePath(): string {
  return join(getAgentDir(), "settings.json");
}

function getDefaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function getSettings(): RewindSettings {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    cachedSettings = JSON.parse(readFileSync(getSettingsFilePath(), "utf-8")) as RewindSettings;
  } catch {
    // Invalid/missing settings must not disable rewind; fall back to defaults.
    cachedSettings = {};
  }

  return cachedSettings;
}

function getSilentCheckpointsSetting(): boolean {
  return getSettings().rewind?.silentCheckpoints === true;
}

function getRetentionSettings(): RewindRetentionSettings | undefined {
  return getSettings().rewind?.retention;
}

function getRetentionScanMode(): "ancestor-only" | "repo-sessions" {
  return getRetentionSettings()?.scanMode === "repo-sessions" ? "repo-sessions" : "ancestor-only";
}

function getStartupSweepBudgetMs(): number | undefined {
  const value = getRetentionSettings()?.startupBudgetMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function isRewindTurnData(value: unknown): value is RewindTurnData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<RewindTurnData>;
  return data.v === 2 && Array.isArray(data.snapshots) && Array.isArray(data.bindings);
}

function isRewindOpData(value: unknown): value is RewindOpData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<RewindOpData>;
  return data.v === 2 && Array.isArray(data.snapshots);
}

function canonicalizePath(value: string): string {
  const resolvedValue = resolve(value);
  try {
    return realpathSync.native(resolvedValue);
  } catch {
    // Path may not exist yet; compare with the resolved path directly.
    return resolvedValue;
  }
}

function isInsidePath(targetPath: string, parentPath: string): boolean {
  const resolvedTarget = canonicalizePath(targetPath);
  const resolvedParent = canonicalizePath(parentPath);
  const rel = relative(resolvedParent, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function updateLabelSet(labelIds: Set<string>, entry: SessionLikeLabelEntry) {
  if (!entry.targetId) return;
  if (entry.label && entry.label.trim()) {
    labelIds.add(entry.targetId);
    return;
  }
  labelIds.delete(entry.targetId);
}

function applyBindings(target: Map<string, string>, snapshots: string[], bindings?: BindingTuple[]) {
  if (!bindings) return;
  for (const [entryId, snapshotIndex] of bindings) {
    const commitSha = snapshots[snapshotIndex];
    if (entryId && commitSha) {
      target.set(entryId, commitSha);
    }
  }
}

function addReferences(target: ParsedLedgerReference[], snapshots: string[], timestamp: number, data: RewindTurnData | RewindOpData) {
  if ("bindings" in data && data.bindings) {
    for (const [entryId, snapshotIndex] of data.bindings) {
      const commitSha = snapshots[snapshotIndex];
      if (!commitSha) continue;
      target.push({ commitSha, entryId, timestamp, kind: "binding" });
    }
  }

  if ("current" in data && typeof data.current === "number") {
    const commitSha = snapshots[data.current];
    if (commitSha) {
      target.push({ commitSha, timestamp, kind: "current" });
    }
  }

  if ("undo" in data && typeof data.undo === "number") {
    const commitSha = snapshots[data.undo];
    if (commitSha) {
      target.push({ commitSha, timestamp, kind: "undo" });
    }
  }
}

function resolveBindingSnapshotIndex(snapshots: string[], commitSha: string): number {
  const existingIndex = snapshots.indexOf(commitSha);
  if (existingIndex >= 0) return existingIndex;
  snapshots.push(commitSha);
  return snapshots.length - 1;
}

function addBindingToCollector(collector: ActivePromptCollector, entryId: string, commitSha: string) {
  const snapshotIndex = resolveBindingSnapshotIndex(collector.snapshots, commitSha);
  collector.bindings.push([entryId, snapshotIndex]);
}

function getCommitFromData(data: RewindOpData, indexKey: "current" | "undo"): string | undefined {
  const snapshotIndex = data[indexKey];
  return typeof snapshotIndex === "number" ? data.snapshots[snapshotIndex] : undefined;
}

function isRestorableTreeEntry(entry: SessionLikeEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.type === "message") {
    return entry.message.role === "user" || entry.message.role === "assistant";
  }
  return entry.type === "branch_summary" || entry.type === "compaction";
}

function isAssistantMessageEntry(entry: SessionLikeEntry): entry is SessionLikeMessageEntry {
  return entry.type === "message" && entry.message.role === "assistant";
}

function findLatestUserMessageEntry(entries: SessionLikeEntry[]): SessionLikeMessageEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") {
      return entry;
    }
  }
  return null;
}

function findLatestMatchingUserMessageEntry(
  entries: SessionLikeEntry[],
  promptText: string | null | undefined,
): SessionLikeMessageEntry | null {
  if (!promptText) return null;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    if (getTextContent(entry.message.content) === promptText) {
      return entry;
    }
  }

  return null;
}

function findAssistantEntryForTurn(entries: SessionLikeEntry[], message: { timestamp?: number; content?: unknown }): SessionLikeMessageEntry | null {
  const targetTimestamp = message.timestamp;
  const targetText = getTextContent(message.content);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isAssistantMessageEntry(entry)) continue;

    if (targetTimestamp !== undefined && entry.message.timestamp === targetTimestamp) {
      return entry;
    }

    if (targetText && getTextContent(entry.message.content) === targetText) {
      return entry;
    }
  }

  return null;
}

export default function rewindExtension(pi: ExtensionAPI) {
  const entryToCommit = new Map<string, string>();
  const parsedSessionCache = new Map<string, { mtimeMs: number; ledger: ParsedSessionLedger }>();

  let repoRoot: string | null = null;
  let sessionId: string | null = null;
  let currentSessionFile: string | undefined;
  let currentParentSession: string | undefined;
  let currentSessionCwd: string | undefined;
  let isGitRepo = false;
  let lastExact: ExactState | null = null;
  let activeBranchState: ActiveBranchState = {};
  let promptCollector: ActivePromptCollector | null = null;
  let pendingForkState: PendingResultingState | null = null;
  let pendingTreeState: PendingResultingState | null = null;
  let activePromptText: string | null = null;
    let newSnapshotsSinceSweep = 0;
    let sweepRunning = false;
    let sweepCompletedThisSession = false;
  let forceConversationOnlyOnNextFork = false;
  let forceConversationOnlySource: string | null = null;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (!ctx.hasUI) return;
    if (level === "info" && getSilentCheckpointsSetting()) return;
    ctx.ui.notify(message, level);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!isGitRepo || getSilentCheckpointsSetting()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const uniqueSnapshots = new Set(entryToCommit.values()).size;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      STATUS_KEY,
      theme.fg("dim", "◆ ") + theme.fg("muted", `${entryToCommit.size} points / ${uniqueSnapshots} snapshots`),
    );
  }

  function resetState() {
    entryToCommit.clear();
    parsedSessionCache.clear();
    repoRoot = null;
    sessionId = null;
    currentSessionFile = undefined;
    currentParentSession = undefined;
    currentSessionCwd = undefined;
    isGitRepo = false;
    lastExact = null;
    activeBranchState = {};
    promptCollector = null;
    pendingForkState = null;
    pendingTreeState = null;
      activePromptText = null;
      newSnapshotsSinceSweep = 0;
      sweepCompletedThisSession = false;
    forceConversationOnlyOnNextFork = false;
    forceConversationOnlySource = null;
    cachedSettings = null;
  }

  function syncSessionIdentity(ctx: ExtensionContext) {
    sessionId = ctx.sessionManager.getSessionId();
    currentSessionFile = ctx.sessionManager.getSessionFile();
    currentParentSession = ctx.sessionManager.getHeader()?.parentSession;
    currentSessionCwd = ctx.sessionManager.getCwd();
  }

  async function execGitChecked(args: string[]): Promise<GitExecResult> {
    const result = await pi.exec("git", args);
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(stderr || `git ${args.join(" ")} failed with code ${result.code}`);
    }
    return result;
  }

  async function getRepoRoot(exec: ExecFn): Promise<string> {
    if (repoRoot) return repoRoot;
    const result = await exec("git", ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(stderr || `git rev-parse --show-toplevel failed with code ${result.code}`);
    }
    repoRoot = result.stdout.trim();
    return repoRoot;
  }

  async function captureWorktreeTree(): Promise<{ treeSha: string }> {
    const root = await getRepoRoot(pi.exec);
    const tempDir = await mkdtemp(join(tmpdir(), "pi-rewind-"));
    const tempIndex = join(tempDir, "index");

    try {
      const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
      await execAsync("git add -A", { cwd: root, env });
      const { stdout } = await execAsync("git write-tree", { cwd: root, env });
      return { treeSha: stdout.trim() };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        // Best effort cleanup for temporary index directory.
      });
    }
  }

  async function getCommitTreeSha(commitSha: string): Promise<string> {
    const result = await execGitChecked(["show", "-s", "--format=%T", commitSha]);
    return result.stdout.trim();
  }

  async function commitExists(commitSha: string): Promise<boolean> {
    const result = await pi.exec("git", ["cat-file", "-e", `${commitSha}^{commit}`]);
    return result.code === 0;
  }

  async function getStoreHead(): Promise<string | undefined> {
    const result = await pi.exec("git", ["rev-parse", "--verify", STORE_REF]);
    if (result.code !== 0) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value || undefined;
  }

  async function createStoreKeepaliveCommit(snapshotCommitSha: string, previousStoreHead?: string): Promise<string> {
    const args = ["commit-tree", EMPTY_TREE_SHA];

    if (previousStoreHead) {
      args.push("-p", previousStoreHead);
    }

    args.push("-p", snapshotCommitSha, "-m", "pi rewind store");
    const result = await execGitChecked(args);
    return result.stdout.trim();
  }

  async function appendSnapshotToStore(commitSha: string): Promise<void> {
    let attempts = 0;
    let lastError: unknown;

    while (attempts < 5) {
      attempts += 1;
      const oldHead = await getStoreHead();
      const keepaliveCommit = await createStoreKeepaliveCommit(commitSha, oldHead);

      try {
        if (oldHead) {
          await execGitChecked(["update-ref", STORE_REF, keepaliveCommit, oldHead]);
        } else {
          await execGitChecked(["update-ref", STORE_REF, keepaliveCommit, LEGACY_ZERO_SHA]);
        }
        return;
      } catch (error) {
        // Retry if another process updated the store ref concurrently.
        // Keep the most recent error for actionable failure context.
        lastError = error;
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`failed to update rewind store ref: ${detail}`);
  }

  async function rewriteStoreToLiveSet(liveCommitShas: string[]): Promise<"rewritten" | "preserved-empty"> {
    const uniqueLiveCommits = [...new Set(liveCommitShas.filter(Boolean))];
    if (uniqueLiveCommits.length === 0) {
      return "preserved-empty";
    }

    let head: string | undefined;
    for (const commitSha of uniqueLiveCommits) {
      head = await createStoreKeepaliveCommit(commitSha, head);
    }

    const oldHead = await getStoreHead();
    if (oldHead) {
      await execGitChecked(["update-ref", STORE_REF, head!, oldHead]);
      return "rewritten";
    }

    await execGitChecked(["update-ref", STORE_REF, head!, LEGACY_ZERO_SHA]);
    return "rewritten";
  }

  async function ensureSnapshotForTree(treeSha: string): Promise<string> {
    if (lastExact && lastExact.treeSha === treeSha) {
      return lastExact.commitSha;
    }

    const result = await execGitChecked(["commit-tree", treeSha, "-m", "pi rewind snapshot"]);
    const commitSha = result.stdout.trim();
    await appendSnapshotToStore(commitSha);
    lastExact = { commitSha, treeSha };
    newSnapshotsSinceSweep += 1;
    return commitSha;
  }

  async function ensureSnapshotForCurrentWorktree(): Promise<string> {
    const { treeSha } = await captureWorktreeTree();
    return ensureSnapshotForTree(treeSha);
  }

  async function deletePathsFromWorkingTree(paths: string[]) {
    if (paths.length === 0) return;
    const root = await getRepoRoot(pi.exec);

    for (const repoRelativePath of paths) {
      const absolutePath = resolve(root, repoRelativePath);
      if (!isInsidePath(absolutePath, root)) {
        throw new Error(`refusing to delete path outside repo root: ${repoRelativePath}`);
      }
      await rm(absolutePath, { recursive: true, force: true });
    }
  }

  async function getDeletedPaths(currentTreeSha: string, targetTreeSha: string): Promise<string[]> {
    const result = await execGitChecked([
      "diff",
      "--name-only",
      "--diff-filter=D",
      "-z",
      currentTreeSha,
      targetTreeSha,
      "--",
    ]);

    return result.stdout.split("\0").filter(Boolean);
  }

  async function restoreCommitExactly(targetCommitSha: string): Promise<{ changed: boolean; undoCommitSha?: string; targetTreeSha: string }> {
    const { treeSha: currentTreeSha } = await captureWorktreeTree();
    const targetTreeSha = await getCommitTreeSha(targetCommitSha);

    if (currentTreeSha === targetTreeSha) {
      lastExact = { commitSha: targetCommitSha, treeSha: targetTreeSha };
      return { changed: false, targetTreeSha };
    }

    const undoCommitSha = await ensureSnapshotForTree(currentTreeSha);
    const pathsToDelete = await getDeletedPaths(currentTreeSha, targetTreeSha);
    await deletePathsFromWorkingTree(pathsToDelete);
    await execGitChecked(["restore", `--source=${targetCommitSha}`, "--worktree", "--", "."]);
    lastExact = { commitSha: targetCommitSha, treeSha: targetTreeSha };
    return { changed: true, undoCommitSha, targetTreeSha };
  }

  function bindPendingPromptUser(entries: SessionLikeEntry[], collector: ActivePromptCollector) {
    if (!collector.pendingUserCommitSha) return;

    const userEntry = findLatestMatchingUserMessageEntry(entries, collector.promptText) ?? findLatestUserMessageEntry(entries);
    if (!userEntry) return;
    if (collector.bindings.some(([entryId]) => entryId === userEntry.id)) {
      collector.pendingUserCommitSha = undefined;
      return;
    }

    addBindingToCollector(collector, userEntry.id, collector.pendingUserCommitSha);
    collector.pendingUserCommitSha = undefined;
  }

  function appendRewindTurn(ctx: ExtensionContext, collector: ActivePromptCollector) {
    if (collector.bindings.length === 0) return;

    const data: RewindTurnData = {
      v: RETENTION_VERSION,
      snapshots: collector.snapshots,
      bindings: collector.bindings,
    };

    pi.appendEntry("rewind-turn", data);
    applyBindings(entryToCommit, data.snapshots, data.bindings);

    const latestBinding = data.bindings[data.bindings.length - 1];
    if (latestBinding) {
      activeBranchState.currentCommitSha = data.snapshots[latestBinding[1]];
      activeBranchState.currentTreeSha = lastExact?.commitSha === activeBranchState.currentCommitSha ? lastExact.treeSha : undefined;
    }

    updateStatus(ctx);
  }

  function appendRewindOp(ctx: ExtensionContext, data: RewindOpData) {
    const hasBindings = Boolean(data.bindings?.length);
    const hasCurrent = typeof data.current === "number";
    const hasUndo = typeof data.undo === "number";
    if (!hasBindings && !hasCurrent && !hasUndo) return;

    pi.appendEntry("rewind-op", data);
    applyBindings(entryToCommit, data.snapshots, data.bindings);

    const currentCommitSha = getCommitFromData(data, "current");
    if (currentCommitSha) {
      activeBranchState.currentCommitSha = currentCommitSha;
      activeBranchState.currentTreeSha = lastExact?.commitSha === currentCommitSha ? lastExact.treeSha : undefined;
    }

    const undoCommitSha = getCommitFromData(data, "undo");
    if (undoCommitSha) {
      activeBranchState.undoCommitSha = undoCommitSha;
    }

    updateStatus(ctx);
  }

  function buildCurrentSessionLedger(ctx: ExtensionContext): ParsedSessionLedger {
    const ledger: ParsedSessionLedger = {
      sessionFile: currentSessionFile ?? "",
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.sessionManager.getCwd(),
      parentSession: ctx.sessionManager.getHeader()?.parentSession,
      entryToCommit: new Map<string, string>(),
      labeledEntryIds: new Set<string>(),
      references: [],
    };

    for (const rawEntry of ctx.sessionManager.getEntries() as SessionLikeEntry[]) {
      if (rawEntry.type === "custom" && rawEntry.customType === "rewind-turn" && isRewindTurnData(rawEntry.data)) {
        applyBindings(ledger.entryToCommit, rawEntry.data.snapshots, rawEntry.data.bindings);
        addReferences(ledger.references, rawEntry.data.snapshots, toTimestamp(rawEntry.timestamp), rawEntry.data);
        continue;
      }

      if (rawEntry.type === "custom" && rawEntry.customType === "rewind-op" && isRewindOpData(rawEntry.data)) {
        applyBindings(ledger.entryToCommit, rawEntry.data.snapshots, rawEntry.data.bindings);
        addReferences(ledger.references, rawEntry.data.snapshots, toTimestamp(rawEntry.timestamp), rawEntry.data);
        const currentCommitSha = getCommitFromData(rawEntry.data, "current");
        if (currentCommitSha) ledger.latestCurrentCommitSha = currentCommitSha;
        const undoCommitSha = getCommitFromData(rawEntry.data, "undo");
        if (undoCommitSha) ledger.latestUndoCommitSha = undoCommitSha;
        continue;
      }

      if (rawEntry.type === "label") {
        updateLabelSet(ledger.labeledEntryIds, rawEntry);
      }
    }

    return ledger;
  }

  async function parseSessionLedgerFile(sessionFile: string): Promise<ParsedSessionLedger | null> {
    try {
      const fileStat = await stat(sessionFile);
      const cached = parsedSessionCache.get(sessionFile);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        return cached.ledger;
      }

      const content = await readFile(sessionFile, "utf-8");
      const ledger: ParsedSessionLedger = {
        sessionFile,
        entryToCommit: new Map<string, string>(),
        labeledEntryIds: new Set<string>(),
        references: [],
      };

      const hasRewindEntries = content.includes('"rewind-');

      if (!hasRewindEntries) {
        // Fast path: extract session header only, skip line-by-line JSON parsing
        let pos = 0;
        for (let i = 0; i < 5 && pos < content.length; i++) {
          const nextNewline = content.indexOf("\n", pos);
          const line = nextNewline >= 0 ? content.substring(pos, nextNewline) : content.substring(pos);
          pos = nextNewline >= 0 ? nextNewline + 1 : content.length;
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry?.type === "session") {
              ledger.sessionId = entry.id;
              ledger.cwd = entry.cwd;
              ledger.parentSession = entry.parentSession;
              break;
            }
          } catch {
            // Ignore malformed header lines from partial/corrupt session files.
            continue;
          }
        }
        parsedSessionCache.set(sessionFile, { mtimeMs: fileStat.mtimeMs, ledger });
        return ledger;
      }

      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          // Ignore malformed JSONL lines; retention discovery is best-effort.
          continue;
        }

        if (entry?.type === "session") {
          ledger.sessionId = entry.id;
          ledger.cwd = entry.cwd;
          ledger.parentSession = entry.parentSession;
          continue;
        }

        if (entry?.type === "custom" && entry?.customType === "rewind-turn" && isRewindTurnData(entry.data)) {
          applyBindings(ledger.entryToCommit, entry.data.snapshots, entry.data.bindings);
          addReferences(ledger.references, entry.data.snapshots, toTimestamp(entry.timestamp), entry.data);
          continue;
        }

        if (entry?.type === "custom" && entry?.customType === "rewind-op" && isRewindOpData(entry.data)) {
          applyBindings(ledger.entryToCommit, entry.data.snapshots, entry.data.bindings);
          addReferences(ledger.references, entry.data.snapshots, toTimestamp(entry.timestamp), entry.data);
          const currentCommitSha = getCommitFromData(entry.data, "current");
          if (currentCommitSha) ledger.latestCurrentCommitSha = currentCommitSha;
          const undoCommitSha = getCommitFromData(entry.data, "undo");
          if (undoCommitSha) ledger.latestUndoCommitSha = undoCommitSha;
          continue;
        }

        if (entry?.type === "label") {
          updateLabelSet(ledger.labeledEntryIds, entry);
        }
      }

      parsedSessionCache.set(sessionFile, { mtimeMs: fileStat.mtimeMs, ledger });
      return ledger;
    } catch {
      // Unreadable/missing session file: skip it and continue lineage/discovery.
      return null;
    }
  }

  async function resolveEntrySnapshotWithLineage(entryId: string, sessionFile = currentSessionFile): Promise<string | undefined> {
    let cursor = sessionFile;

    while (cursor) {
      const ledger = cursor === currentSessionFile ? buildCurrentSessionLedgerFromMemory() : await parseSessionLedgerFile(cursor);
      if (!ledger) break;

      const commitSha = ledger.entryToCommit.get(entryId);
      if (commitSha && (await commitExists(commitSha))) {
        return commitSha;
      }

      cursor = ledger.parentSession;
    }

    return undefined;
  }

  function buildCurrentSessionLedgerFromMemory(): ParsedSessionLedger {
    return {
      sessionFile: currentSessionFile ?? "",
      sessionId: sessionId ?? undefined,
      cwd: currentSessionCwd,
      parentSession: currentParentSession,
      entryToCommit: new Map(entryToCommit),
      labeledEntryIds: new Set(),
      references: [],
      latestCurrentCommitSha: activeBranchState.currentCommitSha,
      latestUndoCommitSha: activeBranchState.undoCommitSha,
    };
  }

  async function reconstructState(ctx: ExtensionContext) {
    entryToCommit.clear();
    activeBranchState = {};
    lastExact = null;

    const currentLedger = buildCurrentSessionLedger(ctx);
    for (const [entryId, commitSha] of currentLedger.entryToCommit.entries()) {
      entryToCommit.set(entryId, commitSha);
    }

    let latestVisibleBindingCommitSha: string | undefined;
    for (const entry of ctx.sessionManager.getBranch() as SessionLikeEntry[]) {
      const boundCommitSha = entry.id ? entryToCommit.get(entry.id) : undefined;
      if (boundCommitSha && isRestorableTreeEntry(entry)) {
        latestVisibleBindingCommitSha = boundCommitSha;
      }

      if (entry.type === "custom" && entry.customType === "rewind-op" && isRewindOpData(entry.data)) {
        const currentCommitSha = getCommitFromData(entry.data, "current");
        if (currentCommitSha) {
          activeBranchState.currentCommitSha = currentCommitSha;
        }
        const undoCommitSha = getCommitFromData(entry.data, "undo");
        if (undoCommitSha) {
          activeBranchState.undoCommitSha = undoCommitSha;
        }
      }
    }

    if (!activeBranchState.currentCommitSha) {
      activeBranchState.currentCommitSha = latestVisibleBindingCommitSha;
    }

    if (activeBranchState.currentCommitSha && (await commitExists(activeBranchState.currentCommitSha))) {
      activeBranchState.currentTreeSha = await getCommitTreeSha(activeBranchState.currentCommitSha);
      const { treeSha: worktreeTreeSha } = await captureWorktreeTree();

      if (activeBranchState.currentTreeSha === worktreeTreeSha) {
        lastExact = {
          commitSha: activeBranchState.currentCommitSha,
          treeSha: activeBranchState.currentTreeSha,
        };
      }
    }
  }

  async function discoverSessionFiles(scanMode: "ancestor-only" | "repo-sessions"): Promise<string[]> {
    const discovered = new Set<string>();

    if (scanMode === "repo-sessions") {
      const roots = new Set<string>();
      const defaultSessionsDir = getDefaultSessionsDir();
      if (existsSync(defaultSessionsDir)) {
        roots.add(defaultSessionsDir);
      }
      if (currentSessionFile) {
        roots.add(dirname(currentSessionFile));
      }

      const stack = [...roots];
      while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;

        let entries: Awaited<ReturnType<typeof readdir>>;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          // Skip unreadable directories during best-effort discovery.
          continue;
        }

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(fullPath);
            continue;
          }
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            discovered.add(fullPath);
          }
        }
      }
    }

    let ancestorCursor = currentSessionFile;
    while (ancestorCursor) {
      discovered.add(ancestorCursor);
      const ledger = ancestorCursor === currentSessionFile ? buildCurrentSessionLedgerFromMemory() : await parseSessionLedgerFile(ancestorCursor);
      ancestorCursor = ledger?.parentSession;
    }

    return [...discovered];
  }

  async function maybeSweepRetention(ctx: ExtensionContext, reason: "startup" | "new-snapshots" | "shutdown") {
    const retention = getRetentionSettings();
    if (!retention) return;
    if (reason === "new-snapshots" && newSnapshotsSinceSweep < RETENTION_SWEEP_THRESHOLD) return;
    if (reason === "shutdown" && sweepCompletedThisSession && newSnapshotsSinceSweep < RETENTION_SWEEP_THRESHOLD) return;
    if (!repoRoot) return;
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      await runRetentionSweep(ctx, reason);
    } finally {
      sweepRunning = false;
    }
  }

  async function runRetentionSweep(ctx: ExtensionContext, reason: "startup" | "new-snapshots" | "shutdown") {
    const retention = getRetentionSettings();
    if (!retention) return;

    const scanMode = getRetentionScanMode();
    const startupBudgetMs = reason === "startup" ? getStartupSweepBudgetMs() : undefined;
    const startedAt = Date.now();

    const budgetExceeded = () => typeof startupBudgetMs === "number" && Date.now() - startedAt > startupBudgetMs;

    const sessionFiles = await discoverSessionFiles(scanMode);
    if (budgetExceeded()) {
      notify(ctx, `Rewind retention startup sweep skipped after exceeding ${startupBudgetMs}ms budget`, "warning");
      return;
    }

    const ledgers: ParsedSessionLedger[] = [];

    for (const sessionFile of sessionFiles) {
      if (budgetExceeded()) {
        notify(ctx, `Rewind retention startup sweep skipped after exceeding ${startupBudgetMs}ms budget`, "warning");
        return;
      }

      const ledger = sessionFile === currentSessionFile ? buildCurrentSessionLedger(ctx) : await parseSessionLedgerFile(sessionFile);
      if (!ledger?.cwd) continue;
      if (!isInsidePath(ledger.cwd, repoRoot)) continue;
      ledgers.push(ledger);
    }

    const latestReferenceByCommit = new Map<string, number>();
    const pinnedCommits = new Set<string>();
    const currentCommits = new Set<string>();
    const undoCommits = new Set<string>();

    for (const ledger of ledgers) {
      if (budgetExceeded()) {
        notify(ctx, `Rewind retention startup sweep skipped after exceeding ${startupBudgetMs}ms budget`, "warning");
        return;
      }

      for (const reference of ledger.references) {
        const prev = latestReferenceByCommit.get(reference.commitSha) ?? 0;
        if (reference.timestamp > prev) {
          latestReferenceByCommit.set(reference.commitSha, reference.timestamp);
        }
        if (reference.kind === "binding" && retention.pinLabeledEntries && reference.entryId && ledger.labeledEntryIds.has(reference.entryId)) {
          pinnedCommits.add(reference.commitSha);
        }
      }

      if (ledger.latestCurrentCommitSha) {
        currentCommits.add(ledger.latestCurrentCommitSha);
      }
      if (ledger.latestUndoCommitSha) {
        undoCommits.add(ledger.latestUndoCommitSha);
      }
    }

    for (const commitSha of [...currentCommits, ...undoCommits]) {
      if (budgetExceeded()) {
        notify(ctx, `Rewind retention startup sweep skipped after exceeding ${startupBudgetMs}ms budget`, "warning");
        return;
      }
      if (await commitExists(commitSha)) {
        pinnedCommits.add(commitSha);
      }
    }

    let candidates = [...latestReferenceByCommit.entries()]
      .filter(([commitSha]) => !pinnedCommits.has(commitSha))
      .sort((left, right) => right[1] - left[1]);

    if (typeof retention.maxAgeDays === "number" && retention.maxAgeDays >= 0) {
      const cutoff = Date.now() - retention.maxAgeDays * 24 * 60 * 60 * 1000;
      candidates = candidates.filter(([, timestamp]) => timestamp >= cutoff);
    }

    if (typeof retention.maxSnapshots === "number" && retention.maxSnapshots >= 0 && candidates.length > retention.maxSnapshots) {
      candidates = candidates.slice(0, retention.maxSnapshots);
    }

    const liveSet = [...new Set([...pinnedCommits, ...candidates.map(([commitSha]) => commitSha)])];
    const existingLiveSet: string[] = [];
    for (const commitSha of liveSet) {
      if (budgetExceeded()) {
        notify(ctx, `Rewind retention startup sweep skipped after exceeding ${startupBudgetMs}ms budget`, "warning");
        return;
      }
      if (await commitExists(commitSha)) {
        existingLiveSet.push(commitSha);
      }
    }

    const rewriteResult = await rewriteStoreToLiveSet(existingLiveSet);
    if (rewriteResult === "preserved-empty") {
      return;
    }

    // Skip gc on background startup sweeps to avoid racing with concurrent snapshot creation
    if (reason !== "startup") {
      try {
        const result = await pi.exec("git", ["gc", "--auto"]);
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || `git gc --auto failed with code ${result.code}`);
        }
      } catch {
        // Best effort only; retention reachability rewrite already completed.
      }
    }

    newSnapshotsSinceSweep = 0;
    sweepCompletedThisSession = true;
    updateStatus(ctx);
  }

  async function initializeForSession(ctx: ExtensionContext) {
    resetState();
    syncSessionIdentity(ctx);

    try {
      const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
      isGitRepo = result.code === 0 && result.stdout.trim() === "true";
    } catch {
      // Treat git probing failures as non-git context for this session.
      isGitRepo = false;
    }

    if (!isGitRepo) {
      updateStatus(ctx);
      return;
    }

    await getRepoRoot(pi.exec);
    await reconstructState(ctx);
    updateStatus(ctx);
    maybeSweepRetention(ctx, "startup").catch((error) => {
      notify(ctx, `Rewind retention startup sweep failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    });
  }

  pi.events.on("rewind:fork-preference", (data: any) => {
    if (data?.mode !== "conversation-only") return;
    if (typeof data?.source !== "string") return;
    if (!FORK_PREFERENCE_SOURCE_ALLOWLIST.has(data.source)) return;
    forceConversationOnlyOnNextFork = true;
    forceConversationOnlySource = data.source;
  });

  pi.on("before_agent_start", async (event) => {
    activePromptText = event.prompt;
  });

  pi.on("session_start", async (_event, ctx) => {
    await initializeForSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await initializeForSession(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    syncSessionIdentity(ctx);
    if (!isGitRepo || !pendingForkState) {
      await reconstructState(ctx);
      updateStatus(ctx);
      return;
    }

    const snapshots = [pendingForkState.currentCommitSha];
    const data: RewindOpData = { v: RETENTION_VERSION, snapshots, current: 0 };
    if (pendingForkState.undoCommitSha) {
      data.snapshots.push(pendingForkState.undoCommitSha);
      data.undo = 1;
    }

    appendRewindOp(ctx, data);
    pendingForkState = null;
    await reconstructState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_tree", async (event, ctx) => {
    syncSessionIdentity(ctx);
    if (!isGitRepo || !pendingTreeState) {
      await reconstructState(ctx);
      updateStatus(ctx);
      return;
    }

    const snapshots = [pendingTreeState.currentCommitSha];
    const data: RewindOpData = { v: RETENTION_VERSION, snapshots, current: 0 };
    if (pendingTreeState.undoCommitSha) {
      data.snapshots.push(pendingTreeState.undoCommitSha);
      data.undo = 1;
    }
    if (event.summaryEntry?.id) {
      data.bindings = [[event.summaryEntry.id, 0]];
    }

    appendRewindOp(ctx, data);
    pendingTreeState = null;
    await reconstructState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_compact", async (event, ctx) => {
    syncSessionIdentity(ctx);
    if (!isGitRepo) return;

    let currentCommitSha = activeBranchState.currentCommitSha;
    if (!currentCommitSha) {
      currentCommitSha = await ensureSnapshotForCurrentWorktree();
    }

    appendRewindOp(ctx, {
      v: RETENTION_VERSION,
      snapshots: [currentCommitSha],
      bindings: [[event.compactionEntry.id, 0]],
    });
    await reconstructState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    syncSessionIdentity(ctx);
    if (!isGitRepo) return;
    await maybeSweepRetention(ctx, "shutdown");
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!isGitRepo) return;
    if (event.turnIndex !== 0) return;

    try {
      const { treeSha } = await captureWorktreeTree();
      const commitSha = await ensureSnapshotForTree(treeSha);
      promptCollector = {
        snapshots: [],
        bindings: [],
        promptText: activePromptText ?? undefined,
        pendingUserCommitSha: commitSha,
      };

      bindPendingPromptUser(ctx.sessionManager.getBranch() as SessionLikeEntry[], promptCollector);
    } catch (error) {
      promptCollector = null;
      notify(ctx, `Rewind: failed to capture start snapshot (${error instanceof Error ? error.message : String(error)})`, "warning");
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!isGitRepo || !promptCollector) return;

    try {
      const branchEntries = ctx.sessionManager.getBranch() as SessionLikeEntry[];
      bindPendingPromptUser(branchEntries, promptCollector);

      if (event.message.role !== "assistant") return;

      const assistantEntry = findAssistantEntryForTurn(branchEntries, event.message);
      if (!assistantEntry) return;

      const { treeSha } = await captureWorktreeTree();
      const commitSha = await ensureSnapshotForTree(treeSha);
      addBindingToCollector(promptCollector, assistantEntry.id, commitSha);
    } catch (error) {
      notify(ctx, `Rewind: failed to capture assistant snapshot (${error instanceof Error ? error.message : String(error)})`, "warning");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isGitRepo || !promptCollector) return;

    try {
      bindPendingPromptUser(ctx.sessionManager.getBranch() as SessionLikeEntry[], promptCollector);
      appendRewindTurn(ctx, promptCollector);
      await reconstructState(ctx);
      updateStatus(ctx);
      await maybeSweepRetention(ctx, "new-snapshots");
    } catch (error) {
      notify(ctx, `Rewind: failed to finalize rewind turn (${error instanceof Error ? error.message : String(error)})`, "warning");
    } finally {
      promptCollector = null;
      activePromptText = null;
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const shouldForceConversationOnly = forceConversationOnlyOnNextFork;
    const forcedBySource = forceConversationOnlySource;
    forceConversationOnlyOnNextFork = false;
    forceConversationOnlySource = null;

    if (!isGitRepo) return;

    try {
      if (!ctx.hasUI) {
        pendingForkState = { currentCommitSha: await ensureSnapshotForCurrentWorktree() };
        return;
      }

      const targetCommitSha = await resolveEntrySnapshotWithLineage(event.entryId);
      const hasUndo = Boolean(activeBranchState.undoCommitSha && (await commitExists(activeBranchState.undoCommitSha)));

      if (shouldForceConversationOnly) {
        pendingForkState = { currentCommitSha: await ensureSnapshotForCurrentWorktree() };
        notify(ctx, `Rewind: using conversation-only fork (keep current files)${forcedBySource ? ` (${forcedBySource})` : ""}`);
        return;
      }

      const options = ["Conversation only (keep current files)"];
      if (targetCommitSha) {
        options.push("Restore all (files + conversation)", "Code only (restore files, keep conversation)");
      }
      if (hasUndo) {
        options.push("Undo last file rewind");
      }

      const choice = await ctx.ui.select("Restore Options", options);
      if (!choice) {
        notify(ctx, "Rewind cancelled");
        return { cancel: true };
      }

      if (choice === "Undo last file rewind") {
        const restore = await restoreCommitExactly(activeBranchState.undoCommitSha!);
        pendingForkState = {
          currentCommitSha: activeBranchState.undoCommitSha!,
          undoCommitSha: restore.undoCommitSha,
        };
        notify(ctx, "Files restored to before last rewind");
        return;
      }

      if (choice === "Conversation only (keep current files)") {
        pendingForkState = { currentCommitSha: await ensureSnapshotForCurrentWorktree() };
        return;
      }

      if (!targetCommitSha) {
        notify(ctx, "No exact rewind point available for that entry", "error");
        return { cancel: true };
      }

      const restore = await restoreCommitExactly(targetCommitSha);
      pendingForkState = {
        currentCommitSha: targetCommitSha,
        undoCommitSha: restore.undoCommitSha,
      };
      notify(ctx, "Files restored from rewind point");

      if (choice === "Code only (restore files, keep conversation)") {
        return { skipConversationRestore: true };
      }
    } catch (error) {
      pendingForkState = null;
      notify(ctx, `Rewind failed before fork: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!isGitRepo || !ctx.hasUI) return;

    try {
      const targetEntry = ctx.sessionManager.getEntry(event.preparation.targetId) as SessionLikeEntry | undefined;
      const targetCommitSha = isRestorableTreeEntry(targetEntry)
        ? await resolveEntrySnapshotWithLineage(event.preparation.targetId, currentSessionFile)
        : undefined;
      const hasUndo = Boolean(activeBranchState.undoCommitSha && (await commitExists(activeBranchState.undoCommitSha)));

      const options = ["Keep current files"];
      if (targetCommitSha) {
        options.push("Restore files to that point");
      }
      if (hasUndo) {
        options.push("Undo last file rewind");
      }
      options.push("Cancel navigation");

      const choice = await ctx.ui.select("Restore Options", options);
      if (!choice || choice === "Cancel navigation") {
        notify(ctx, "Navigation cancelled");
        return { cancel: true };
      }

      if (choice === "Undo last file rewind") {
        const restore = await restoreCommitExactly(activeBranchState.undoCommitSha!);
        const snapshots = [activeBranchState.undoCommitSha!];
        const data: RewindOpData = { v: RETENTION_VERSION, snapshots, current: 0 };
        if (restore.undoCommitSha) {
          data.snapshots.push(restore.undoCommitSha);
          data.undo = 1;
        }
        appendRewindOp(ctx, data);
        notify(ctx, "Files restored to before last rewind");
        await reconstructState(ctx);
        return { cancel: true };
      }

      if (choice === "Keep current files") {
        pendingTreeState = { currentCommitSha: await ensureSnapshotForCurrentWorktree() };
        return;
      }

      if (!targetCommitSha) {
        notify(ctx, "Exact file rewind is only available for user, assistant, compaction, and summary nodes", "error");
        return { cancel: true };
      }

      const restore = await restoreCommitExactly(targetCommitSha);
      pendingTreeState = {
        currentCommitSha: targetCommitSha,
        undoCommitSha: restore.undoCommitSha,
      };
      notify(ctx, "Files restored to rewind point");
    } catch (error) {
      pendingTreeState = null;
      notify(ctx, `Rewind failed before tree navigation: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });
}
