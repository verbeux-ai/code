import { describe, expect, test } from 'bun:test'
import {
  getHeapUsedRatio,
  parseCgroupMemoryValue,
  parseLinuxKbFile,
} from './memoryDiagnostics.js'

describe('memoryDiagnostics', () => {
  test('parses cgroup memory values', () => {
    expect(parseCgroupMemoryValue('max\n')).toBe('max')
    expect(parseCgroupMemoryValue('1073741824\n')).toBe(1073741824)
    expect(parseCgroupMemoryValue('')).toBeNull()
    expect(parseCgroupMemoryValue('not-a-number')).toBeNull()
  })

  test('parses selected Linux kB files as bytes', () => {
    const parsed = parseLinuxKbFile(
      [
        'VmRSS:\t  1024 kB',
        'VmHWM:\t  2048 kB',
        'Threads:\t4',
        'VmSize:\t  4096 kB',
      ].join('\n'),
      ['VmRSS', 'VmSize'],
    )

    expect(parsed).toEqual({
      VmRSS: 1024 * 1024,
      VmSize: 4096 * 1024,
    })
  })

  test('calculates heap used ratio defensively', () => {
    expect(getHeapUsedRatio(50, 100)).toBe(0.5)
    expect(getHeapUsedRatio(50, 0)).toBeNull()
    expect(getHeapUsedRatio(Number.NaN, 100)).toBeNull()
  })
})
