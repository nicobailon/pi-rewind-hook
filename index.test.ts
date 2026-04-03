import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import rewindExtension from "./index.ts";

const execFileAsync = promisify(execFile);
const STORE_REF = "refs/pi-rewind/store";

type RewindEntry = Record<string, unknown>;
type EventHandler = (event: any, ctx: any) => Promise<any> | any;

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
  } catch (error: any) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
      code: error.code ?? 1,
    };
  }
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

async function createHarness(options: {
  settings?: Record<string, unknown>;
  failGitSubcommands?: string[];
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

  await runGitChecked(repoRoot, ["init"]);
  await runGitChecked(repoRoot, ["config", "user.name", "Rewind Test"]);
  await runGitChecked(repoRoot, ["config", "user.email", "rewind@example.com"]);

  const handlers = new Map<string, EventHandler>();
  const eventHandlers = new Map<string, (data: any) => void>();
  const execCalls: string[][] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const pendingSelections: string[] = [];

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

      const gitSubcommand = args[0] ?? "";
      if (options.failGitSubcommands?.includes(gitSubcommand)) {
        return {
          stdout: "",
          stderr: `forced git failure for ${gitSubcommand}`,
          code: 1,
        };
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
      on: (eventName: string, handler: (data: any) => void) => {
        eventHandlers.set(eventName, handler);
      },
    },
  } as any;

  rewindExtension(api);

  function createContext(sessionManager: SessionManagerStub, hasUI = true): any {
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
    async invoke(eventName: string, event: any, sessionManager = activeSession, hasUI = true) {
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
    async cleanup() {
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
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

    const childSession = harness.createSession({
      id: "session-2",
      parentSession: harness.currentSession.getSessionFile(),
    });
    await harness.invoke("session_fork", {}, childSession);

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

