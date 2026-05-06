import { describe, expect, it } from 'bun:test'
import {
  formatCoAuthorTrailer,
  parseCoAuthor,
  stripMatchingQuotes,
  USAGE,
} from './commit-message.js'

describe('commit-message command helpers', () => {
  it('parses quoted co-author names with a plain email', () => {
    expect(parseCoAuthor('"GPT 5.5" noreply@verboo.dev')).toEqual({
      name: 'GPT 5.5',
      email: 'noreply@verboo.dev',
    })
  })

  it('parses co-author trailers with angle-bracket emails', () => {
    expect(parseCoAuthor('Verboo Code (gpt-5.5) <noreply@verboo.dev>')).toEqual(
      {
        name: 'Verboo Code (gpt-5.5)',
        email: 'noreply@verboo.dev',
      },
    )
  })

  it('rejects co-author trailers with empty sanitized names', () => {
    expect(parseCoAuthor('"  " noreply@verboo.dev')).toBeNull()
    expect(parseCoAuthor('"  " <noreply@verboo.dev>')).toBeNull()
  })

  it('strips one pair of matching quotes from custom attribution text', () => {
    expect(stripMatchingQuotes('"Generated with Verboo Code"')).toBe(
      'Generated with Verboo Code',
    )
    expect(stripMatchingQuotes("'Generated with Verboo Code'")).toBe(
      'Generated with Verboo Code',
    )
    expect(stripMatchingQuotes('"Generated with Verboo Code')).toBe(
      '"Generated with Verboo Code',
    )
  })

  it('formats a sanitized co-author trailer', () => {
    expect(
      formatCoAuthorTrailer('Verboo Code <gpt>\n', '<noreply@verboo.dev>'),
    ).toBe('Co-Authored-By: Verboo Code gpt <noreply@verboo.dev>')
  })

  it('makes set scope explicit with example text', () => {
    expect(USAGE).toContain(
      'Controls only the attribution text appended after /commit messages.',
    )
    expect(USAGE).toContain(
      '/commit-message set "Generated with Verboo Code using GPT-5.5"',
    )
    expect(USAGE).not.toContain('/commit-message set-attribution')
  })
})
