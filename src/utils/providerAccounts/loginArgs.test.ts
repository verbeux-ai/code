import { expect, test } from 'bun:test'

import { parseProviderLoginArgs } from './loginArgs.js'

test('accepts an empty command and plain login as additive login', () => {
  expect(parseProviderLoginArgs('')).toEqual({ action: 'login' })
  expect(parseProviderLoginArgs('login')).toEqual({ action: 'login' })
})

test('accepts an explicit reconnect local account id', () => {
  expect(parseProviderLoginArgs('login --reconnect local-account-2')).toEqual({
    action: 'login',
    reconnectLocalAccountId: 'local-account-2',
  })
})

test('accepts status and logout without accepting extra arguments', () => {
  expect(parseProviderLoginArgs('status')).toEqual({ action: 'status' })
  expect(parseProviderLoginArgs('logout')).toEqual({ action: 'logout' })
  expect(parseProviderLoginArgs('status extra')).toEqual({ action: 'invalid' })
})

test('rejects malformed reconnect arguments', () => {
  expect(parseProviderLoginArgs('login --reconnect')).toEqual({ action: 'invalid' })
  expect(parseProviderLoginArgs('login --reconnect a extra')).toEqual({ action: 'invalid' })
  expect(parseProviderLoginArgs('login --unknown value')).toEqual({ action: 'invalid' })
})
