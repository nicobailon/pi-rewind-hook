import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface TraceRange {
  start_line: number;
  end_line: number;
}

export interface TraceContributor {
  type: "ai" | "human";
  model_id?: string;
}

export interface TraceConversation {
  contributor: TraceContributor;
  ranges: TraceRange[];
}

export interface TraceFile {
  path: string;
  conversations: TraceConversation[];
}

export interface TraceTool {
  name: string;
  version: string;
}

export interface TraceVcs {
  type: "git";
  revision: string;
}

export interface TraceRecord {
  version: "1.0";
  id: string;
  timestamp: string;
  vcs?: TraceVcs;
  tool?: TraceTool;
  files: TraceFile[];
  metadata?: Record<string, unknown>;
}

export interface ResolvedRange {
  start: number;
  end: number;
  trace_id: string;
}

export interface TraceNote {
  traces: TraceRecord[];
  resolved?: Record<string, ResolvedRange[]>;
}

const TRACE_DIR = ".pi-trace";
const TRACE_FILE = "traces.jsonl";
const GITIGNORE_CONTENT = "*\n";
const MAX_TRACES = 100;

export function ensureTraceDir(repoRoot: string): void {
  const dir = join(repoRoot, TRACE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, GITIGNORE_CONTENT, "utf-8");
  }
}

export function tracePath(repoRoot: string): string {
  return join(repoRoot, TRACE_DIR, TRACE_FILE);
}

export function readTraces(repoRoot: string): TraceRecord[] {
  const file = tracePath(repoRoot);
  if (!existsSync(file)) return [];

  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];

  const records: TraceRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      console.error(`pi-rewind-hook: skipping malformed trace line: ${line.slice(0, 80)}...`);
    }
  }
  return records;
}

export function appendTrace(repoRoot: string, record: TraceRecord): void {
  const file = tracePath(repoRoot);
  const records = readTraces(repoRoot);

  if (records.length >= MAX_TRACES) {
    const toKeep = records.slice(records.length - MAX_TRACES + 1);
    toKeep.push(record);
    writeFileSync(file, toKeep.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  } else {
    appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  }
}

export function removeTraces(repoRoot: string, idsToRemove: Set<string>): void {
  const records = readTraces(repoRoot);
  const remaining = records.filter(r => !idsToRemove.has(r.id));
  const file = tracePath(repoRoot);
  if (remaining.length === 0) {
    writeFileSync(file, "", "utf-8");
  } else {
    writeFileSync(file, remaining.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  }
}

const TRACE_REF_PREFIX = "refs/pi-trace-shas/";

export function collectTraceShas(traces: TraceRecord[]): Set<string> {
  const shas = new Set<string>();
  for (const t of traces) {
    const meta = t.metadata;
    if (meta) {
      if (typeof meta["pi.before_sha"] === "string") shas.add(meta["pi.before_sha"] as string);
      if (typeof meta["pi.after_sha"] === "string") shas.add(meta["pi.after_sha"] as string);
    }
  }
  return shas;
}

export async function cleanOrphanedTraceRefs(
  exec: ExtensionAPI["exec"],
  neededShas: Set<string>,
): Promise<void> {
  const result = await exec("git", [
    "for-each-ref", "--format=%(refname)", TRACE_REF_PREFIX,
  ]);
  const existingRefs = result.stdout.trim().split("\n").filter(Boolean);

  for (const ref of existingRefs) {
    const sha = ref.replace(TRACE_REF_PREFIX, "");
    if (!neededShas.has(sha)) {
      await exec("git", ["update-ref", "-d", ref]);
    }
  }
}
