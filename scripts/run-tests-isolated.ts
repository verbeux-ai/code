/**
 * Run each tracked test file in its own Bun process.
 *
 * Bun module mocks are process-global and mock.restore() does not fully undo
 * every module replacement between files. Process isolation prevents one test
 * file from changing the imports or environment observed by later suites.
 */

type TestResult = {
  file: string
  exitCode: number
  stdout: string
  stderr: string
}

function listTrackedTestFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: [
      'git',
      'ls-files',
      '--',
      ':(glob)**/*.test.ts',
      ':(glob)**/*.test.tsx',
      ':(glob)**/*.test.js',
      ':(glob)**/*.test.jsx',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Could not list test files: ${result.stderr.toString().trim()}`,
    )
  }

  return result.stdout
    .toString()
    .split('\n')
    .map(file => file.trim())
    .filter(Boolean)
    .sort()
}

function selectTestFiles(files: string[]): string[] {
  const filters = process.argv.slice(2)
  if (filters.length === 0) return files

  const selected = files.filter(file =>
    filters.some(filter =>
      filter.endsWith('/') ? file.startsWith(filter) : file === filter,
    ),
  )
  if (selected.length === 0) {
    throw new Error(`No tracked test files matched: ${filters.join(', ')}`)
  }
  return selected
}

function getConcurrency(): number {
  const parsed = Number.parseInt(process.env.TEST_ISOLATION_CONCURRENCY ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4
}

async function loadBaseline(files: string[]): Promise<Set<string>> {
  const baselineFile = Bun.file('.github/test-baseline.txt')
  if (!(await baselineFile.exists())) return new Set()

  const baseline = new Set(
    (await baselineFile.text())
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')),
  )
  const trackedFiles = new Set(files)
  const unknownEntries = [...baseline].filter(file => !trackedFiles.has(file))
  if (unknownEntries.length > 0) {
    throw new Error(
      `Test baseline contains unknown files:\n${unknownEntries.join('\n')}`,
    )
  }
  return baseline
}

async function runTestFile(file: string): Promise<TestResult> {
  const process = Bun.spawn({
    cmd: [
      Bun.env.BUN_EXEC_PATH || 'bun',
      'test',
      '--max-concurrency=1',
      '--only-failures',
      file,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...Bun.env },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return { file, exitCode, stdout, stderr }
}

const allTrackedTestFiles = listTrackedTestFiles()
const files = selectTestFiles(allTrackedTestFiles)
const baseline = await loadBaseline(allTrackedTestFiles)
const unexpectedFailures: TestResult[] = []
const baselineFailures: TestResult[] = []
const baselineImprovements: string[] = []
let nextIndex = 0
let completed = 0

async function worker(): Promise<void> {
  while (true) {
    const index = nextIndex++
    const file = files[index]
    if (!file) return

    const result = await runTestFile(file)
    completed++
    if (result.exitCode === 0) {
      if (baseline.has(file)) baselineImprovements.push(file)
      process.stdout.write(`[${completed}/${files.length}] PASS ${file}\n`)
    } else if (baseline.has(file)) {
      baselineFailures.push(result)
      process.stdout.write(
        `[${completed}/${files.length}] BASELINE ${file}\n`,
      )
    } else {
      unexpectedFailures.push(result)
      process.stdout.write(`[${completed}/${files.length}] FAIL ${file}\n`)
    }
  }
}

await Promise.all(
  Array.from(
    { length: Math.min(getConcurrency(), Math.max(files.length, 1)) },
    () => worker(),
  ),
)

for (const failure of unexpectedFailures) {
  process.stderr.write(`\n===== ${failure.file} =====\n`)
  process.stderr.write(failure.stdout)
  process.stderr.write(failure.stderr)
}

if (baselineImprovements.length > 0) {
  process.stdout.write(
    `\nBaseline files now passing (remove after confirming in CI):\n${baselineImprovements.join('\n')}\n`,
  )
}

if (unexpectedFailures.length > 0) {
  process.stderr.write(
    `\n${unexpectedFailures.length} unexpected test files failed; ${baselineFailures.length} known baseline files also failed.\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    `\nNo new test-file regressions. ${baselineFailures.length} known baseline files still fail.\n`,
  )
}
