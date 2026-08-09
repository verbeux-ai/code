import assert from 'node:assert/strict'
import test from 'node:test'

import command from './index.js'

test('/chrome is available to Verboo users without Anthropic account gating', () => {
  assert.equal(command.name, 'chrome')
  assert.equal(command.availability, undefined)
})
