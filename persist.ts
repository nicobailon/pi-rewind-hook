import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  readTraces,
  removeTraces,
  appendTrace,
  collectTraceShas,
  cleanOrphanedTraceRefs,
  type TraceRecord,
  type TraceNote,
} from "./trace";
import { createDiffEngine } from "./diff";
import { resolveAttributionForCommit } from "./blame";

export function looksLikeGitCommit(command: string): boolean {
  const trimmed = command.trim();
  if (!/\bgit\s+commit\b/.test(trimmed)) return false;
  if (/\bgit\s+commit-tree\b/.test(trimmed)) return false;
  if (/\bgit\s+commit-graph\b/.test(trimmed)) return false;
  if (/--dry-run/.test(trimmed)) return false;
  if (/--amend/.test(trimmed)) return false;
  return true;
}

interface CommitPersistenceArgs {
  exec: ExtensionAPI["exec"];
  repoRoot: string;
  traceBeforeSha: string | null;
  captureWorktree: () => Promise<string>;
  diffCache: Map<string, Map<string, import("./diff").DiffHunk[]>>;
  sessionId: string;
  cachedModel: string | null;
  findUserMessageEntry: () => { id: string } | null;
  userMessage?: string;
}

export async function handleCommitDetected(args: CommitPersistenceArgs): Promise<{
  newTraceBeforeSha: string | null;
}> {
  const {
    exec, repoRoot, traceBeforeSha, captureWorktree,
    diffCache, sessionId, cachedModel, findUserMessageEntry, userMessage: providedUserMessage,
  } = args;

  let updatedBeforeSha = traceBeforeSha;

  if (traceBeforeSha) {
    const midLoopSha = await captureWorktree();
    const diffResult = await exec("git", [
      "diff-tree", "--numstat", "-r", "-z", traceBeforeSha, midLoopSha,
    ]);
    const rawEntries = diffResult.stdout.split("\0").filter(Boolean);

    if (rawEntries.length > 0) {
      const files: TraceRecord["files"] = [];
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

      if (files.length > 0) {
        let headSha = "";
        try {
          const headResult = await exec("git", ["rev-parse", "HEAD"]);
          headSha = headResult.stdout.trim();
        } catch { /* empty repo */ }

        const userMessage = providedUserMessage || "";

        const pkgVersion = (() => {
          try {
            const pkgPath = new URL("./package.json", import.meta.url);
            return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
          } catch { return "0.0.0"; }
        })();

        const userEntry = findUserMessageEntry();
        const record: TraceRecord = {
          version: "1.0",
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ...(headSha ? { vcs: { type: "git", revision: headSha } } : {}),
          tool: { name: "pi-rewind-hook", version: pkgVersion },
          files,
          metadata: {
            "pi.session_id": sessionId,
            "pi.entry_id": userEntry?.id || "",
            "pi.before_sha": traceBeforeSha,
            "pi.after_sha": midLoopSha,
            "pi.user_message": userMessage,
            "pi.additions": additions,
            "pi.deletions": deletions,
          },
        };

        appendTrace(repoRoot, record);

        await exec("git", ["update-ref", `refs/pi-trace-shas/${traceBeforeSha}`, traceBeforeSha]);
        await exec("git", ["update-ref", `refs/pi-trace-shas/${midLoopSha}`, midLoopSha]);
      }
    }

    updatedBeforeSha = midLoopSha;
  }

  const traces = readTraces(repoRoot);
  if (traces.length === 0) return { newTraceBeforeSha: updatedBeforeSha };

  const headResult = await exec("git", ["rev-parse", "HEAD"]);
  const commitSha = headResult.stdout.trim();

  const committedFilesResult = await exec("git", [
    "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "HEAD",
  ]);
  const committedFiles = committedFilesResult.stdout.split("\0").filter(Boolean);
  if (committedFiles.length === 0) return { newTraceBeforeSha: updatedBeforeSha };

  const matchingTraces = traces.filter(t =>
    t.files.some(f => committedFiles.includes(f.path))
  );
  if (matchingTraces.length === 0) return { newTraceBeforeSha: updatedBeforeSha };

  const computeLineDiff = createDiffEngine(exec, diffCache);
  const { resolved, traceIds: usedTraceIds } = await resolveAttributionForCommit(
    matchingTraces, committedFiles, commitSha, computeLineDiff,
  );

  const finalizedTraces: TraceRecord[] = matchingTraces
    .filter(t => usedTraceIds.has(t.id))
    .map(t => {
      const copy: TraceRecord = JSON.parse(JSON.stringify(t));
      copy.files = copy.files.filter(f => committedFiles.includes(f.path));
      for (const file of copy.files) {
        const fileRanges = resolved[file.path];
        if (fileRanges && file.conversations.length > 0) {
          const traceRanges = fileRanges
            .filter(r => r.trace_id === t.id)
            .map(r => ({ start_line: r.start, end_line: r.end }));
          file.conversations[0].ranges = traceRanges;
        }
      }
      return copy;
    });

  const note: TraceNote = { traces: finalizedTraces, resolved };

  const tmpDir = await mkdtemp(join(tmpdir(), "pi-trace-note-"));
  try {
    const tmpFile = join(tmpDir, "note.json");
    await writeFile(tmpFile, JSON.stringify(note), "utf-8");
    await exec("git", [
      "notes", "--ref=refs/notes/pi-trace", "add", "-f", "-F", tmpFile, commitSha,
    ]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const allFilePaths = new Set<string>();
  for (const t of traces) {
    for (const f of t.files) allFilePaths.add(f.path);
  }

  const statusResult = await exec("git", [
    "status", "--porcelain", "-z", "--", ...allFilePaths,
  ]);
  const dirtyPaths = new Set<string>();
  const statusEntries = statusResult.stdout.split("\0").filter(Boolean);
  for (const entry of statusEntries) {
    if (entry.length >= 3 && entry[2] === " ") {
      dirtyPaths.add(entry.slice(3));
    }
  }

  const toRemove = new Set<string>();
  for (const t of traces) {
    const allClean = t.files.every(f => !dirtyPaths.has(f.path));
    if (allClean) toRemove.add(t.id);
  }

  if (toRemove.size > 0) {
    removeTraces(repoRoot, toRemove);
  }

  const remainingTraces = readTraces(repoRoot);
  await cleanOrphanedTraceRefs(exec, collectTraceShas(remainingTraces));

  return { newTraceBeforeSha: updatedBeforeSha };
}
