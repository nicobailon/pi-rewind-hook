# Rewind Hook

A Pi agent hook that enables rewinding file changes during coding sessions. Creates automatic checkpoints using git refs, allowing you to restore files to previous states while optionally preserving conversation history.

## Requirements

- Pi agent v0.18.0+
- Git repository (checkpoints are stored as git refs)

## Setup

Add to `~/.pi/agent/settings.json`:

```json
{
  "hooks": ["~/.pi/agent/hooks/rewind/index.ts"]
}
```

Or use the CLI flag:

```bash
pi --hook ~/.pi/agent/hooks/rewind/index.ts
```

## How It Works

### Checkpoints

The hook creates git refs at two points:

1. **Session start** - When pi starts, creates a "resume checkpoint" of the current file state
2. **Each turn** - Before the agent processes each message, creates a checkpoint

Checkpoints are stored as git refs under `refs/pi-checkpoints/` and are pruned to keep the last 100.

### Rewinding

To rewind:

1. Type `/branch` in pi
2. Select a message to branch from
3. Choose a restore option:

**For messages from the current session:**

| Option | Files | Conversation |
|--------|-------|--------------|
| **Restore all (files + conversation)** | Restored | Reset to that point |
| **Conversation only (keep current files)** | Unchanged | Reset to that point |
| **Code only (restore files, keep conversation)** | Restored | Unchanged |

**For messages from before the current session (uses resume checkpoint):**

| Option | Files | Conversation |
|--------|-------|--------------|
| **Restore to session start (files + conversation)** | Restored to session start | Reset to that point |
| **Conversation only (keep current files)** | Unchanged | Reset to that point |
| **Restore to session start (files only, keep conversation)** | Restored to session start | Unchanged |

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

## Limitations

- Only works in git repositories
- Checkpoints are per-process (in-memory map), not persisted across restarts
- Resumed sessions only have a single resume checkpoint for pre-session messages
- Tracks working directory changes only (not staged/committed changes)
