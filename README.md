# Rewind Hook

A Pi agent hook that enables rewinding file changes during coding sessions. Creates automatic checkpoints using git refs, allowing you to restore files to previous states while optionally preserving conversation history.

## Screenshots

![Selecting a message to branch from](rewind1.png)

![Choosing a restore option](rewind2.png)

## Requirements

- Pi agent v0.31+
- Node.js (for installation)
- Git repository (checkpoints are stored as git refs)

## Installation

```bash
npx pi-rewind-hook
```

This will:
1. Create `~/.pi/agent/hooks/rewind/`
2. Download the hook files
3. Add the hook to your `~/.pi/agent/settings.json`

### Alternative Installation

Using curl:

```bash
curl -fsSL https://raw.githubusercontent.com/nicobailon/pi-rewind-hook/main/install.js | node
```

Or clone the repo and configure manually:

```bash
git clone https://github.com/nicobailon/pi-rewind-hook ~/.pi/agent/hooks/rewind
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "hooks": ["~/.pi/agent/hooks/rewind/index.ts"]
}
```

### Platform Notes

**Windows:** The `npx` command works in PowerShell, Command Prompt, and WSL. If you prefer curl on Windows without WSL:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nicobailon/pi-rewind-hook/main/install.js" -OutFile install.js; node install.js; Remove-Item install.js
```

## How It Works

### Checkpoints

The hook creates git refs at two points:

1. **Session start** - When pi starts, creates a "resume checkpoint" of the current file state
2. **Each turn** - Before the agent processes each message, creates a checkpoint

Checkpoints are stored as git refs under `refs/pi-checkpoints/` and are pruned to keep the last 100.

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

When you resume a session (`pi --resume`), the hook creates a resume checkpoint. If you branch to a message from before the current session, you can restore files to the state when you resumed (not per-message granularity, but a safety net).

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

Manually restore to a checkpoint:

```bash
git checkout refs/pi-checkpoints/checkpoint-1234567890 -- .
```

Delete all checkpoints:

```bash
git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | xargs -n1 git update-ref -d
```

## Uninstalling

1. Remove the hook directory:
   ```bash
   rm -rf ~/.pi/agent/hooks/rewind
   ```
   On Windows (PowerShell): `Remove-Item -Recurse -Force ~/.pi/agent/hooks/rewind`

2. Remove the hook from `~/.pi/agent/settings.json` (delete the line with `rewind/index.ts` from the `hooks` array)

3. Optionally, clean up git refs in each repo where you used the hook:
   ```bash
   git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | xargs -n1 git update-ref -d
   ```

## Limitations

- Only works in git repositories
- Checkpoints are per-process (in-memory map), not persisted across restarts
- Resumed sessions only have a single resume checkpoint for pre-session messages
- Tracks working directory changes only (not staged/committed changes)
