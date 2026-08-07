import { test } from 'node:test'
import assert from 'node:assert/strict'

import { matchSlashQuery, parseSlashInvocation } from './slashCommands.js'

test('parses only a prefix slash invocation', () => {
  assert.deepEqual(parseSlashInvocation('/weekly'), { command: 'weekly' })
  assert.deepEqual(parseSlashInvocation(' /Relatório  '), { command: 'relatorio' })
  assert.equal(parseSlashInvocation('please /weekly'), null)
  assert.equal(parseSlashInvocation('/weekly extra'), null)
  assert.equal(parseSlashInvocation('/'), null)
})

test('matches accent-insensitively and ranks an exact command first', () => {
  const routines = [
    { id: '1', command: 'inbox', name: 'Inbox', description: '' },
    { id: '2', command: 'relatorio-semanal', name: 'Relatório semanal', description: 'Métricas' },
    { id: '3', command: 'rel', name: 'Relacionamentos', description: '' },
  ]

  assert.deepEqual(
    matchSlashQuery('/rel', routines).map((routine) => routine.command),
    ['rel', 'relatorio-semanal'],
  )
})

test('limits results and never mutates the source list', () => {
  const routines = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    command: `daily-${index}`,
    name: `Daily ${index}`,
  }))
  const snapshot = structuredClone(routines)

  assert.equal(matchSlashQuery('/daily', routines).length, 8)
  assert.deepEqual(routines, snapshot)
})
