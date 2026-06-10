# Multi-source Session Loading Design

**Date:** 2026-06-10
**Status:** Approved

## Problem

The Verboo CLI (`./verboo-code`) does not load sessions from OpenClaude for `/resume` or autocomplete. It should aggregate sessions from all CLIs: OpenClaude, Claude Code, and Verboo itself.

## Current Architecture

- `getProjectsDir()` returns `~/.claude/projects/` (or `$VERBOO_PROJECTS_DIR`)
- All session loading (`loadSameRepoMessageLogs`, `loadAllProjectsMessageLogs`, `getStatOnlyLogsForWorktrees`) reads from this single directory
- Writing (transcripts, compaction) also goes to this single directory

Existing session paths:
| CLI | Sessions dir | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<uuid>.jsonl` | JSONL |
| OpenClaude | `~/.openclaude/projects/<project>/<uuid>.jsonl` | JSONL (same) |
| Verboo Code | `~/.verboo/projects/<project>/<uuid>.jsonl` | JSONL (same) |

## Solution: Multi-source via `getProjectsDirs()`

### Reading

Add `getAdditionalProjectsDirs()` and `getProjectsDirs()` in `envUtils.ts`:

- `getAdditionalProjectsDirs()` detects `~/.openclaude/projects/` (auto-detect if exists)
- `getProjectsDirs()` returns `[getProjectsDir(), ...getAdditionalProjectsDirs()]`
- `getProjectsDir()` (singular) unchanged — used for WRITE operations only

Modify session loading functions in `sessionStorage.ts` to iterate over all source dirs:

- `loadAllProjectsMessageLogsProgressive` — iterate `getProjectsDirs()`, collect from each
- `loadSameRepoMessageLogsProgressive` / `getStatOnlyLogsForWorktrees` — include additional dirs
- `fetchLogs` — use `getProjectsDirs()`

Deduplication via existing `deduplicateLogsBySessionId()` — same session can appear in multiple dirs.

### Writing

After each write operation, mirror the transcript file to additional source dirs:

- `appendToTranscriptFile` — after write, copy to each additional dir
- `compactTranscript` — after compact, copy to each additional dir

Mirror target: `join(additionalSourceDir, sanitizedProjectDir, sessionId + '.jsonl')`

### Files Changed

| File | Change |
|---|---|
| `src/utils/envUtils.ts` | Add `getAdditionalProjectsDirs()`, `getProjectsDirs()` |
| `src/utils/sessionStorage.ts` | Modify load functions to multi-source; add mirror post-write |

Zero changes to: `resume.tsx`, `ResumeConversation.tsx`, `conversationRecovery.ts`.
