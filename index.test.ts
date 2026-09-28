import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import rewindExtension from "./index.ts";

const execFileAsync = promisify(execFile);
const STORE_REF = "refs/pi-rewind/store";

type RewindEntry = Record<string, unknown>;
type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

class SessionManagerStub {
  private readonly header: { type: "session"; version: number; id: string; timestamp: string; cwd: string; parentSession?: string };
  private entries: RewindEntry[];
  private readonly sessionFile: string;

  constructor(options: {
    sessionFile: string;
    id: string;
    cwd: string;
    parentSession?: string;
    entries?: RewindEntry[];
  }) {
    this.sessionFile = options.sessionFile;
    this.header = {
      type: "session",
      version: 3,
      id: options.id,
      timestamp: new Date().toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSession,
    };
    this.entries = options.entries ?? [];
    this.flush();
  }

  flush(): void {
    mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    const lines = [this.header, ...this.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(this.sessionFile, lines);
  }

  replaceEntries(entries: RewindEntry[]): void {
    this.entries = entries;
    this.flush();
  }

  appendCustom(customType: string, data: unknown): void {
    const parentId = (this.entries.at(-1)?.id as string | undefined) ?? null;
    this.entries.push({
      type: "custom",
      customType,
      data,
      id: `${customType}-${this.entries.length + 1}`,
      parentId,
      timestamp: new Date().toISOString(),
    });
    this.flush();
  }

  getSessionId(): string {
    return this.header.id;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  getHeader(): { parentSession?: string } {
    return { parentSession: this.header.parentSession };
  }

  getCwd(): string {
    return this.header.cwd;
  }

  getEntries(): RewindEntry[] {
    return this.entries;
  }

  getBranch(): RewindEntry[] {
    return this.entries;
  }

  getEntry(entryId: string): RewindEntry | undefined {
    return this.entries.find((entry) => entry.id === entryId);
  }
}

async function runGit(repoRoot: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: repoRoot });
    return { stdout, stderr, code: 0 };
  } catch (error: unknown) {
    const execError = error && typeof error === "object"
      ? error as Partial<{ stdout: string; stderr: string; message: string; code: number }>
      : undefined;
    return {
      stdout: execError?.stdout ?? "",
      stderr: execError?.stderr ?? execError?.message ?? "",
      code: execError?.code ?? 1,
    };
  }
}

function gitSubcommandOf(args: string[]): string {
  // Skip global -c key=value options that precede the subcommand.
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index] ?? "";
}

async function runGitChecked(repoRoot: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await runGit(repoRoot, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || `exit ${result.code}`}`);
  }
  return result;
}

async function gitStdout(repoRoot: string, args: string[]): Promise<string> {
  return (await runGitChecked(repoRoot, args)).stdout.trim();
}

async function revParseOptional(repoRoot: string, ref: string): Promise<string | undefined> {
  try {
    return await gitStdout(repoRoot, ["rev-parse", ref]);
  } catch {
    return undefined;
  }
}

async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGitChecked(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function captureSnapshot(repoRoot: string): Promise<string> {
  await runGitChecked(repoRoot, ["add", "-A"]);
  const treeSha = await gitStdout(repoRoot, ["write-tree"]);
  return await gitStdout(repoRoot, ["commit-tree", treeSha, "-m", "rewind snapshot test"]);
}

async function createSubmoduleFixture(repoRoot: string) {
  const sourceRepo = await mkdtemp(path.join(path.dirname(repoRoot), "rewind-submodule-source-"));
  await runGitChecked(sourceRepo, ["init"]);
  await runGitChecked(sourceRepo, ["config", "user.name", "Rewind Test"]);
  await runGitChecked(sourceRepo, ["config", "user.email", "rewind@example.com"]);
  await writeFile(path.join(sourceRepo, "file.txt"), "submodule v1\n");
  await runGitChecked(sourceRepo, ["add", "file.txt"]);
  await runGitChecked(sourceRepo, ["commit", "-m", "submodule v1"]);
  const firstCommit = await gitStdout(sourceRepo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(sourceRepo, "file.txt"), "submodule v2\n");
  await runGitChecked(sourceRepo, ["add", "file.txt"]);
  await runGitChecked(sourceRepo, ["commit", "-m", "submodule v2"]);
  const secondCommit = await gitStdout(sourceRepo, ["rev-parse", "HEAD"]);

  await runGitChecked(repoRoot, ["commit", "--allow-empty", "-m", "before submodule"]);
  const beforeSubmoduleCommit = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);
  await runGitChecked(repoRoot, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sourceRepo, "nested"]);
  await runGitChecked(repoRoot, ["-C", "nested", "checkout", "--detach", firstCommit]);
  await runGitChecked(repoRoot, ["add", "nested"]);
  await runGitChecked(repoRoot, ["commit", "-m", "pin submodule v1"]);
  const firstSuperCommit = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);
  await runGitChecked(repoRoot, ["-C", "nested", "checkout", "--detach", secondCommit]);
  await runGitChecked(repoRoot, ["add", "nested"]);
  await runGitChecked(repoRoot, ["commit", "-m", "pin submodule v2"]);
  const secondSuperCommit = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);

  return { beforeSubmoduleCommit, firstCommit, firstSuperCommit, secondSuperCommit };
}

async function createHarness(options: {
  settings?: Record<string, unknown>;
  failGitSubcommands?: string[];
  pauseGitSubcommand?: { name: string; occurrence: number };
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rewind-ext-test-"));
  const repoRoot = path.join(root, "repo");
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(agentDir, "sessions", "--repo--");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(options.settings ?? {}, null, 2) + "\n");

  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Snapshot indexes live until session_shutdown, which most tests never send.
  const tempDir = path.join(root, "tmp");
  mkdirSync(tempDir);
  const originalTempEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  for (const name of Object.keys(originalTempEnv)) process.env[name] = tempDir;

  await runGitChecked(repoRoot, ["init"]);
  await runGitChecked(repoRoot, ["config", "user.name", "Rewind Test"]);
  await runGitChecked(repoRoot, ["config", "user.email", "rewind@example.com"]);

  const handlers = new Map<string, EventHandler>();
  const eventHandlers = new Map<string, EventHandler>();
  const execCalls: string[][] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const pendingSelections: string[] = [];
  const gitSubcommandCounts = new Map<string, number>();
  let pauseStartedResolve: (() => void) | undefined;
  const pauseStarted = new Promise<void>((resolve) => {
    pauseStartedResolve = resolve;
  });
  let resumePausedGitCall: (() => void) | undefined;

  const currentSession = new SessionManagerStub({
    sessionFile: path.join(sessionsDir, "session-1.jsonl"),
    id: "session-1",
    cwd: repoRoot,
  });
  let activeSession = currentSession;

  const api = {
    exec: async (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      if (cmd !== "git") {
        throw new Error(`Unsupported command in test harness: ${cmd}`);
      }

      const gitSubcommand = gitSubcommandOf(args);
      const occurrence = (gitSubcommandCounts.get(gitSubcommand) ?? 0) + 1;
      gitSubcommandCounts.set(gitSubcommand, occurrence);
      if (options.failGitSubcommands?.includes(gitSubcommand)) {
        return {
          stdout: "",
          stderr: `forced git failure for ${gitSubcommand}`,
          code: 1,
        };
      }
      if (options.pauseGitSubcommand?.name === gitSubcommand
        && options.pauseGitSubcommand.occurrence === occurrence) {
        pauseStartedResolve?.();
        await new Promise<void>((resolve) => {
          resumePausedGitCall = resolve;
        });
      }

      return runGit(repoRoot, args);
    },
    appendEntry: (customType: string, data: unknown) => {
      activeSession.appendCustom(customType, data);
    },
    on: (eventName: string, handler: EventHandler) => {
      handlers.set(eventName, handler);
    },
    events: {
      on: (eventName: string, handler: (data: unknown) => void) => {
        eventHandlers.set(eventName, handler);
      },
    },
  } satisfies Pick<ExtensionAPI, "exec" | "appendEntry" | "on" | "events">;

  rewindExtension(api as ExtensionAPI);

  function createContext(sessionManager: SessionManagerStub, hasUI = true) {
    return {
      cwd: repoRoot,
      hasUI,
      sessionManager,
      ui: {
        notify: (message: string, level: string) => {
          notifications.push({ message, level });
        },
        setStatus: (key: string, value: string | undefined) => {
          statusUpdates.push({ key, value });
        },
        select: async (title: string, choices: string[]) => {
          selectCalls.push({ title, options: choices });
          return pendingSelections.shift();
        },
        theme: {
          fg: (_color: string, text: string) => text,
        },
      },
    };
  }

  return {
    repoRoot,
    agentDir,
    currentSession,
    execCalls,
    notifications,
    selectCalls,
    statusUpdates,
    enqueueSelection(choice: string) {
      pendingSelections.push(choice);
    },
    async writeRepoFile(relativePath: string, content: string) {
      const filePath = path.join(repoRoot, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    },
    readRepoFile(relativePath: string) {
      return readFileSync(path.join(repoRoot, relativePath), "utf-8");
    },
    createSession(options: { id: string; parentSession?: string; entries?: RewindEntry[] }) {
      return new SessionManagerStub({
        sessionFile: path.join(sessionsDir, `${options.id}.jsonl`),
        id: options.id,
        cwd: repoRoot,
        parentSession: options.parentSession,
        entries: options.entries,
      });
    },
    async invoke(eventName: string, event: unknown, sessionManager = activeSession, hasUI = true) {
      const handler = handlers.get(eventName);
      assert.ok(handler, `missing handler for ${eventName}`);
      activeSession = sessionManager;
      return handler(event, createContext(sessionManager, hasUI));
    },
    async captureSnapshot() {
      return captureSnapshot(repoRoot);
    },
    async revParseStore() {
      return revParseOptional(repoRoot, STORE_REF);
    },
    async updateStoreRef(commitSha: string) {
      await runGitChecked(repoRoot, ["update-ref", STORE_REF, commitSha]);
    },
    async isAncestor(ancestor: string, descendant: string) {
      return isAncestor(repoRoot, ancestor, descendant);
    },
    eventHandlers,
    async waitForPausedGitCall() {
      assert.ok(options.pauseGitSubcommand, "the harness was not configured to pause git");
      await pauseStarted;
    },
    resumePausedGitCall() {
      assert.ok(resumePausedGitCall, "no git invocation is paused");
      resumePausedGitCall();
      resumePausedGitCall = undefined;
    },
    async cleanup() {
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
      for (const [name, value] of Object.entries(originalTempEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("/fork undo restores files into a child session instead of cancelling the fork", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    await harness.writeRepoFile("notes.txt", "current state\n");
    const currentCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("notes.txt", "undo target\n");
    const undoCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Fork from here" }] },
      },
      {
        type: "custom",
        id: "rewind-op-1",
        parentId: "user-1",
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [currentCommit, undoCommit], current: 0, undo: 1 },
      },
    ]);

    await harness.invoke("session_start", {});
    harness.enqueueSelection("Undo last file rewind");

    const result = await harness.invoke("session_before_fork", { entryId: "user-1" });
    assert.equal(result, undefined);
    assert.equal(harness.readRepoFile("notes.txt"), "undo target\n");

    const currentSessionRewindOps = harness.currentSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewind-op");
    assert.equal(currentSessionRewindOps.length, 1);

    const previousSessionFile = harness.currentSession.getSessionFile();
    const childSession = harness.createSession({
      id: "session-2",
      parentSession: previousSessionFile,
    });
    await harness.invoke("session_start", { reason: "fork", previousSessionFile }, childSession);

    const childRewindOps = childSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewind-op");
    assert.equal(childRewindOps.length, 1);
    assert.deepEqual(childRewindOps[0]?.data, {
      v: 2,
      snapshots: [undoCommit, currentCommit],
      current: 0,
      undo: 1,
    });
  } finally {
    await harness.cleanup();
  }
});

test("session_before_fork gracefully cancels when restore fails", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
    failGitSubcommands: ["restore"],
  });

  try {
    await harness.writeRepoFile("notes.txt", "target state\n");
    const targetCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Restore from here" }] },
      },
      {
        type: "custom",
        id: "rewind-turn-1",
        parentId: "user-1",
        timestamp: new Date().toISOString(),
        customType: "rewind-turn",
        data: { v: 2, snapshots: [targetCommit], bindings: [["user-1", 0]] },
      },
    ]);

    await harness.invoke("session_start", {});
    harness.enqueueSelection("Restore all (files + conversation)");

    const result = await harness.invoke("session_before_fork", { entryId: "user-1" });
    assert.deepEqual(result, { cancel: true });
    assert.equal(
      harness.notifications.some((entry) => entry.level === "error" && entry.message.includes("Rewind failed before fork")),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});

test("session_before_tree gracefully cancels when restore fails", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
    failGitSubcommands: ["restore"],
  });

  try {
    await harness.writeRepoFile("notes.txt", "target state\n");
    const targetCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Tree target" }] },
      },
      {
        type: "custom",
        id: "rewind-turn-1",
        parentId: "user-1",
        timestamp: new Date().toISOString(),
        customType: "rewind-turn",
        data: { v: 2, snapshots: [targetCommit], bindings: [["user-1", 0]] },
      },
    ]);

    await harness.invoke("session_start", {});
    harness.enqueueSelection("Restore files to that point");

    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "user-1" } });
    assert.deepEqual(result, { cancel: true });
    assert.equal(
      harness.notifications.some((entry) => entry.level === "error" && entry.message.includes("Rewind failed before tree navigation")),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});

test("session_before_tree restores directly from a custom message with a checkpoint", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
  });

  try {
    await harness.writeRepoFile("notes.txt", "target state\n");
    const targetCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.currentSession.replaceEntries([
      {
        type: "custom_message",
        id: "marker-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "pi-custom-compaction.virtual-summary-marker",
        content: "Older context was summarized in the background.",
        display: true,
      },
      {
        type: "custom",
        id: "rewind-op-1",
        parentId: "marker-1",
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [targetCommit], bindings: [["marker-1", 0]] },
      },
    ]);

    await harness.invoke("session_start", {});
    harness.enqueueSelection("Restore files to that point");

    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "marker-1" } });
    assert.equal(result, undefined);
    assert.equal(harness.readRepoFile("notes.txt"), "target state\n");
    assert.deepEqual(harness.selectCalls[0]?.options, ["Keep current files", "Restore files to that point", "Cancel navigation"]);
  } finally {
    await harness.cleanup();
  }
});

test("rewind:checkpoint-entry binds the current tree to a custom message", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
  });

  try {
    await harness.writeRepoFile("notes.txt", "target state\n");
    harness.currentSession.replaceEntries([
      {
        type: "custom_message",
        id: "marker-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "pi-custom-compaction.virtual-summary-marker",
        content: "Older context was summarized in the background.",
        display: true,
      },
    ]);

    await harness.invoke("session_start", {});
    const checkpointHandler = harness.eventHandlers.get("rewind:checkpoint-entry");
    assert.ok(checkpointHandler, "missing rewind:checkpoint-entry handler");
    await checkpointHandler({ source: "pi-custom-compaction", entryId: "marker-1" });
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.enqueueSelection("Restore files to that point");
    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "marker-1" } });
    assert.equal(result, undefined);
    assert.equal(harness.readRepoFile("notes.txt"), "target state\n");
  } finally {
    await harness.cleanup();
  }
});

test("session_before_tree auto-keeps current files during boomerang collapse", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
  });

  try {
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Tree target" }] },
      },
    ]);

    await harness.invoke("session_start", {});
    (globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = true;

    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "user-1" } });
    assert.equal(result, undefined);
    assert.equal(harness.selectCalls.length, 0);

    await harness.invoke("session_tree", { summaryEntry: { id: "summary-1" } });

    const rewindOps = harness.currentSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewind-op");
    assert.equal(rewindOps.length, 1);
  } finally {
    delete (globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress;
    await harness.cleanup();
  }
});

test("session_before_tree auto-keeps current files during headless boomerang collapse", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
  });

  try {
    await harness.writeRepoFile("notes.txt", "current state\n");

    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Tree target" }] },
      },
    ]);

    await harness.invoke("session_start", {});
    (globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = true;

    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "user-1" } }, harness.currentSession, false);
    assert.equal(result, undefined);
    assert.equal(harness.selectCalls.length, 0);

    await harness.invoke("session_tree", { summaryEntry: { id: "summary-1" } }, harness.currentSession, false);

    const rewindOps = harness.currentSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewind-op");
    assert.equal(rewindOps.length, 1);
  } finally {
    delete (globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress;
    await harness.cleanup();
  }
});

test("first mutating turn creates a reachable store ref even when retention is omitted", async () => {
  const harness = await createHarness({
    settings: { rewind: { silentCheckpoints: true } },
  });

  try {
    const assistantTimestamp = Date.now();
    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date(assistantTimestamp - 1000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Please create the file" }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: new Date(assistantTimestamp).toISOString(),
        message: {
          role: "assistant",
          timestamp: assistantTimestamp,
          content: [{ type: "text", text: "Created the file" }],
        },
      },
    ]);

    await harness.invoke("session_start", {});
    await harness.invoke("before_agent_start", { prompt: "Please create the file" });
    await harness.invoke("turn_start", { turnIndex: 0 });
    await harness.writeRepoFile("tests/rewind-smoke/a.txt", "smoke test\n");
    await harness.invoke("turn_end", {
      message: {
        role: "assistant",
        timestamp: assistantTimestamp,
        content: [{ type: "text", text: "Created the file" }],
      },
    });
    await harness.invoke("agent_end", {});

    const rewindTurnEntries = harness.currentSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewind-turn");
    assert.equal(rewindTurnEntries.length, 1);
    const snapshots = (rewindTurnEntries[0]?.data as { snapshots: string[] }).snapshots;
    assert.equal(snapshots.length, 2);

    const storeHead = await harness.revParseStore();
    assert.ok(storeHead);
    assert.equal(await harness.isAncestor(snapshots[0], storeHead), true);
    assert.equal(await harness.isAncestor(snapshots[1], storeHead), true);

  } finally {
    await harness.cleanup();
  }
});

test("startup does not touch the keepalive ref when rewind.retention is omitted", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    await harness.writeRepoFile("tracked.txt", "keepalive\n");
    const snapshotCommit = await harness.captureSnapshot();
    await harness.updateStoreRef(snapshotCommit);

    await harness.invoke("session_start", {});

    assert.equal(await harness.revParseStore(), snapshotCommit);
    assert.equal(harness.execCalls.some((call) => call[0] === "git" && call[1] === "gc"), false);
    assert.equal(harness.execCalls.some((call) => call[0] === "git" && call[1] === "update-ref" && call.includes(STORE_REF)), false);
  } finally {
    await harness.cleanup();
  }
});

test("retention preserves the keepalive ref when discovery yields an empty live set", async () => {
  const harness = await createHarness({ settings: { rewind: { retention: { maxSnapshots: 10 } } } });

  try {
    await harness.writeRepoFile("tracked.txt", "keepalive\n");
    const snapshotCommit = await harness.captureSnapshot();
    await harness.updateStoreRef(snapshotCommit);

    await harness.invoke("session_start", {});

    assert.equal(await harness.revParseStore(), snapshotCommit);
    assert.equal(harness.execCalls.some((call) => call[0] === "git" && call[1] === "gc"), false);
  } finally {
    await harness.cleanup();
  }
});

test("ancestor-only retention discovery ignores unrelated session trees", async () => {
  const harness = await createHarness({
    settings: { rewind: { retention: { maxSnapshots: 10, scanMode: "ancestor-only" } } },
  });

  try {
    await harness.writeRepoFile("tracked.txt", "stale state\n");
    const staleCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("tracked.txt", "unrelated live state\n");
    const unrelatedLiveCommit = await harness.captureSnapshot();
    await harness.updateStoreRef(staleCommit);

    const unrelatedSession = harness.createSession({
      id: "session-unrelated",
      entries: [
        {
          type: "custom",
          id: "rewind-op-1",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "rewind-op",
          data: { v: 2, snapshots: [unrelatedLiveCommit], current: 0 },
        },
      ],
    });
    unrelatedSession.flush();

    await harness.invoke("session_start", {});
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(await harness.revParseStore(), staleCommit);
  } finally {
    await harness.cleanup();
  }
});

test("session shutdown waits for an in-flight startup retention sweep", async () => {
  const harness = await createHarness({
    settings: { rewind: { retention: { maxSnapshots: 10 } } },
    // The first check reconstructs the active rewind state; the second is the
    // detached startup sweep that a session replacement must join.
    pauseGitSubcommand: { name: "cat-file", occurrence: 2 },
  });
  let paused = false;

  try {
    await harness.writeRepoFile("tracked.txt", "live state\n");
    const liveCommit = await harness.captureSnapshot();
    harness.currentSession.replaceEntries([
      {
        type: "custom",
        id: "rewind-op-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [liveCommit], current: 0 },
      },
    ]);

    await harness.invoke("session_start", {});
    await harness.waitForPausedGitCall();
    paused = true;

    let shutdownComplete = false;
    const shutdown = harness.invoke("session_shutdown", {});
    void shutdown.then(() => {
      shutdownComplete = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownComplete, false);

    harness.resumePausedGitCall();
    paused = false;
    await shutdown;
    assert.equal(shutdownComplete, true);
  } finally {
    if (paused) {
      harness.resumePausedGitCall();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await harness.cleanup();
  }
});

test("retention rewrites the keepalive ref when a live snapshot exists", async () => {
  const harness = await createHarness({
    settings: { rewind: { retention: { maxSnapshots: 10 } } },
  });

  try {
    await harness.writeRepoFile("tracked.txt", "stale state\n");
    const staleCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("tracked.txt", "current live state\n");
    const liveCommit = await harness.captureSnapshot();
    assert.notEqual(liveCommit, staleCommit);
    await harness.updateStoreRef(staleCommit);

    harness.currentSession.replaceEntries([
      {
        type: "custom",
        id: "rewind-op-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [liveCommit], current: 0 },
      },
    ]);

    await harness.invoke("session_start", {});

    // Retention sweep runs in the background on startup; poll for completion
    const deadline = Date.now() + 3000;
    let storeHead: string | undefined;
    while (Date.now() < deadline) {
      storeHead = await harness.revParseStore();
      if (storeHead && await harness.isAncestor(liveCommit, storeHead)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(storeHead);
    assert.equal(await harness.isAncestor(liveCommit, storeHead!), true);
  } finally {
    await harness.cleanup();
  }
});

test("retention retries a ref rewrite that races with a new snapshot", async () => {
  const harness = await createHarness({
    settings: { rewind: { retention: { maxSnapshots: 10 } } },
    pauseGitSubcommand: { name: "update-ref", occurrence: 1 },
  });

  try {
    await harness.writeRepoFile("tracked.txt", "stale state\n");
    const staleCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("tracked.txt", "live state\n");
    const liveCommit = await harness.captureSnapshot();
    await harness.writeRepoFile("tracked.txt", "concurrent state\n");
    const concurrentCommit = await harness.captureSnapshot();
    await harness.updateStoreRef(staleCommit);

    harness.currentSession.replaceEntries([
      {
        type: "custom",
        id: "rewind-op-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [liveCommit], current: 0 },
      },
    ]);

    await harness.invoke("session_start", {});
    await harness.waitForPausedGitCall();
    await harness.updateStoreRef(concurrentCommit);
    harness.resumePausedGitCall();

    const deadline = Date.now() + 3000;
    let storeHead: string | undefined;
    while (Date.now() < deadline) {
      storeHead = await harness.revParseStore();
      if (storeHead
        && await harness.isAncestor(liveCommit, storeHead)
        && await harness.isAncestor(concurrentCommit, storeHead)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(storeHead);
    assert.equal(await harness.isAncestor(liveCommit, storeHead), true);
    assert.equal(await harness.isAncestor(concurrentCommit, storeHead), true);
    assert.equal(harness.notifications.some(({ message }) => message.includes("retention startup sweep failed")), false);
  } finally {
    await harness.cleanup();
  }
});

test("session_before_tree restores a local submodule gitlink commit", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    const fixture = await createSubmoduleFixture(harness.repoRoot);
    harness.currentSession.replaceEntries([
      {
        type: "custom_message",
        id: "target-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "target",
        content: "target",
        display: true,
      },
      {
        type: "custom",
        id: "current-op",
        parentId: "target-entry",
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [fixture.secondSuperCommit], current: 0 },
      },
      {
        type: "custom",
        id: "target-op",
        parentId: "current-op",
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [fixture.firstSuperCommit], bindings: [["target-entry", 0]] },
      },
    ]);

    await harness.invoke("session_start", {});
    harness.enqueueSelection("Restore files to that point");
    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "target-entry" } });

    assert.equal(result, undefined);
    assert.equal(await gitStdout(harness.repoRoot, ["-C", "nested", "rev-parse", "HEAD"]), fixture.firstCommit);
    assert.equal(harness.readRepoFile("nested/file.txt"), "submodule v1\n");
  } finally {
    await harness.cleanup();
  }
});

test("session_before_tree cancels before removing a submodule", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    const fixture = await createSubmoduleFixture(harness.repoRoot);
    harness.currentSession.replaceEntries([
      {
        type: "custom_message",
        id: "target-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "target",
        content: "target",
        display: true,
      },
      {
        type: "custom",
        id: "current-op",
        parentId: "target-entry",
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [fixture.secondSuperCommit], current: 0 },
      },
      {
        type: "custom",
        id: "target-op",
        parentId: "current-op",
        timestamp: new Date().toISOString(),
        customType: "rewind-op",
        data: { v: 2, snapshots: [fixture.beforeSubmoduleCommit], bindings: [["target-entry", 0]] },
      },
    ]);

    await harness.invoke("session_start", {});
    harness.enqueueSelection("Restore files to that point");
    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "target-entry" } });

    assert.deepEqual(result, { cancel: true });
    assert.equal(harness.readRepoFile("nested/file.txt"), "submodule v2\n");
    assert.ok(harness.notifications.some(({ message }) => message.includes("adding or removing submodules")));
  } finally {
    await harness.cleanup();
  }
});

test("turn_start warns when a submodule has dirty files", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    await createSubmoduleFixture(harness.repoRoot);
    await harness.writeRepoFile("nested/file.txt", "dirty nested state\n");

    await harness.invoke("session_start", {});
    await harness.invoke("turn_start", { turnIndex: 0 });

    assert.ok(harness.notifications.some(({ message }) => message.includes("dirty submodule: nested")));
  } finally {
    await harness.cleanup();
  }
});

test("turn_start warns when a dirty gitlink has no .gitmodules file", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    await createSubmoduleFixture(harness.repoRoot);
    await rm(path.join(harness.repoRoot, ".gitmodules"));
    await harness.writeRepoFile("nested/file.txt", "dirty nested state\n");

    assert.match(await gitStdout(harness.repoRoot, ["ls-files", "--stage", "nested"]), /^160000 /);
    await harness.invoke("session_start", {});
    await harness.invoke("turn_start", { turnIndex: 0 });

    assert.ok(harness.notifications.some(({ message }) => message.includes("dirty submodule: nested")));
  } finally {
    await harness.cleanup();
  }
});

test("session_before_tree restores exact file bytes when core.autocrlf is enabled", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });

  try {
    // Git for Windows defaults to core.autocrlf=true; set it on the repo so
    // this runs on every OS.
    await runGitChecked(harness.repoRoot, ["config", "core.autocrlf", "true"]);
    await harness.writeRepoFile("run.sh", "#!/bin/sh\necho before\n");
    await harness.writeRepoFile("windows.txt", "one\r\ntwo\r\n");
    await harness.writeRepoFile("untouched.sh", "#!/bin/sh\necho untouched\n");

    const assistantTimestamp = Date.now();
    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date(assistantTimestamp - 1000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Edit the scripts" }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: new Date(assistantTimestamp).toISOString(),
        message: {
          role: "assistant",
          timestamp: assistantTimestamp,
          content: [{ type: "text", text: "Edited the scripts" }],
        },
      },
    ]);

    await harness.invoke("session_start", {});
    await harness.invoke("before_agent_start", { prompt: "Edit the scripts" });
    await harness.invoke("turn_start", { turnIndex: 0 });
    await harness.writeRepoFile("run.sh", "#!/bin/sh\necho after\n");
    await harness.writeRepoFile("windows.txt", "one\r\ntwo\r\nthree\r\n");
    await harness.invoke("turn_end", {
      message: {
        role: "assistant",
        timestamp: assistantTimestamp,
        content: [{ type: "text", text: "Edited the scripts" }],
      },
    });
    await harness.invoke("agent_end", {});

    harness.enqueueSelection("Restore files to that point");
    const result = await harness.invoke("session_before_tree", { preparation: { targetId: "user-1" } });

    assert.equal(result, undefined);
    assert.equal(harness.readRepoFile("run.sh"), "#!/bin/sh\necho before\n");
    assert.equal(harness.readRepoFile("windows.txt"), "one\r\ntwo\r\n");
    assert.equal(harness.readRepoFile("untouched.sh"), "#!/bin/sh\necho untouched\n");
  } finally {
    await harness.cleanup();
  }
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function freshIndexTree(repoRoot: string): Promise<string> {
  const indexDir = await mkdtemp(path.join(os.tmpdir(), "rewind-fresh-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, "index") };
    // Checkpoints store exact bytes, so capture with autocrlf off like the extension.
    await execFileAsync("git", ["-c", "core.autocrlf=false", "add", "-A"], { cwd: repoRoot, env });
    return (await execFileAsync("git", ["write-tree"], { cwd: repoRoot, env })).stdout.trim();
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

async function renameViaTemp(from: string, to: string): Promise<void> {
  // Two steps so case-only renames also apply on case-insensitive filesystems.
  await rename(from, `${from}.tmp`);
  await rename(`${from}.tmp`, to);
}

function markerEntry(id: string): RewindEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "pi-custom-compaction.virtual-summary-marker",
    content: "Older context was summarized in the background.",
    display: true,
  };
}

async function checkpointTree(harness: Harness, entryId: string): Promise<string> {
  const checkpointHandler = harness.eventHandlers.get("rewind:checkpoint-entry");
  assert.ok(checkpointHandler, "missing rewind:checkpoint-entry handler");
  await checkpointHandler({ source: "pi-custom-compaction", entryId });

  for (const entry of harness.currentSession.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "rewind-op") continue;
    const data = entry.data as { snapshots: string[]; bindings?: [string, number][] };
    const binding = data.bindings?.find(([boundId]) => boundId === entryId);
    if (binding) return await gitStdout(harness.repoRoot, ["rev-parse", `${data.snapshots[binding[1]]}^{tree}`]);
  }
  assert.fail(`no checkpoint bound to ${entryId}`);
}

async function assertCheckpointsMatchFreshIndex(harness: Harness, steps: Array<[string, () => Promise<unknown>]>) {
  harness.currentSession.replaceEntries(steps.map((_, index) => markerEntry(`marker-${index}`)));
  await harness.invoke("session_start", {});
  for (const [index, [label, change]] of steps.entries()) {
    await change();
    assert.equal(await checkpointTree(harness, `marker-${index}`), await freshIndexTree(harness.repoRoot), label);
  }
}

test("checkpoints match a fresh index across edits, ignores and case-only renames", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });
  const repoPath = (relativePath: string) => path.join(harness.repoRoot, relativePath);

  try {
    await assertCheckpointsMatchFreshIndex(harness, [
      ["initial files", async () => {
        await harness.writeRepoFile("a.txt", "aaaa\n");
        await harness.writeRepoFile("gone.txt", "gone\n");
        await harness.writeRepoFile("dir/b.txt", "b\n");
      }],
      // Same size and written right after the previous capture.
      ["same-size edit", () => harness.writeRepoFile("a.txt", "bbbb\n")],
      ["add and delete", async () => {
        await harness.writeRepoFile("new/c.txt", "c\n");
        await rm(repoPath("gone.txt"));
      }],
      // dir/b.txt stays in a reused index, while a fresh index skips it.
      ["newly ignored file", () => harness.writeRepoFile(".gitignore", "dir/\n")],
      ["case-only file rename", () => renameViaTemp(repoPath("a.txt"), repoPath("A.txt"))],
      ["case-only directory rename", () => renameViaTemp(repoPath("new"), repoPath("New"))],
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("checkpoints re-apply changed attributes and line-ending config", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });
  const externalAttributes = path.join(path.dirname(harness.repoRoot), "attributes");

  try {
    await runGitChecked(harness.repoRoot, ["config", "core.autocrlf", "false"]);
    await harness.writeRepoFile("notes.txt", "one\r\ntwo\r\n");
    await harness.writeRepoFile("readme.md", "three\r\nfour\r\n");
    // Old mtimes keep git from rehashing these files as racily clean.
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(harness.repoRoot, "notes.txt"), past, past);
    await utimes(path.join(harness.repoRoot, "readme.md"), past, past);

    await assertCheckpointsMatchFreshIndex(harness, [
      ["CRLF files", async () => undefined],
      ["core.attributesFile set", () => runGitChecked(harness.repoRoot, ["config", "core.attributesFile", externalAttributes])],
      ["core.attributesFile edited", () => writeFile(externalAttributes, "*.md text eol=lf\n")],
      ["in-repo .gitattributes", () => harness.writeRepoFile(".gitattributes", "*.txt text eol=lf\n")],
      ["core.autocrlf", () => runGitChecked(harness.repoRoot, ["config", "core.autocrlf", "true"])],
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("checkpoints see same-size rewrites that restore mtime under weakened stat config", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });
  const notes = path.join(harness.repoRoot, "notes.txt");
  const past = new Date(Date.now() - 60_000);
  const rewriteKeepingStat = async (content: string) => {
    await writeFile(notes, content);
    await utimes(notes, past, past);
  };

  try {
    // Each setting alone lets a reused index keep stale content for such a rewrite.
    await runGitChecked(harness.repoRoot, ["config", "core.trustctime", "false"]);
    await runGitChecked(harness.repoRoot, ["config", "core.checkStat", "minimal"]);
    await runGitChecked(harness.repoRoot, ["config", "core.ignoreStat", "true"]);

    await assertCheckpointsMatchFreshIndex(harness, [
      ["initial file", () => rewriteKeepingStat("aaaa\n")],
      ["rewrite in the same second as the capture", () => rewriteKeepingStat("bbbb\n")],
      // Lets the next capture record stat data it can trust.
      ["unchanged in a later second", () => new Promise((resolve) => setTimeout(resolve, 1020 - (Date.now() % 1000)))],
      ["rewrite in a later second", () => rewriteKeepingStat("cccc\n")],
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("session_before_fork after resume reuses the exact commit only while files are unchanged", async () => {
  const harness = await createHarness({ settings: { rewind: { silentCheckpoints: true } } });
  const snapshotCount = async () => (await gitStdout(harness.repoRoot, ["log", "--format=%s", STORE_REF]))
    .split("\n")
    .filter((subject) => subject === "pi rewind snapshot").length;
  const forkPendingCommit = () => {
    const pending = harness.currentSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewind-fork-pending").at(-1);
    return (pending?.data as { current?: string } | undefined)?.current;
  };

  try {
    const timestamp = Date.now();
    const assistantMessage = { role: "assistant", timestamp, content: [{ type: "text", text: "Edited the notes" }] };
    harness.currentSession.replaceEntries([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date(timestamp - 1000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Edit the notes" }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: new Date(timestamp).toISOString(),
        message: assistantMessage,
      },
    ]);
    await harness.writeRepoFile("notes.txt", "aaaa\n");

    await harness.invoke("session_start", {});
    await harness.invoke("before_agent_start", { prompt: "Edit the notes" });
    await harness.invoke("turn_start", { turnIndex: 0 });
    await harness.writeRepoFile("notes.txt", "bbbb\n");
    await harness.invoke("turn_end", { message: assistantMessage });
    await harness.invoke("agent_end", {});
    const turn = harness.currentSession.getEntries().find((entry) => entry.type === "custom" && entry.customType === "rewind-turn");
    const turnCommit = (turn?.data as { snapshots: string[] } | undefined)?.snapshots.at(-1);
    assert.ok(turnCommit, "the turn recorded no snapshot");

    await harness.invoke("session_start", { reason: "resume" });
    const snapshotsAfterResume = await snapshotCount();

    harness.enqueueSelection("Conversation only (keep current files)");
    assert.equal(await harness.invoke("session_before_fork", { entryId: "user-1" }), undefined);
    assert.equal(forkPendingCommit(), turnCommit);
    assert.equal(await snapshotCount(), snapshotsAfterResume, "no duplicate snapshot commit");

    // Same size and written right after the previous capture.
    await harness.writeRepoFile("notes.txt", "cccc\n");
    harness.enqueueSelection("Conversation only (keep current files)");
    assert.equal(await harness.invoke("session_before_fork", { entryId: "user-1" }), undefined);
    const liveCommit = forkPendingCommit();
    assert.notEqual(liveCommit, turnCommit);
    assert.equal(await gitStdout(harness.repoRoot, ["rev-parse", `${liveCommit}^{tree}`]), await freshIndexTree(harness.repoRoot));
  } finally {
    await harness.cleanup();
  }
});
