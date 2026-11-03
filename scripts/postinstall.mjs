#!/usr/bin/env node
/**
 * Postinstall: garante que o binário `verboo` fique disponível no fish shell.
 *
 * O npm instala globalmente no prefixo retornado por `npm prefix -g` (ex:
 * /usr/local ou ~/.npm-global). Shells bash/zsh geralmente já têm esse bin no
 * PATH via .bashrc/.zshrc, mas o fish não herda essas configs — é preciso
 * chamar `fish_add_path` explicitamente.
 *
 * A instalação não lê nem copia arquivos de outros apps (como ~/.claude): a
 * CLI já lê skills e plugins do Claude Code em modo somente leitura.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function isFishShell(env = process.env) {
  const shell = env.SHELL ?? ''
  const parent = env.FISH_VERSION // set by fish itself
  return shell.endsWith('/fish') || parent !== undefined
}

/**
 * Only a global install by a regular user touches the shell: never as root
 * (it would write root-owned fish config) and never in CI.
 */
export function shouldConfigureShell({
  env = process.env,
  uid = process.getuid?.(),
} = {}) {
  if (uid === 0) return false
  if (env.CI) return false
  if (env.npm_config_global !== 'true') return false
  return isFishShell(env)
}

export function getNpmGlobalBin(exec = execFileSync) {
  try {
    const prefix = exec('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim()
    return join(prefix, 'bin')
  } catch {
    return null
  }
}

/**
 * The directory is passed to fish as an argument, never interpolated into
 * the command string, so a prefix with spaces or shell characters stays a
 * single path.
 */
export function fishAddPath(dir, spawn = spawnSync) {
  const result = spawn('fish', ['-c', 'fish_add_path -- $argv[1]', '--', dir], {
    stdio: 'inherit',
    timeout: 5000,
  })
  return result.status === 0
}

export function main({ env = process.env, write = text => process.stdout.write(text) } = {}) {
  if (shouldConfigureShell({ env })) {
    const binDir = getNpmGlobalBin()
    if (binDir && existsSync(binDir)) {
      if (fishAddPath(binDir)) {
        write(`[verboo] fish_add_path ${binDir} — feito.\n`)
      } else {
        write(
          `[verboo] Não foi possível adicionar ${binDir} ao fish automaticamente.\n` +
          `         Execute manualmente: fish_add_path ${binDir}\n`,
        )
      }
    }
  }

  write('Verboo Code instalado com sucesso!\n')
  write('Para começar, digite verboo no seu terminal.\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
