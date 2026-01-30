#!/usr/bin/env node
/**
 * pi-rewind-hook trace CLI
 * Standalone tool for querying trace data outside pi sessions.
 *
 * Usage:
 *   node trace-cli.js blame <file>
 *   node trace-cli.js blame -L <start>,<end> <file>
 *   node trace-cli.js log
 *   node trace-cli.js show <trace-id>
 */
const { execSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

function getRepoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
}

function readTraces() {
  const root = getRepoRoot();
  const file = join(root, ".pi-trace", "traces.jsonl");
  let content;
  try {
    content = readFileSync(file, "utf-8").trim();
  } catch {
    return [];
  }
  if (!content) return [];
  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch { /* skip */ }
  }
  return records;
}

function readNote(sha) {
  try {
    const output = execSync(
      `git notes --ref=refs/notes/pi-trace show ${sha}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function cmdBlame(args) {
  let startLine, endLine, filePath;

  const lFlag = args.indexOf("-L");
  if (lFlag !== -1 && args[lFlag + 1]) {
    const range = args[lFlag + 1];
    const [s, e] = range.split(",");
    startLine = parseInt(s, 10);
    endLine = e ? parseInt(e, 10) : startLine;
    filePath = args.find((a, i) => i !== lFlag && i !== lFlag + 1 && !a.startsWith("-"));
  } else {
    filePath = args.find(a => !a.startsWith("-"));
  }

  if (!filePath) {
    console.error("Usage: trace-cli.js blame [-L start,end] <file>");
    process.exit(1);
  }

  const blameArgs = ["blame", "--line-porcelain"];
  if (startLine && endLine) blameArgs.push("-L", `${startLine},${endLine}`);
  blameArgs.push("HEAD", "--", filePath);

  let blameOutput;
  try {
    blameOutput = execSync(`git ${blameArgs.join(" ")}`, { encoding: "utf-8" });
  } catch {
    console.error(`Failed to blame ${filePath}`);
    process.exit(1);
  }

  const lines = blameOutput.split("\n");
  const entries = [];
  let sha = "", origLine = 0, finalLine = 0, filename = "";

  for (const line of lines) {
    if (/^[0-9a-f]{40} /.test(line)) {
      const parts = line.split(" ");
      sha = parts[0];
      origLine = parseInt(parts[1], 10);
      finalLine = parseInt(parts[2], 10);
    } else if (line.startsWith("filename ")) {
      filename = line.slice(9);
    } else if (line.startsWith("\t")) {
      entries.push({ sha, origLine, finalLine, filename, content: line.slice(1) });
    }
  }

  const noteCache = new Map();
  function getNote(commitSha) {
    if (noteCache.has(commitSha)) return noteCache.get(commitSha);
    const note = readNote(commitSha);
    noteCache.set(commitSha, note);
    return note;
  }

  console.log(`${filePath} -- prompt attribution`);
  console.log("─".repeat(60));

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const note = getNote(entry.sha);
    let label;

    if (!note || !note.resolved) {
      label = note ? "(unresolved)" : "(human)";
    } else {
      const fileRanges = note.resolved[entry.filename] || [];
      const match = fileRanges.find(r => entry.origLine >= r.start && entry.origLine <= r.end);
      if (!match) {
        label = "(untraced)";
      } else {
        const trace = (note.traces || []).find(t => t.id === match.trace_id);
        const msg = trace?.metadata?.["pi.user_message"] || "";
        const short = msg.length > 55 ? msg.slice(0, 55) + "..." : msg;
        label = `${entry.sha.slice(0, 7)}  "${short}"`;
      }
    }

    let j = i;
    while (j + 1 < entries.length) {
      const next = entries[j + 1];
      const nextNote = getNote(next.sha);
      let nextLabel;
      if (!nextNote || !nextNote.resolved) {
        nextLabel = nextNote ? "(unresolved)" : "(human)";
      } else {
        const fr = nextNote.resolved[next.filename] || [];
        const m = fr.find(r => next.origLine >= r.start && next.origLine <= r.end);
        if (!m) nextLabel = "(untraced)";
        else {
          const t = (nextNote.traces || []).find(t => t.id === m.trace_id);
          const msg = t?.metadata?.["pi.user_message"] || "";
          nextLabel = `${next.sha.slice(0, 7)}  "${msg.length > 55 ? msg.slice(0, 55) + "..." : msg}"`;
        }
      }
      if (nextLabel !== label) break;
      j++;
    }

    const startLn = entries[i].finalLine;
    const endLn = entries[j].finalLine;
    const range = startLn === endLn ? ` ${startLn}` : ` ${startLn}-${endLn}`;
    console.log(`${range.padEnd(10)} ${label}`);

    i = j + 1;
  }

  console.log("─".repeat(60));
}

function cmdLog() {
  const traces = readTraces();
  if (traces.length === 0) {
    console.log("No traces found.");
    return;
  }

  for (const t of traces) {
    const msg = (t.metadata?.["pi.user_message"] || "").slice(0, 70);
    const files = t.files?.length || 0;
    const ts = new Date(t.timestamp).toLocaleString();
    console.log(`${t.id.slice(0, 8)}  ${ts}  ${files} file(s)  "${msg}"`);
  }
}

function cmdShow(traceId) {
  const traces = readTraces();
  const trace = traces.find(t => t.id === traceId || t.id.startsWith(traceId));
  if (!trace) {
    console.error(`Trace not found: ${traceId}`);
    process.exit(1);
  }

  console.log(`Trace: ${trace.id}`);
  console.log(`Time:  ${trace.timestamp}`);
  console.log(`Prompt: "${trace.metadata?.["pi.user_message"] || ""}"`);
  console.log();

  const before = trace.metadata?.["pi.before_sha"];
  const after = trace.metadata?.["pi.after_sha"];
  if (before && after) {
    try {
      const diff = execSync(
        `git diff-tree -r -p ${before} ${after}`,
        { encoding: "utf-8" }
      );
      console.log(diff);
    } catch {
      console.log("(diff unavailable)");
    }
  }

  console.log("Files:");
  for (const f of trace.files || []) {
    console.log(`  ${f.path}`);
  }
}

const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case "blame":
    cmdBlame(rest);
    break;
  case "log":
    cmdLog();
    break;
  case "show":
    if (!rest[0]) { console.error("Usage: trace-cli.js show <trace-id>"); process.exit(1); }
    cmdShow(rest[0]);
    break;
  default:
    console.log("Usage: trace-cli.js <blame|log|show> [args]");
    console.log("  blame [-L start,end] <file>  Show per-line prompt attribution");
    console.log("  log                          List session traces");
    console.log("  show <trace-id>              Show trace details");
    process.exit(cmd ? 1 : 0);
}
