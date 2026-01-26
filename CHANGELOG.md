# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.7.3] - 2026-01-26

### Fixed
- Install script now uses auto-discovery instead of adding to `settings.extensions`
- Install script now downloads `package.json` with `pi.extensions` declaration
- Removes rewind from explicit extensions array if present (prevents duplicate loading errors)

## [1.7.2] - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## [1.7.1] - 2026-01-22

### Changed
- Reordered restore menus to show non-file-restorative options first (most common action)
  - Branch menu: "Conversation only" now appears first
  - Tree navigation: "Keep current files" now appears first

### Fixed
- Resume checkpoint now session-scoped (`checkpoint-resume-{sessionId}-{timestamp}`) for consistency with other checkpoint types

## [1.7.0] - 2026-01-15

### Fixed
- **Critical**: Checkpoints now scoped per-session to prevent cross-session interference
  - Multiple pi sessions in the same git repo no longer prune each other's checkpoints
  - "Undo last file rewind" now only restores YOUR session's pre-restore state, not another session's
- **Critical**: Fixed event name `session_before_branch` → `session_before_fork` (fork handler was never being called!)
- Checkpoint ref format now includes session ID: `checkpoint-{sessionId}-{timestamp}-{entryId}`
- Before-restore ref format now includes session ID: `before-restore-{sessionId}-{timestamp}`

### Changed
- `rebuildCheckpointsMap()` now filters by current session ID (with backward compat for old format)
- `pruneCheckpoints()` now only prunes checkpoints from current session
- `findBeforeRestoreRef()` now only finds refs from current session

### Backward Compatibility
- Old-format checkpoints (`checkpoint-{timestamp}-{entryId}`) are still loaded for resumed sessions
- Old-format checkpoints are not pruned (to avoid cross-session interference)
- New checkpoints are created in the new session-scoped format

## [1.6.0] - 2025-01-13

### Added
- `rewind.silentCheckpoints` setting to hide checkpoint status and notifications

## [1.5.0] - 2025-01-10

### Changed
- Replaced noisy stderr logging with clean TUI output
- Footer now shows checkpoint count (`◆ X checkpoints`)
- "Checkpoint X saved" notification appears when checkpoint is created
- Pruning now happens before status update to ensure accurate count

### Fixed
- State not reset on `/new` or `/resume` (added `session_switch` handler)
- Checkpoints map not cleared before rebuild (could have stale entries)
- `findBeforeRestoreRef` now validates git output format
- Status count now accurate after pruning old checkpoints

### Removed
- All `console.error` debug logging (cleaner output)
- Temporary "capturing..." and "restoring..." status messages (too noisy)

## [1.4.0] - 2026-01-08

### Fixed
- **Critical**: Checkpoints now persist across session resumes - entry IDs are embedded in git ref names and rebuilt on session start
- **Critical**: Fixed checkpoint being associated with wrong entry ID (was using previous assistant entry instead of current user entry)
- **Critical**: Pruning no longer incorrectly removes Map entries for newer checkpoints when deleting older ones for same entry
- Tree navigation now always shows options menu (even when no checkpoint available)
- Branch now offers "Conversation only" option even when no checkpoint is available

### Changed
- Checkpoint ref format now includes entry ID: `checkpoint-{timestamp}-{entryId}`
- Added `rebuildCheckpointsMap()` to reconstruct entry→checkpoint mappings from git refs
- Use leaf entry at `turn_start` (the user message) instead of tracking via `tool_result`
- Added `--sort=creatordate` to `for-each-ref` calls for consistent ordering
- Removed unused `tool_result` handler

## [1.3.0] - 2026-01-05

### Breaking Changes
- Requires pi v0.35.0+ (unified extensions system)
- Install location changed from `hooks/rewind` to `extensions/rewind`

### Changed
- Migrated from hooks to unified extensions system
- Settings key changed from `hooks` to `extensions`
- Install script now migrates old hooks config and cleans up old directory
- Renamed "Hook" to "Extension" throughout codebase and docs

## [1.2.0] - 2025-01-03

### Added
- Tree navigation support (`session_before_tree`) - restore files when navigating session tree
- Entry-based checkpoint mapping (uses entry IDs instead of turn indices)

### Changed
- Migrated to granular session events API (pi-coding-agent v0.31+)
- Use `pi.exec` instead of `ctx.exec` per updated hooks API

### Fixed
- Removed `agent_end` handler that was clearing checkpoints after each turn
- "Undo last file rewind" now cancels branch instead of creating unwanted branch

## [1.1.1] - 2024-12-27

### Fixed
- Use `before_branch` event instead of `branch` for proper hook timing (thanks @badlogic)
- Cancel branch when user dismisses restore options menu

## [1.1.0] - 2024-12-27

### Added
- "Undo last file rewind" option - restore files to state before last rewind
- Checkpoints now capture uncommitted and untracked files (not just HEAD)
- Git repo detection - hook gracefully skips in non-git directories

### Changed
- Checkpoints use `git write-tree` with temp index to capture working directory state
- Pruning excludes before-restore ref and current session's resume checkpoint

### Fixed
- Code-only restore options now properly skip conversation restore

## [1.0.0] - 2024-12-19

### Added
- Initial release
- Automatic checkpoints at session start and each turn
- `/branch` integration with restore options:
  - Restore all (files + conversation)
  - Conversation only (keep current files)
  - Code only (restore files, keep conversation)
- Resume checkpoint for pre-session messages
- Automatic pruning (keeps last 100 checkpoints)
- Cross-platform installation via `npx pi-rewind-hook`
