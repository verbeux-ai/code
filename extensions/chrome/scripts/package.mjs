#!/usr/bin/env node
// Builds the Chrome Web Store zip for verboo-chrome.
// Ships ONLY what the extension needs at runtime — docs, tests, TS sources,
// and native-messaging protocol notes stay out so the store reviewer sees a
// minimal surface. No file is modified; this is copy + zip.
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const version = manifest.version_name ?? manifest.version
const stage = join(root, 'dist', 'stage')
const outZip = join(root, 'dist', `verboo-chrome-${version}.zip`)

// Runtime allowlist — everything else is excluded by construction.
const INCLUDE = ['manifest.json', '_locales', 'icons', 'src', 'privacy.html']
// Non-runtime files that live inside included dirs.
const PRUNE_SUFFIXES = ['.test.js', '.ts', '.md']

rmSync(join(root, 'dist'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

for (const entry of INCLUDE) {
  const from = join(root, entry)
  if (!existsSync(from)) {
    console.error(`[package] missing required entry: ${entry}`)
    process.exit(1)
  }
  cpSync(from, join(stage, entry), {
    recursive: true,
    filter: src => !PRUNE_SUFFIXES.some(sfx => src.endsWith(sfx)) || src === from,
  })
}

execFileSync('zip', ['-r', '-X', outZip, '.'], { cwd: stage, stdio: 'ignore' })
rmSync(stage, { recursive: true, force: true })
console.log(`[package] wrote ${outZip}`)
