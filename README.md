![pi-rewind](banner.png)

# Rewind Extension

A Pi agent extension that enables rewinding file changes and tracking prompt-to-code attribution during coding sessions. Creates automatic checkpoints using git refs for file restoration, and traces which user prompts caused which code changes with per-line granularity.

> **Alpha** — Checkpoints and file restoration are stable. **Prompt-to-code attribution** (`/trace`, blame, git notes) is new and not thoroughly tested yet. Expect rough edges. Please [open an issue](https://github.com/nicobailon/pi-rewind-hook/issues) if you encounter problems or have feedback.

## Screenshots

![Selecting a message to branch from](rewind1.png)

![Choosing a restore option](rewind2.png)

## Requirements

- Pi agent v0.35.0+ (unified extensions system)
- Node.js (for installation)
- Git repository (checkpoints are stored as git refs)

## Installation

```bash
pi install npm:pi-rewind-hook
```

This will:
1. Create `~/.pi/agent/extensions/rewind/`
2. Download the extension files (including `package.json` for auto-discovery)
3. Migrate any existing hooks config to extensions (if upgrading from v1.2.0)
4. Clean up old `hooks/rewind` directory (if present)

### Alternative Installation

Using curl:

```bash
curl -fsSL https://raw.githubusercontent.com/nicobailon/pi-rewind-hook/main/install.js | node
```

Or clone the repo and configure manually:

```bash
git clone https://github.com/nicobailon/pi-rewind-hook ~/.pi/agent/extensions/rewind
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/.pi/agent/extensions/rewind/index.ts"]
}
```

### Platform Notes

**Windows:** The `npx` command works in PowerShell, Command Prompt, and WSL. If you prefer curl on Windows without WSL:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nicobailon/pi-rewind-hook/main/install.js" -OutFile install.js; node install.js; Remove-Item install.js
```

### Upgrading from v1.2.0

If you're upgrading from pi-rewind-hook v1.2.0 (which used the hooks system), simply run `npx pi-rewind-hook` again. The installer will:
- Move the extension from `hooks/rewind` to `extensions/rewind`
- Migrate your settings.json from `hooks` to `extensions`
- Clean up the old hooks directory

**Note:** v1.3.0+ requires pi v0.35.0 or later. If you're on an older version of pi, stay on pi-rewind-hook v1.2.0.

## Configuration

You can configure the extension by adding settings to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/.pi/agent/extensions/rewind/index.ts"],
  "rewind": {
    "silentCheckpoints": true,
    "traceHook": false
  }
}
```

### Settings

- **`rewind.silentCheckpoints`** (boolean, default: `false`): When set to `true`, disables checkpoint status messages. The footer checkpoint count (`◆ X checkpoints`) and checkpoint saved notifications (`Checkpoint X saved`) will not be displayed.
- **`rewind.traceHook`** (boolean, default: `false`): When set to `true`, installs a git `post-commit` hook that writes trace data to git notes. This enables prompt attribution for commits made outside pi's agent loop (e.g., manual `git commit` in another terminal while pi is running). The hook reads existing trace data from `.pi-trace/traces.jsonl`, so it only works if pi has written traces during the session. The hook chains with any existing post-commit hook.

## Prompt-to-Code Attribution

The extension tracks which user prompts caused which code changes, providing per-line attribution for both committed and uncommitted files.

### How Tracing Works

Every time the agent finishes processing your message, the extension captures a before/after snapshot of the working tree and records which files changed. These trace records are stored in `.pi-trace/traces.jsonl` (gitignored) during the session.

When the agent runs `git commit`, the extension resolves per-line attribution by composing diffs across all traces that touched the committed files. The result is baked into a git note on the commit (`refs/notes/pi-trace`) containing both the trace records and resolved line ranges.

### How Manual Edits Are Handled

The system doesn't detect manual edits directly. It works by exclusion: each trace captures a precise before/after snapshot window, and anything that changed outside those windows gets null attribution.

Say you send prompt A, then manually edit a file, then send prompt B. The extension captures snapshots before and after each agent response. Your manual edit falls in the gap between trace A's "after" and trace B's "before." When attribution is resolved, the forward diff algorithm encounters that gap, sees the change, and assigns it null — meaning no prompt produced it.

At blame time, lines with null attribution show as `(untraced)` for committed files or `(pre-session)` for uncommitted files. Lines from commits made entirely outside pi show as `(human)`.

### Blame Labels

| Label | Meaning |
|-------|---------|
| **prompt info** | AI-authored — a resolved range in the git note links this line to a specific prompt |
| `(human)` | The commit has no pi-trace note — made entirely outside any pi session |
| `(unresolved)` | The commit has a note but no per-line resolution (post-commit hook only, extension hasn't processed it yet) |
| `(untraced)` | The commit has resolved ranges, but none cover this line — manual edits within a commit that also has AI changes |
| `(pre-session)` | Uncommitted blame only — the line isn't covered by any trace in the current session |

### /trace Command

Browse traces and view per-line blame interactively:

```
/trace                              # Open turn browser — select a prompt, then a file, to view the diff
/trace blame src/auth.ts            # Per-line attribution for the whole file
/trace blame src/auth.ts 10-25      # Per-line attribution for lines 10-25
```

The blame view auto-detects whether the file is committed or has uncommitted changes. Committed files use git blame with note lookups; uncommitted files use in-session trace data.

### Standalone CLI

Query trace data outside pi sessions:

```bash
node ~/.pi/agent/extensions/rewind/trace-cli.js blame src/auth.ts
node ~/.pi/agent/extensions/rewind/trace-cli.js blame -L 10,25 src/auth.ts
node ~/.pi/agent/extensions/rewind/trace-cli.js log
node ~/.pi/agent/extensions/rewind/trace-cli.js show <trace-id>
```

### Viewing Trace Notes

```bash
# Show the trace note on a commit
git notes --ref=refs/notes/pi-trace show HEAD

# List all trace SHA refs
git for-each-ref refs/pi-trace-shas/
```

## How It Works

### Checkpoints

The extension creates git refs at two points:

1. **Session start** - When pi starts, creates a "resume checkpoint" of the current file state
2. **Each turn** - Before the agent processes each message, creates a checkpoint

Checkpoints are stored as git refs under `refs/pi-checkpoints/` and are scoped per-session (so multiple pi sessions in the same repo don't interfere with each other). Each session maintains its own 100-checkpoint limit.

### Rewinding

To rewind via `/branch`:

1. Type `/branch` in pi
2. Select a message to branch from
3. Choose a restore option

To rewind via tree navigation:

1. Press `Tab` to open the session tree
2. Navigate to a different node
3. Choose a restore option

**For messages from the current session:**

| Option | Files | Conversation |
|--------|-------|--------------|
| **Restore all (files + conversation)** | Restored | Reset to that point |
| **Conversation only (keep current files)** | Unchanged | Reset to that point |
| **Code only (restore files, keep conversation)** | Restored | Unchanged |
| **Undo last file rewind** | Restored to before last rewind | Unchanged |

**For messages from before the current session (uses resume checkpoint):**

| Option | Files | Conversation |
|--------|-------|--------------|
| **Restore to session start (files + conversation)** | Restored to session start | Reset to that point |
| **Conversation only (keep current files)** | Unchanged | Reset to that point |
| **Restore to session start (files only, keep conversation)** | Restored to session start | Unchanged |
| **Undo last file rewind** | Restored to before last rewind | Unchanged |

### Resumed Sessions

When you resume a session (`pi --resume`), the extension creates a resume checkpoint. If you branch to a message from before the current session, you can restore files to the state when you resumed (not per-message granularity, but a safety net).

## Examples

### Undo a bad refactor

```
You: refactor the auth module to use JWT
Agent: [makes changes you don't like]

You: /branch
→ Select "refactor the auth module to use JWT"
→ Select "Code only (restore files, keep conversation)"

Result: Files restored, conversation intact. Try a different approach.
```

### Start fresh from a checkpoint

```
You: /branch
→ Select an earlier message
→ Select "Restore all (files + conversation)"

Result: Both files and conversation reset to that point.
```

### Recover after resuming

```bash
pi --resume  # resume old session
```

```
Agent: [immediately breaks something]

You: /branch
→ Select any old message
→ Select "Restore to session start (files only, keep conversation)"

Result: Files restored to state when you resumed.
```

## Viewing Checkpoints

List all checkpoint refs:

```bash
git for-each-ref refs/pi-checkpoints/
```

Checkpoint ref format: `checkpoint-{sessionId}-{timestamp}-{entryId}`

Manually restore to a checkpoint (copy ref name from list above):

```bash
git checkout refs/pi-checkpoints/checkpoint-abc12345-...-... -- .
```

Delete all checkpoints:

```bash
git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | xargs -n1 git update-ref -d
```

## Uninstalling

1. Remove the extension directory:
   ```bash
   rm -rf ~/.pi/agent/extensions/rewind
   ```
   On Windows (PowerShell): `Remove-Item -Recurse -Force ~/.pi/agent/extensions/rewind`

2. Remove the extension from `~/.pi/agent/settings.json` (delete the line with `rewind/index.ts` from the `extensions` array)

3. Optionally, clean up git refs and trace data in each repo where you used the extension:
   ```bash
   # Remove checkpoint refs
   git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | xargs -n1 git update-ref -d

   # Remove trace SHA refs
   git for-each-ref --format='%(refname)' refs/pi-trace-shas/ | xargs -n1 git update-ref -d

   # Remove trace notes from commits
   git notes --ref=refs/notes/pi-trace list | awk '{print $2}' | xargs -n1 git notes --ref=refs/notes/pi-trace remove

   # Remove trace data directory
   rm -rf .pi-trace/
   ```

## Limitations

**Checkpoints:**
- Only works in git repositories
- Checkpoints are scoped per-session (multiple sessions in the same repo don't share checkpoints)
- Resumed sessions only have a single resume checkpoint for pre-session messages
- Tracks working directory changes only (not staged/committed changes)
- Each session has its own 100-checkpoint limit (pruning doesn't affect other sessions)

**Tracing:**
- Concurrent edits during an agent loop (editing a file in your editor while the agent is actively processing) are captured in the agent's "after" snapshot and attributed to the prompt. The system has no way to distinguish agent tool calls from simultaneous human edits within the same snapshot window.
- For uncommitted blame, all non-AI lines show as `(pre-session)` regardless of whether they existed before the session or were manually edited between prompts. Committed blame makes a finer distinction: `(human)` for commits without pi involvement, `(untraced)` for manual edits within traced commits.
- File renames between commits are not tracked (renamed files show as "untraced" in blame)
- `--amend` commits are excluded from trace detection
- Trace JSONL is branch-agnostic — stale traces from other branches may briefly appear, but gap reconciliation nullifies cross-branch attributions
- Post-commit hook writes raw traces only (no per-line resolution); the extension overwrites with full resolution when running inside pi

## Credits

- **[Agent Trace](https://github.com/cursor/agent-trace)** — The trace records written by this extension follow the Agent Trace spec for tool-agnostic prompt-to-code attribution. Interoperable with any tool that reads the same schema.
- **[git-ai](https://github.com/git-ai-project/git-ai)** — Inspiration for per-line blame, git notes storage, and forward attribution algorithms
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
