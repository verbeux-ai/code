#!/usr/bin/env node
/**
 * Postinstall: garante que o binário `verboo` fique disponível no fish shell.
 *
 * O npm instala globalmente no prefixo retornado por `npm prefix -g` (ex:
 * /usr/local ou ~/.npm-global). Shells bash/zsh geralmente já têm esse bin no
 * PATH via .bashrc/.zshrc, mas o fish não herda essas configs — é preciso
 * chamar `fish_add_path` explicitamente.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'os'

function isFishShell() {
  const shell = process.env.SHELL ?? ''
  const parent = process.env.FISH_VERSION // set by fish itself
  return shell.endsWith('/fish') || parent !== undefined
}

function getNpmGlobalBin() {
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim()
    return join(prefix, 'bin')
  } catch {
    return null
  }
}

function fishAddPath(dir) {
  const result = spawnSync('fish', ['-c', `fish_add_path ${dir}`], {
    stdio: 'inherit',
    timeout: 5000,
  })
  return result.status === 0
}

function copyDirRecursive(src, dest) {
  let copied = false
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    if (existsSync(destPath)) continue
    const stat = statSync(srcPath)
    if (stat.isDirectory()) {
      if (copyDirRecursive(srcPath, destPath)) copied = true
    } else {
      copyFileSync(srcPath, destPath)
      copied = true
    }
  }
  return copied
}

function importFromClaudeCode() {
  const claude = join(homedir(), '.claude')
  const verboo = join(homedir(), '.verboo')
  for (const asset of ['skills', 'plugins']) {
    const src = join(claude, asset)
    const dest = join(verboo, asset)
    if (!existsSync(src)) continue
    try {
      if (copyDirRecursive(src, dest)) {
        process.stdout.write(`[verboo] ${asset} imported from Claude Code.\n`)
      }
    } catch (err) {
      process.stdout.write(`[verboo] Import of ${asset} from Claude Code failed: ${err.message}. Proceeding without import.\n`)
    }
  }
}

if (isFishShell()) {
  const binDir = getNpmGlobalBin()
  if (binDir && existsSync(binDir)) {
    const ok = fishAddPath(binDir)
    if (ok) {
      process.stdout.write(`[verboo] fish_add_path ${binDir} — feito.\n`)
    } else {
      process.stdout.write(
        `[verboo] Não foi possível adicionar ${binDir} ao fish automaticamente.\n` +
        `         Execute manualmente: fish_add_path ${binDir}\n`,
      )
    }
  }
}

importFromClaudeCode()

process.stdout.write('Verboo Code instalado com sucesso!\n')
process.stdout.write('Para começar, digite verboo no seu terminal.\n')
