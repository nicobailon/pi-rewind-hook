import type { DiffHunk } from "./diff";
import type { TraceRecord, ResolvedRange, TraceNote } from "./trace";
import { unquoteGitPath } from "./diff";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type AttributionEntry = string | null;

export interface BlameResult {
  lineNumber: number;
  content?: string;
  attribution: "human" | "untraced" | "unresolved" | "pre-session" | {
    traceId: string;
    userMessage: string;
    assistantMessage?: string;
    modelId?: string;
    timestamp: string;
    commitSha?: string;
    sessionId?: string;
    entryId?: string;
  };
}

type ComputeLineDiff = (beforeSha: string, afterSha: string, filePath: string) => Promise<DiffHunk[]>;

function applyDiffToAttribution(
  attribution: AttributionEntry[],
  hunks: DiffHunk[],
  traceId: string | null,
): AttributionEntry[] {
  const result: AttributionEntry[] = [];
  let srcIdx = 0;

  for (const hunk of hunks) {
    if (hunk.type === "equal") {
      for (let i = 0; i < hunk.lines.length; i++) {
        result.push(srcIdx < attribution.length ? attribution[srcIdx] : null);
        srcIdx++;
      }
    } else if (hunk.type === "delete") {
      srcIdx += hunk.lines.length;
    } else if (hunk.type === "add") {
      for (let i = 0; i < hunk.lines.length; i++) {
        result.push(traceId);
      }
    }
  }

  return result;
}

export async function buildAttribution(
  traces: TraceRecord[],
  filePath: string,
  computeLineDiff: ComputeLineDiff,
  commitSha?: string,
): Promise<AttributionEntry[]> {
  if (traces.length === 0) return [];

  const getBeforeSha = (t: TraceRecord) => t.metadata?.["pi.before_sha"] as string;
  const getAfterSha = (t: TraceRecord) => t.metadata?.["pi.after_sha"] as string;

  if (traces.length === 1) {
    const t = traces[0];
    const hunks = await computeLineDiff(getBeforeSha(t), getAfterSha(t), filePath);
    let attribution = applyDiffToAttribution([], hunks, t.id);

    if (commitSha) {
      const gapHunks = await computeLineDiff(getAfterSha(t), commitSha, filePath);
      if (gapHunks.length > 0) {
        attribution = applyDiffToAttribution(attribution, gapHunks, null);
      }
    }
    return attribution;
  }

  let attribution: AttributionEntry[] = [];

  for (let i = 0; i < traces.length; i++) {
    const t = traces[i];

    if (i > 0) {
      const prevAfter = getAfterSha(traces[i - 1]);
      const curBefore = getBeforeSha(t);
      if (prevAfter !== curBefore) {
        const gapHunks = await computeLineDiff(prevAfter, curBefore, filePath);
        if (gapHunks.length > 0) {
          attribution = applyDiffToAttribution(attribution, gapHunks, null);
        }
      }
    }

    const traceHunks = await computeLineDiff(getBeforeSha(t), getAfterSha(t), filePath);
    attribution = applyDiffToAttribution(attribution, traceHunks, t.id);
  }

  if (commitSha) {
    const lastAfter = getAfterSha(traces[traces.length - 1]);
    const gapHunks = await computeLineDiff(lastAfter, commitSha, filePath);
    if (gapHunks.length > 0) {
      attribution = applyDiffToAttribution(attribution, gapHunks, null);
    }
  }

  return attribution;
}

export async function resolveAttributionForCommit(
  traces: TraceRecord[],
  committedFiles: string[],
  commitSha: string,
  computeLineDiff: ComputeLineDiff,
): Promise<{ resolved: Record<string, ResolvedRange[]>; traceIds: Set<string> }> {
  const resolved: Record<string, ResolvedRange[]> = {};
  const usedTraceIds = new Set<string>();

  for (const file of committedFiles) {
    const touchingTraces = traces.filter(t =>
      t.files.some(f => f.path === file)
    );
    if (touchingTraces.length === 0) continue;

    const attribution = await buildAttribution(touchingTraces, file, computeLineDiff, commitSha);

    const fileRanges: ResolvedRange[] = [];
    let i = 0;
    while (i < attribution.length) {
      const traceId = attribution[i];
      if (traceId === null) { i++; continue; }

      const start = i + 1;
      while (i < attribution.length && attribution[i] === traceId) i++;
      const end = i;

      fileRanges.push({ start, end, trace_id: traceId });
      usedTraceIds.add(traceId);
    }

    if (fileRanges.length > 0) {
      resolved[file] = fileRanges;
    }
  }

  return { resolved, traceIds: usedTraceIds };
}

export async function blameCommitted(
  exec: ExtensionAPI["exec"],
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<BlameResult[]> {
  const blameArgs = ["blame", "--line-porcelain"];
  if (startLine !== undefined && endLine !== undefined) {
    blameArgs.push("-L", `${startLine},${endLine}`);
  } else if (startLine !== undefined) {
    blameArgs.push("-L", `${startLine},${startLine}`);
  }
  blameArgs.push("HEAD", "--", filePath);

  const result = await exec("git", blameArgs);
  if (result.code !== 0) return [];

  const lines = result.stdout.split("\n");
  const entries: Array<{
    commitSha: string;
    origLine: number;
    finalLine: number;
    filename: string;
    content: string;
  }> = [];

  let currentSha = "";
  let currentOrigLine = 0;
  let currentFinalLine = 0;
  let currentFilename = "";
  let currentContent = "";

  for (const line of lines) {
    if (/^[0-9a-f]{40} /.test(line)) {
      const parts = line.split(" ");
      currentSha = parts[0];
      currentOrigLine = parseInt(parts[1], 10);
      currentFinalLine = parseInt(parts[2], 10);
    } else if (line.startsWith("filename ")) {
      currentFilename = unquoteGitPath(line.slice(9));
    } else if (line.startsWith("\t")) {
      currentContent = line.slice(1);
      entries.push({
        commitSha: currentSha,
        origLine: currentOrigLine,
        finalLine: currentFinalLine,
        filename: currentFilename,
        content: currentContent,
      });
    }
  }

  const noteCache = new Map<string, TraceNote | null>();
  async function getNote(sha: string): Promise<TraceNote | null> {
    if (noteCache.has(sha)) return noteCache.get(sha)!;
    try {
      const noteResult = await exec("git", [
        "notes", "--ref=refs/notes/pi-trace", "show", sha,
      ]);
      if (noteResult.code !== 0) {
        noteCache.set(sha, null);
        return null;
      }
      const note = JSON.parse(noteResult.stdout) as TraceNote;
      noteCache.set(sha, note);
      return note;
    } catch {
      console.error(`pi-rewind-hook: malformed git note on ${sha}`);
      noteCache.set(sha, null);
      return null;
    }
  }

  const results: BlameResult[] = [];

  for (const entry of entries) {
    const note = await getNote(entry.commitSha);

    if (!note) {
      results.push({
        lineNumber: entry.finalLine,
        content: entry.content,
        attribution: "human",
      });
      continue;
    }

    if (!note.resolved) {
      results.push({
        lineNumber: entry.finalLine,
        content: entry.content,
        attribution: "unresolved",
      });
      continue;
    }

    const fileRanges = note.resolved[entry.filename];
    if (!fileRanges) {
      results.push({
        lineNumber: entry.finalLine,
        content: entry.content,
        attribution: "untraced",
      });
      continue;
    }

    const matchingRange = fileRanges.find(
      r => entry.origLine >= r.start && entry.origLine <= r.end
    );

    if (!matchingRange) {
      results.push({
        lineNumber: entry.finalLine,
        content: entry.content,
        attribution: "untraced",
      });
      continue;
    }

    const trace = note.traces.find(t => t.id === matchingRange.trace_id);
    if (!trace) {
      results.push({
        lineNumber: entry.finalLine,
        content: entry.content,
        attribution: "untraced",
      });
      continue;
    }

    results.push({
      lineNumber: entry.finalLine,
      content: entry.content,
      attribution: {
        traceId: trace.id,
        userMessage: (trace.metadata?.["pi.user_message"] as string) || "",
        assistantMessage: trace.metadata?.["pi.assistant_message"] as string | undefined,
        modelId: trace.files?.[0]?.conversations?.[0]?.contributor?.model_id,
        timestamp: trace.timestamp,
        commitSha: entry.commitSha,
        sessionId: trace.metadata?.["pi.session_id"] as string | undefined,
        entryId: trace.metadata?.["pi.entry_id"] as string | undefined,
      },
    });
  }

  return results;
}

export async function blameUncommitted(
  filePath: string,
  readTracesFn: () => TraceRecord[],
  computeLineDiff: ComputeLineDiff,
  captureWorktree: () => Promise<string>,
  startLine?: number,
  endLine?: number,
): Promise<BlameResult[]> {
  const allTraces = readTracesFn();
  const touchingTraces = allTraces
    .filter(t => t.files.some(f => f.path === filePath))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (touchingTraces.length === 0) {
    return startLine && endLine
      ? Array.from({ length: endLine - startLine + 1 }, (_, i) => ({
          lineNumber: startLine + i,
          attribution: "pre-session" as const,
        }))
      : [];
  }

  const attribution = await buildAttribution(touchingTraces, filePath, computeLineDiff);

  const lastAfterSha = touchingTraces[touchingTraces.length - 1].metadata?.["pi.after_sha"] as string;
  const currentSha = await captureWorktree();

  let finalAttribution = attribution;
  if (lastAfterSha !== currentSha) {
    const gapHunks = await computeLineDiff(lastAfterSha, currentSha, filePath);
    if (gapHunks.length > 0) {
      finalAttribution = applyDiffToAttribution(attribution, gapHunks, null);
    }
  }

  const start = startLine ? startLine - 1 : 0;
  const end = endLine ? endLine : finalAttribution.length;
  const slice = finalAttribution.slice(start, end);

  const traceMap = new Map(touchingTraces.map(t => [t.id, t]));

  return slice.map((traceId, i) => {
    const lineNum = (startLine || 1) + i;
    if (traceId === null) {
      return { lineNumber: lineNum, attribution: "pre-session" as const };
    }
    const trace = traceMap.get(traceId);
    if (!trace) {
      return { lineNumber: lineNum, attribution: "pre-session" as const };
    }
    return {
      lineNumber: lineNum,
      attribution: {
        traceId: trace.id,
        userMessage: (trace.metadata?.["pi.user_message"] as string) || "",
        assistantMessage: trace.metadata?.["pi.assistant_message"] as string | undefined,
        modelId: trace.files?.[0]?.conversations?.[0]?.contributor?.model_id,
        timestamp: trace.timestamp,
        sessionId: trace.metadata?.["pi.session_id"] as string | undefined,
        entryId: trace.metadata?.["pi.entry_id"] as string | undefined,
      },
    };
  });
}
