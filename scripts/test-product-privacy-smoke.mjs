import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'verboo-product-privacy-smoke-'))
const options = { env: { ...process.env, VERBOO_CONFIG_DIR: directory }, timeout: 15_000 }
try {
  const result = await exec(process.execPath, ['dist/cli.mjs', 'privacy'], options)
  assert.match(result.stdout, /Sign in to your Verboo account/)
  assert.equal(result.stderr, '')
  await assert.rejects(exec(process.execPath, ['dist/cli.mjs', 'privacy', '--allow', '--deny'], options), error => {
    assert.equal(error.code, 2)
    assert.match(error.stderr, /Choose either --allow or --deny/)
    return true
  })
  console.log('PASS product privacy command: isolated account lookup, explicit options and clean exit')
} finally { await rm(directory, { recursive: true, force: true }) }
