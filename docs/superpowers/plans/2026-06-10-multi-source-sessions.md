# Multi-Source Session Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verboo CLI loads sessions from OpenClaude (`~/.openclaude/projects/`) in addition to Claude Code (`~/.claude/projects/`) for `/resume` and autocomplete.

**Architecture:** Add `getAdditionalProjectsDirs()` + `getProjectsDirs()` to `envUtils.ts`; modify read paths in `sessionStorage.ts` to iterate over all source dirs; mirror writes to additional dirs post-append.

**Tech Stack:** TypeScript, Bun, Node.js `fs/promises`, existing session JSONL format.

---

### Task 1: Add `getAdditionalProjectsDirs()` and `getProjectsDirs()` to envUtils.ts

**Files:**
- Modify: `src/utils/envUtils.ts:55-60`

- [ ] **Step 1: Add functions after `getProjectsDir()`**

Add after line 60 (`getProjectsDir()` closing brace):

```typescript
import { existsSync } from 'fs'

// (add existsSync import at top of file — replace `import { homedir } from 'os'` with
//  `import { homedir } from 'os'` and add `import { existsSync } from 'fs'` line)

// Diretórios adicionais de projetos para leitura multi-source.
// Atualmente detecta OpenClaude (~/.openclaude/projects) se existir.
export function getAdditionalProjectsDirs(): string[] {
  const dirs: string[] = []

  const openClaudeDir = join(homedir(), '.openclaude', 'projects')
  if (existsSync(openClaudeDir)) {
    dirs.push(openClaudeDir)
  }

  return dirs
}

// Retorna TODOS os diretórios de projetos (principal + adicionais).
// Usado para LEITURA de sessions. Escrita continua usando getProjectsDir().
export function getProjectsDirs(): string[] {
  return [getProjectsDir(), ...getAdditionalProjectsDirs()]
}
```

- [ ] **Step 2: Verify the code compiles**

Run: `cd verboo-code && npm run build` (or `bun build` if available)
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add verboo-code/src/utils/envUtils.ts
git commit -m "feat: add getProjectsDirs() for multi-source session loading"
```

---

### Task 2: Modify `loadAllProjectsMessageLogsProgressive` to use multi-source

**Files:**
- Modify: `src/utils/sessionStorage.ts:4270-4301`

- [ ] **Step 1: Update import to include `getProjectsDirs`**

Change line 72:
```typescript
import { getClaudeConfigHomeDir, getProjectsDir, isEnvTruthy } from './envUtils.js'
```
to:
```typescript
import { getClaudeConfigHomeDir, getProjectsDir, getProjectsDirs, isEnvTruthy } from './envUtils.js'
```

- [ ] **Step 2: Modify `loadAllProjectsMessageLogsProgressive` to iterate all source dirs**

Replace the function body (lines 4274-4300) to iterate over `getProjectsDirs()`:

```typescript
export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const projectsDirs = getProjectsDirs()
  const rawLogs: LogOption[] = []

  for (const projectsDir of projectsDirs) {
    let dirents: Dirent[]
    try {
      dirents = await readdir(projectsDir, { withFileTypes: true })
    } catch {
      continue
    }

    const projectDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(projectsDir, dirent.name))

    for (const projectDir of projectDirs) {
      rawLogs.push(...(await getSessionFilesLite(projectDir, limit)))
    }
  }

  // Deduplicate — same session can appear in multiple source dirs
  const sorted = deduplicateLogsBySessionId(rawLogs)

  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)

  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs: sorted, nextIndex }
}
```

- [ ] **Step 3: Commit**

```bash
git add verboo-code/src/utils/sessionStorage.ts
git commit -m "feat: load sessions from all project dirs (Claude + OpenClaude)"
```

---

### Task 3: Modify `getStatOnlyLogsForWorktrees` to include additional dirs

**Files:**
- Modify: `src/utils/sessionStorage.ts:4365-4432`

- [ ] **Step 1: Modify the function**

Replace `getStatOnlyLogsForWorktrees` to scan standard worktree dirs first, then additional source dirs:

```typescript
async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()
  const allLogs: LogOption[] = []

  // Helper to scan a single project dir (extracted from existing logic)
  async function scanProjectDir(srcDir: string, wtPaths: string[], lim?: number): Promise<LogOption[]> {
    let allDirents: Dirent[]
    try {
      allDirents = await readdir(srcDir, { withFileTypes: true })
    } catch {
      return []
    }

    if (wtPaths.length <= 1) {
      const cwd = getOriginalCwd()
      const projectDir = join(srcDir, sanitizePath(cwd))
      return getSessionFilesLite(projectDir, undefined, cwd)
    }

    const caseInsensitive = process.platform === 'win32'

    const indexed = wtPaths.map(wt => {
      const sanitized = sanitizePath(wt)
      return { path: wt, prefix: sanitized, fullPath: sanitized }
    })

    const logs: LogOption[] = []
    const seenDirs = new Set<string>()
    function matches(dirName: string): string | null {
      const normalized = caseInsensitive ? dirName.toLowerCase() : dirName
      for (const { path: wtPath, prefix } of indexed) {
        const pfx = caseInsensitive ? prefix.toLowerCase() : prefix
        if (normalized === pfx || normalized.startsWith(pfx + '-')) {
          return wtPath
        }
      }
      return null
    }

    for (const dirent of allDirents) {
      if (!dirent.isDirectory()) continue
      const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
      if (seenDirs.has(dirName)) continue
      seenDirs.add(dirName)

      const matchedWorktree = matches(dirent.name)
      if (matchedWorktree) {
        logs.push(
          ...(await getSessionFilesLite(join(srcDir, dirent.name), lim, matchedWorktree)),
        )
      }
    }

    return logs
  }

  // Scan primary dir
  allLogs.push(...(await scanProjectDir(projectsDir, worktreePaths, limit)))

  // Scan additional dirs
  for (const additionalDir of getAdditionalProjectsDirs()) {
    allLogs.push(...(await scanProjectDir(additionalDir, worktreePaths, limit)))
  }

  return deduplicateLogsBySessionId(allLogs)
}
```

- [ ] **Step 2: Update imports**

Add `getAdditionalProjectsDirs` to the envUtils import:
```typescript
import { getClaudeConfigHomeDir, getAdditionalProjectsDirs, getProjectsDir, getProjectsDirs, isEnvTruthy } from './envUtils.js'
```

- [ ] **Step 3: Verify compilation**

Run: `cd verboo-code && npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add verboo-code/src/utils/sessionStorage.ts
git commit -m "feat: scan OpenClaude dirs in worktree session search"
```

---

### Task 4: Mirror writes to additional project dirs

**Files:**
- Modify: `src/utils/sessionStorage.ts`

- [ ] **Step 1: Add `copyFile` to fs/promises import**

```typescript
import {
  appendFile as fsAppendFile,
  copyFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
```

- [ ] **Step 2: Add helper function to mirror a session file to additional dirs**

Add after `getTranscriptPathForSession` (around line 221):

```typescript
// Após escrever um transcript file, espelha para diretórios adicionais
// (ex: ~/.openclaude/projects/) para que outros CLIs vejam as alterações.
export async function mirrorTranscriptToAdditionalDirs(
  sessionId: string,
): Promise<void> {
  const additionalDirs = getAdditionalProjectsDirs()
  if (additionalDirs.length === 0) return

  const projectDirName = sanitizePath(getSessionProjectDir() ?? getOriginalCwd())
  const sourcePath = getTranscriptPathForSession(sessionId)

  for (const baseDir of additionalDirs) {
    const targetDir = join(baseDir, projectDirName)
    const targetPath = join(targetDir, `${sessionId}.jsonl`)
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o700 })
      await copyFile(sourcePath, targetPath)
    } catch {
      // Non-critical — mirror failure should not block the write
    }
  }
}
```

- [ ] **Step 3: Add mirror call in SessionFileWriter after each flush**

In the `drainWriteQueue` method, after the loop that writes batches (after line 682), add mirror logic. But actually, the writer flushes per-filePath, and the filePath is the session file. Better to mirror after each batch write completes.

Actually, looking more carefully at the writer, the simplest approach is to add the mirror in `ensureCurrentSessionFile` or at the point where entries are appended. Let me add it after `appendToFile` calls in `drainWriteQueue`.

After line 669 (`await this.appendToFile(filePath, content)`), add:

```typescript
        // Mirror to additional project dirs (OpenClaude, etc.)
        const sessionId = getSessionId()
        if (sessionId) {
          mirrorTranscriptToAdditionalDirs(sessionId).catch(() => {})
        }
```

Wait, `mirrorTranscriptToAdditionalDirs` is async. Let me think about a cleaner approach.

Actually, the simplest mirror point is right in `appendToFile`. After writing to the file, mirror. Let me add it there:

```typescript
  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      await fsAppendFile(filePath, data, { mode: 0o600 })
    }

    // Mirror to additional project dirs after successful write
    const sessionId = getSessionId()
    if (sessionId) {
      this.mirrorToAdditionalDirs(filePath, sessionId).catch(() => {})
    }
  }

  private async mirrorToAdditionalDirs(
    writtenFile: string,
    sessionId: string,
  ): Promise<void> {
    const additionalDirs = getAdditionalProjectsDirs()
    if (additionalDirs.length === 0) return

    const projectDirName = sanitizePath(getSessionProjectDir() ?? getOriginalCwd())

    for (const baseDir of additionalDirs) {
      const targetDir = join(baseDir, projectDirName)
      const targetPath = join(targetDir, `${sessionId}.jsonl`)
      try {
        await mkdir(targetDir, { recursive: true, mode: 0o700 })
        await copyFile(writtenFile, targetPath)
      } catch {
        // Non-critical mirror
      }
    }
  }
```

But wait, we need `copyFile` imported and `getAdditionalProjectsDirs` imported.

- [ ] **4: Update imports in sessionStorage.ts**

Add `copyFile` to fs/promises import.
Add `getAdditionalProjectsDirs` to envUtils import.
Add `sanitizePath` — check if it's already imported.

- [ ] **5: Commit**

```bash
git add verboo-code/src/utils/sessionStorage.ts
git commit -m "feat: mirror session writes to OpenClaude project dir"
```

---

### Task 5: Verify with build

- [ ] **Step 1: Full build check**

Run: `cd verboo-code && npm run build`
Expected: Build succeeds

- [ ] **Step 2: Run existing tests**

Run: `cd verboo-code && bun test src/utils/envUtils.test.ts` (if exists) or similar
Expected: All tests pass
