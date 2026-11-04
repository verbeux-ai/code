import { expect, test } from 'bun:test'
import { redactProviderKeyInCommand } from './providerKeyRedaction.js'

test('a key typed after /claude or /openai is removed', () => {
  expect(redactProviderKeyInCommand('/claude login sk-ant-api03-abcdefgh')).toBe('/claude login ***')
  expect(redactProviderKeyInCommand('/openai login sk-proj-abcdefgh')).toBe('/openai login ***')
  expect(redactProviderKeyInCommand('  /openai sk-abcdefghijk')).toBe('  /openai ***')
})

test('subcommands and everything else stay as typed', () => {
  expect(redactProviderKeyInCommand('/claude status')).toBe('/claude status')
  expect(redactProviderKeyInCommand('explique o prefixo sk-abcdefghijk')).toBe('explique o prefixo sk-abcdefghijk')
  expect(redactProviderKeyInCommand('/claudette sk-abcdefghijk')).toBe('/claudette sk-abcdefghijk')
})
