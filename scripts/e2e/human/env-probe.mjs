// Test-only preload (via NODE_OPTIONS): a spawned command cannot read the CLI's
// process.env, so this records from inside the CLI process when the variables
// named in CLI_E2E_ENV_PROBE_NAMES appear or change. Values go to
// CLI_E2E_ENV_PROBE_LOG, one JSON object per line: only pass fixture values.
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

const log = process.env.CLI_E2E_ENV_PROBE_LOG
const names = (process.env.CLI_E2E_ENV_PROBE_NAMES ?? '').split(',').filter(Boolean)
// NODE_OPTIONS is inherited: only the CLI itself is probed, not its children.
if (log && names.length && basename(process.argv[1] ?? '') === 'verboo') {
  const last = new Map()
  const scan = () => {
    for (const name of names) {
      const value = process.env[name]
      if (value === last.get(name)) continue
      last.set(name, value)
      appendFileSync(log, `${JSON.stringify({ name, value, at: Date.now() })}\n`)
    }
  }
  scan()
  setInterval(scan, 25).unref()
}
