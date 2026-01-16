# Rewind Extension

A Pi agent extension that enables rewinding file changes during coding sessions. Creates automatic checkpoints using git refs, allowing you to restore files to previous states while optionally preserving conversation history.

## Screenshots

![Selecting a message to branch from](rewind1.png)

![Choosing a restore option](rewind2.png)

## Requirements

- Pi agent v0.35.0+ (unified extensions system)
- Node.js (for installation)
- Git repository (checkpoints are stored as git refs)

## Installation

```bash
npx pi-rewind-hook
```

This will:
1. Create `~/.pi/agent/extensions/rewind/`
2. Download the extension files
3. Add the extension to your `~/.pi/agent/settings.json`
4. Migrate any existing hooks config to extensions (if upgrading from v1.2.0)
5. Clean up old `hooks/rewind` directory (if present)

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
    "silentCheckpoints": true
  }
}
```

### Settings

- **`rewind.silentCheckpoints`** (boolean, default: `false`): When set to `true`, disables checkpoint status messages. The footer checkpoint count (`◆ X checkpoints`) and checkpoint saved notifications (`Checkpoint X saved`) will not be displayed.

## How It Works

### Checkpoints

The extension creates git refs at two points:

1. **Session start** - When pi starts, creates a "resume checkpoint" of the current file state
2. **Each turn** - Before the agent processes each message, creates a checkpoint

Checkpoints are stored as git refs under `refs/pi-checkpoints/` and are scoped per-session (so multiple pi sessions in the same repo don't interfere with each other). Each session maintains its own 100-checkpoint limit.

### Rewinding

To rewind via `/fork`:

1. Type `/fork` in pi
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

You: /fork
→ Select "refactor the auth module to use JWT"
→ Select "Code only (restore files, keep conversation)"

Result: Files restored, conversation intact. Try a different approach.
```

### Start fresh from a checkpoint

```
You: /fork
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

You: /fork
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

3. Optionally, clean up git refs in each repo where you used the extension:
   ```bash
   git for-each-ref --format='%(refname)' refs/pi-checkpoints/ | xargs -n1 git update-ref -d
   ```

## Limitations

- Only works in git repositories
- Checkpoints are scoped per-session (multiple sessions in the same repo don't share checkpoints)
- Resumed sessions only have a single resume checkpoint for pre-session messages
- Tracks working directory changes only (not staged/committed changes)
- Each session has its own 100-checkpoint limit (pruning doesn't affect other sessions)
