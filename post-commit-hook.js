#!/usr/bin/env node
/**
 * pi-rewind-hook post-commit hook
 * Reads .pi-trace/traces.jsonl, filters to traces touching committed files,
 * writes filtered raw traces to git notes (without per-line resolution).
 * tool_result in the extension overwrites with -f adding full resolution.
 */
const { execSync } = require("child_process");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

function main() {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    const traceFile = join(repoRoot, ".pi-trace", "traces.jsonl");

    let content;
    try {
      content = readFileSync(traceFile, "utf-8").trim();
    } catch {
      return;
    }
    if (!content) return;

    const traces = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        traces.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    if (traces.length === 0) return;

    const commitSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    const committedFilesRaw = execSync(
      "git diff-tree --root --no-commit-id --name-only -r -z HEAD",
      { encoding: "utf-8" }
    );
    const committedFiles = committedFilesRaw.split("\0").filter(Boolean);
    if (committedFiles.length === 0) return;

    const committedSet = new Set(committedFiles);
    const matchingTraces = traces.filter(t =>
      t.files && t.files.some(f => committedSet.has(f.path))
    );
    if (matchingTraces.length === 0) return;

    const note = JSON.stringify({ traces: matchingTraces });

    const tmpDir = mkdtempSync(join(tmpdir(), "pi-trace-hook-"));
    const tmpFile = join(tmpDir, "note.json");
    try {
      writeFileSync(tmpFile, note, "utf-8");
      execSync(
        `git notes --ref=refs/notes/pi-trace add -f -F "${tmpFile}" ${commitSha}`,
        { encoding: "utf-8" }
      );
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  } catch {
    // Silent failure - hook must not block commits
  }
}

main();
