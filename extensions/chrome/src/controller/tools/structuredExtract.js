import { isControllableUrl, nonControllablePageMessage } from '../../planMessage.js'
import { preparePresenceForAction } from '../../presence/inject.js'

const FORMATS = new Set(['json', 'csv', 'table'])

export async function structuredExtract(tool, ctx = {}) {
  const format = FORMATS.has(tool?.format) ? tool.format : 'json'
  const selector = typeof tool?.selector === 'string' && tool.selector.trim()
    ? tool.selector.trim()
    : undefined
  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('structured_extract: no active tab')
  if (!isControllableUrl(tab.url)) throw new Error(nonControllablePageMessage(tab.url))

  await preparePresenceForAction(tab.id, selector)
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractInPage,
    args: [selector ?? null],
  })
  const data = result?.result
  if (!data || typeof data !== 'object') throw new Error('structured_extract: no result from page')
  return {
    format,
    selector,
    url: tab.url ?? '',
    data: format === 'csv' ? toCsv(data) : format === 'table' ? toMarkdownTable(data) : data,
  }
}

function extractInPage(selector) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return { kind: 'text', lines: [] }
  const table = root.matches?.('table') ? root : root.querySelector?.('table')
  if (table) {
    const rows = [...table.querySelectorAll('tr')]
      .map((row) => [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || cell.textContent || '').trim()))
      .filter((row) => row.length > 0)
    const headers = rows[0] ?? []
    const values = rows.slice(1).map((row) => Object.fromEntries(
      headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? '']),
    ))
    return { kind: 'table', headers, rows: values }
  }
  const lines = String(root.innerText || root.textContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return { kind: 'text', lines }
}

function toCsv(data) {
  if (data.kind !== 'table') return data.lines.map(csvCell).join('\n')
  const rows = [data.headers, ...data.rows.map((row) => data.headers.map((header) => row[header] ?? ''))]
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

function toMarkdownTable(data) {
  if (data.kind !== 'table') return data.lines.join('\n')
  const header = `| ${data.headers.join(' | ')} |`
  const divider = `| ${data.headers.map(() => '---').join(' | ')} |`
  const rows = data.rows.map((row) => `| ${data.headers.map((headerName) => row[headerName] ?? '').join(' | ')} |`)
  return [header, divider, ...rows].join('\n')
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === 'number') {
    try {
      const tab = await chrome.tabs.get(preferredTabId)
      if (tab?.id) return tab
    } catch {}
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab ?? null
}

