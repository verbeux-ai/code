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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

process.stdout.write('Verboo Code instalado com sucesso!\n')
process.stdout.write('Para começar, digite verboo no seu terminal.\n')
