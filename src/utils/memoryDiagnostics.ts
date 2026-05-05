import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { getHeapSpaceStatistics, getHeapStatistics } from 'v8'
import type { AppState } from '../state/AppState.js'
import type { TaskState } from '../tasks/types.js'
import { isDebugMode, getMinDebugLogLevel, logForDebugging } from './debug.js'
import { jsonStringify } from './slowOperations.js'
import { getTaskOutputPath } from './task/diskOutput.js'

const HIGH_WATERMARK_RATIO = 0.7
const HIGH_WATERMARK_THROTTLE_MS = 60_000
const PROC_STATUS_KEYS = ['VmRSS', 'VmHWM', 'VmSize', 'VmData', 'VmStk']
const PROC_MEMINFO_KEYS = [
  'MemTotal',
  'MemAvailable',
  'SwapTotal',
  'SwapFree',
]

let lastHighWatermarkLogMs = 0

export type MemoryDiagExtra = Record<string, unknown>

type MemoryDiagOptions = {
  includeVerboseDetails?: boolean
}

export function parseCgroupMemoryValue(raw: string | undefined): number | 'max' | null {
  const value = raw?.trim()
  if (!value) return null
  if (value === 'max') return 'max'
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function parseLinuxKbFile(
  raw: string,
  keys: readonly string[],
): Record<string, number> {
  const wanted = new Set(keys)
  const result: Record<string, number> = {}
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z0-9_()]+):\s+(\d+)\s+kB\b/.exec(line)
    if (!match) continue
    const key = match[1]!
    if (!wanted.has(key)) continue
    result[key] = Number(match[2]) * 1024
  }
  return result
}

export function getHeapUsedRatio(
  heapUsed: number,
  heapSizeLimit: number,
): number | null {
  if (!Number.isFinite(heapUsed) || !Number.isFinite(heapSizeLimit)) return null
  if (heapSizeLimit <= 0) return null
  return heapUsed / heapSizeLimit
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readCgroupMemoryDiagnostics(): Record<string, unknown> | undefined {
  if (process.platform !== 'linux') return undefined

  const v2Max = parseCgroupMemoryValue(readText('/sys/fs/cgroup/memory.max'))
  const v2Current = parseCgroupMemoryValue(readText('/sys/fs/cgroup/memory.current'))
  const v1Limit = parseCgroupMemoryValue(
    readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
  )
  const v1Usage = parseCgroupMemoryValue(
    readText('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
  )

  const hasV2 = v2Max !== null || v2Current !== null
  const hasV1 = v1Limit !== null || v1Usage !== null
  if (!hasV1 && !hasV2) return undefined

  const limit = v2Max ?? v1Limit
  const current = v2Current ?? v1Usage
  const currentRatio =
    typeof limit === 'number' && typeof current === 'number' && limit > 0
      ? current / limit
      : null

  return {
    version: hasV2 ? 2 : 1,
    limit,
    current,
    currentRatio,
  }
}

function readLinuxProcDiagnostics(): Record<string, unknown> | undefined {
  if (process.platform !== 'linux') return undefined

  const statusRaw = readText('/proc/self/status')
  const meminfoRaw = readText('/proc/meminfo')
  let fdCount: number | undefined
  try {
    fdCount = readdirSync('/proc/self/fd').length
  } catch {
    // /proc may be unavailable or restricted.
  }

  return {
    ...(statusRaw ? { status: parseLinuxKbFile(statusRaw, PROC_STATUS_KEYS) } : {}),
    ...(meminfoRaw ? { meminfo: parseLinuxKbFile(meminfoRaw, PROC_MEMINFO_KEYS) } : {}),
    ...(fdCount !== undefined ? { openFileDescriptors: fdCount } : {}),
  }
}

function getTaskDiagnostics(task: TaskState): Record<string, unknown> {
  const base: Record<string, unknown> = {
    taskId: task.id,
    taskType: task.type,
    status: task.status,
    descriptionLength: task.description?.length ?? 0,
  }

  if ('messages' in task && Array.isArray(task.messages)) {
    base.messagesCount = task.messages.length
  }
  if ('outputOffset' in task && typeof task.outputOffset === 'number') {
    base.outputOffset = task.outputOffset
  }
  if ('progress' in task && task.progress) {
    const progress = task.progress as {
      tokenCount?: number
      toolUseCount?: number
    }
    base.progressTokenCount = progress.tokenCount
    base.progressToolUseCount = progress.toolUseCount
  }

  if (getMinDebugLogLevel() === 'verbose') {
    try {
      const outputPath = getTaskOutputPath(task.id)
      if (existsSync(outputPath)) {
        const stat = statSync(outputPath)
        base.outputFileSize = stat.size
      }
    } catch {
      // Task output is best-effort debug context only.
    }
  }

  return base
}

export function getAppStateMemoryDiagnostics(
  appState: Pick<AppState, 'tasks'>,
): Record<string, unknown> {
  const tasks = Object.values(appState.tasks ?? {})
  const byStatus: Record<string, number> = {}
  const byType: Record<string, number> = {}

  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    byType[task.type] = (byType[task.type] ?? 0) + 1
  }

  return {
    taskCount: tasks.length,
    runningTaskCount: byStatus.running ?? 0,
    taskStatusCounts: byStatus,
    taskTypeCounts: byType,
  }
}

export function getSingleTaskMemoryDiagnostics(
  task: TaskState,
  appState?: Pick<AppState, 'tasks'>,
): Record<string, unknown> {
  return {
    task: getTaskDiagnostics(task),
    ...(appState ? { appState: getAppStateMemoryDiagnostics(appState) } : {}),
  }
}

export function collectMemoryDiagnostics(
  trigger: string,
  extra: MemoryDiagExtra = {},
  options: MemoryDiagOptions = {},
): Record<string, unknown> {
  const usage = process.memoryUsage()
  const heapStats = getHeapStatistics()
  const heapUsedRatio = getHeapUsedRatio(
    usage.heapUsed,
    heapStats.heap_size_limit,
  )
  const resourceUsage = process.resourceUsage()
  const includeVerbose =
    options.includeVerboseDetails && getMinDebugLogLevel() === 'verbose'

  return {
    trigger,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    execPath: process.execPath,
    entrypoint: process.argv[1] ?? null,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      heapUsedRatio,
    },
    v8: {
      heapSizeLimit: heapStats.heap_size_limit,
      totalAvailableSize: heapStats.total_available_size,
      mallocedMemory: heapStats.malloced_memory,
      peakMallocedMemory: heapStats.peak_malloced_memory,
      nativeContexts: heapStats.number_of_native_contexts,
      detachedContexts: heapStats.number_of_detached_contexts,
      ...(includeVerbose
        ? {
            heapSpaces: getHeapSpaceStatistics().map(space => ({
              name: space.space_name,
              size: space.space_size,
              used: space.space_used_size,
              available: space.space_available_size,
            })),
          }
        : {}),
    },
    resourceUsage: {
      maxRSS: resourceUsage.maxRSS * 1024,
      userCPUTime: resourceUsage.userCPUTime,
      systemCPUTime: resourceUsage.systemCPUTime,
    },
    linux: {
      proc: readLinuxProcDiagnostics(),
      cgroup: readCgroupMemoryDiagnostics(),
    },
    extra,
  }
}

export function logMemoryDiagnostics(
  trigger: string,
  extra: MemoryDiagExtra = {},
  options: MemoryDiagOptions = {},
): void {
  if (!isDebugMode()) return
  logForDebugging(
    `[MemoryDiag:${trigger}] ${jsonStringify(
      collectMemoryDiagnostics(trigger, extra, options),
    )}`,
  )
}

export function maybeLogMemoryHighWatermark(
  trigger: string,
  extra: MemoryDiagExtra = {},
  nowMs = Date.now(),
): void {
  if (!isDebugMode()) return

  const usage = process.memoryUsage()
  const heapStats = getHeapStatistics()
  const ratio = getHeapUsedRatio(usage.heapUsed, heapStats.heap_size_limit)
  if (ratio === null || ratio < HIGH_WATERMARK_RATIO) return
  if (nowMs - lastHighWatermarkLogMs < HIGH_WATERMARK_THROTTLE_MS) return

  lastHighWatermarkLogMs = nowMs
  logMemoryDiagnostics(
    'high-watermark',
    {
      sourceTrigger: trigger,
      threshold: HIGH_WATERMARK_RATIO,
      ...extra,
    },
    { includeVerboseDetails: true },
  )
}

export function _resetMemoryDiagnosticsForTest(): void {
  lastHighWatermarkLogMs = 0
}
