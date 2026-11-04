import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fishAddPath, main, shouldConfigureShell } from './postinstall.mjs'

test('never copies anything from ~/.claude', () => {
  const home = mkdtempSync(join(tmpdir(), 'verboo-postinstall-'))
  try {
    mkdirSync(join(home, '.claude', 'skills', 'my-skill'), { recursive: true })
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    const output = []
    main({ env: { HOME: home, SHELL: '/bin/bash' }, write: text => output.push(text) })
    assert.deepEqual(readdirSync(home), ['.claude'])
    assert.ok(output.join('').includes('Verboo Code instalado com sucesso!'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('passes the npm prefix to fish as one argument', () => {
  const calls = []
  const spawn = (file, args) => {
    calls.push([file, ...args])
    return { status: 0 }
  }
  assert.equal(fishAddPath('/opt/my prefix; rm -rf ~/bin', spawn), true)
  assert.deepEqual(calls, [
    ['fish', '-c', 'fish_add_path -- $argv[1]', '--', '/opt/my prefix; rm -rf ~/bin'],
  ])
})

test('only configures fish for a global install by a regular user outside CI', () => {
  const fish = { SHELL: '/usr/bin/fish', npm_config_global: 'true' }
  assert.equal(shouldConfigureShell({ env: fish, uid: 1000 }), true)
  assert.equal(shouldConfigureShell({ env: fish, uid: 0 }), false)
  assert.equal(shouldConfigureShell({ env: { ...fish, CI: '1' }, uid: 1000 }), false)
  assert.equal(shouldConfigureShell({ env: { SHELL: '/usr/bin/fish' }, uid: 1000 }), false)
  assert.equal(
    shouldConfigureShell({ env: { SHELL: '/bin/zsh', npm_config_global: 'true' }, uid: 1000 }),
    false,
  )
})
