# Changelog

All notable changes to this project will be documented in this file.

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
