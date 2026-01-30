import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type HunkType = "equal" | "add" | "delete";

export interface DiffHunk {
  type: HunkType;
  lines: string[];
}

export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      i++;
      if (i >= inner.length) break;
      const ch = inner[i];
      if (ch === "\\") { bytes.push(0x5c); i++; }
      else if (ch === "t") { bytes.push(0x09); i++; }
      else if (ch === "n") { bytes.push(0x0a); i++; }
      else if (ch === "r") { bytes.push(0x0d); i++; }
      else if (ch === '"') { bytes.push(0x22); i++; }
      else if (ch >= "0" && ch <= "7") {
        let octal = ch;
        if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
          octal += inner[++i];
          if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
            octal += inner[++i];
          }
        }
        bytes.push(parseInt(octal, 8));
        i++;
      } else {
        bytes.push(inner.charCodeAt(i));
        i++;
      }
    } else {
      const code = inner.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else {
        const encoded = new TextEncoder().encode(inner[i]);
        for (const b of encoded) bytes.push(b);
      }
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function extractPath(headerLine: string, prefix: "a/" | "b/"): string | null {
  const raw = headerLine.trimEnd();
  if (raw === "/dev/null") return null;
  if (raw.startsWith('"')) {
    const unquoted = unquoteGitPath(raw);
    return unquoted.startsWith(prefix) ? unquoted.slice(2) : unquoted;
  }
  return raw.startsWith(prefix) ? raw.slice(2) : raw;
}

export function parseUnifiedDiff(output: string): Map<string, DiffHunk[]> {
  const result = new Map<string, DiffHunk[]>();
  const fileSections = output.split(/^diff --git /m);

  for (const section of fileSections) {
    if (!section.trim()) continue;

    let minusPath: string | null = null;
    let plusPath: string | null = null;
    const lines = section.split("\n");

    for (const line of lines) {
      if (line.startsWith("--- ")) {
        minusPath = extractPath(line.slice(4), "a/");
      } else if (line.startsWith("+++ ")) {
        plusPath = extractPath(line.slice(4), "b/");
        break;
      }
    }

    const filePath = plusPath ?? minusPath;
    if (!filePath) continue;

    const hunks: DiffHunk[] = [];
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;

      if (line.startsWith("+")) {
        const prev = hunks[hunks.length - 1];
        if (prev && prev.type === "add") {
          prev.lines.push(line.slice(1));
        } else {
          hunks.push({ type: "add", lines: [line.slice(1)] });
        }
      } else if (line.startsWith("-")) {
        const prev = hunks[hunks.length - 1];
        if (prev && prev.type === "delete") {
          prev.lines.push(line.slice(1));
        } else {
          hunks.push({ type: "delete", lines: [line.slice(1)] });
        }
      } else if (line.startsWith(" ")) {
        const prev = hunks[hunks.length - 1];
        if (prev && prev.type === "equal") {
          prev.lines.push(line.slice(1));
        } else {
          hunks.push({ type: "equal", lines: [line.slice(1)] });
        }
      } else if (line === "\\ No newline at end of file") {
        continue;
      }
    }

    result.set(filePath, hunks);
  }

  return result;
}

export function createDiffEngine(
  exec: ExtensionAPI["exec"],
  cache: Map<string, Map<string, DiffHunk[]>>,
) {
  async function fetchPairDiffs(beforeSha: string, afterSha: string): Promise<Map<string, DiffHunk[]>> {
    const cacheKey = `${beforeSha}:${afterSha}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await exec("git", [
      "diff-tree", "-r", "-p", "-U99999", beforeSha, afterSha,
    ]);

    const parsed = parseUnifiedDiff(result.stdout);
    cache.set(cacheKey, parsed);
    return parsed;
  }

  return async function computeLineDiff(
    beforeSha: string,
    afterSha: string,
    filePath: string,
  ): Promise<DiffHunk[]> {
    if (beforeSha === afterSha) return [];
    const pairDiffs = await fetchPairDiffs(beforeSha, afterSha);
    return pairDiffs.get(filePath) || [];
  };
}
