// Fake Linux Secret Service for PTY fixtures. startCli always puts the fake
// `secret-tool` first on PATH, so no fixture run can read or write the real
// GNOME keyring / KWallet. Each entry lives in <dir>/keyring/<key>.secret
// (exactly what the CLI stored) with its attributes in <key>.attrs; every
// operation is appended to <dir>/keyring/ops.log (action and attributes only,
// never the secret).
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const PAYLOAD_PREFIX = 'verboo-secure-v1:'

// Same encoding as src/utils/secureStorage/linuxSecretStorage.ts.
export function encodeSecureStoragePayload(data) {
  return `${PAYLOAD_PREFIX}${deflateRawSync(Buffer.from(JSON.stringify(data), 'utf8')).toString('base64')}`
}

export function decodeSecureStoragePayload(payload) {
  const text = payload.trim()
  if (!text.startsWith(PAYLOAD_PREFIX)) return JSON.parse(text)
  return JSON.parse(inflateRawSync(Buffer.from(text.slice(PAYLOAD_PREFIX.length), 'base64')).toString('utf8'))
}

/**
 * Service name the CLI uses for its credentials record (see
 * getSecureStorageServiceName): a hash of the config dir is appended only when
 * VERBOO_CONFIG_DIR is set.
 */
export function secureStorageServiceName({ configDir, configDirFromEnv = true }) {
  const hash = configDirFromEnv ? `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}` : ''
  return `Verboo Code-credentials${hash}`
}

export function secureStorageAccount(env = process.env) {
  try { return env.USER || userInfo().username } catch { return 'verboo-code-user' }
}

// Filesystem-safe, reversible key for an attribute set. Must match the shell
// script below (sorted attribute pairs, base64url).
function entryKey(attributes) {
  const text = Object.keys(attributes).sort().map(name => `${name}=${attributes[name]};`).join('')
  return Buffer.from(text, 'utf8').toString('base64').replaceAll('/', '_').replaceAll('+', '-').replaceAll('=', '.')
}

const SECRET_TOOL = `#!/bin/sh
# Fake secret-tool for CLI e2e fixtures (scripts/e2e/human/keyring.mjs).
# It never talks to D-Bus; entries live in $CLI_E2E_KEYRING_DIR.
dir="$CLI_E2E_KEYRING_DIR"
if [ -z "$dir" ]; then echo "fake secret-tool: CLI_E2E_KEYRING_DIR is not set" >&2; exit 2; fi
action="$1"
[ $# -gt 0 ] && shift
label=""
pairs=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) label="$2"; shift; [ $# -gt 0 ] && shift ;;
    --label=*) label="\${1#--label=}"; shift ;;
    *) pairs="$pairs$1=$2;
"; shift; [ $# -gt 0 ] && shift ;;
  esac
done
attrs=$(printf '%s' "$pairs" | LC_ALL=C sort | tr -d '\\n')
key=$(printf '%s' "$attrs" | base64 -w0 | LC_ALL=C tr '/=+' '_.-')
printf '%s\\t%s\\n' "$action" "$attrs" >> "$dir/ops.log"
if [ -n "$CLI_E2E_KEYRING_ERROR" ]; then
  echo "$CLI_E2E_KEYRING_ERROR" >&2
  exit 3
fi
case "$action" in
  lookup)
    [ -f "$dir/$key.secret" ] || exit 1
    cat "$dir/$key.secret"
    exit 0 ;;
  store)
    cat > "$dir/$key.secret.tmp" && mv "$dir/$key.secret.tmp" "$dir/$key.secret" || exit 4
    printf '%s' "$attrs" > "$dir/$key.attrs"
    printf '%s' "$label" > "$dir/$key.label"
    exit 0 ;;
  clear)
    rm -f "$dir/$key.secret" "$dir/$key.attrs" "$dir/$key.label"
    exit 0 ;;
  *)
    echo "usage: secret-tool store --label='Label' attribute value ..." >&2
    echo "       secret-tool lookup attribute value ..." >&2
    echo "       secret-tool clear attribute value ..." >&2
    exit 2 ;;
esac
`

// Fake browser openers: record the URL instead of launching a browser.
const BROWSER = `#!/bin/sh
printf '%s\\n' "$*" >> "$CLI_E2E_BROWSER_LOG"
exit 0
`

/** Writes the fake secret-tool (+ xdg-open/open) into binDir. */
export async function installFakeSecretTool({ binDir, keyringDir }) {
  await mkdir(binDir, { recursive: true })
  await mkdir(keyringDir, { recursive: true })
  await writeFile(join(keyringDir, 'ops.log'), '', { flag: 'a' })
  for (const [name, body] of [['secret-tool', SECRET_TOOL], ['xdg-open', BROWSER], ['open', BROWSER]]) {
    await writeFile(join(binDir, name), body)
    await chmod(join(binDir, name), 0o755)
  }
}

/** Stores `data` (the SecureStorageData object) for the CLI's service/account. */
export async function seedKeyring({ keyringDir, service, account, data }) {
  await mkdir(keyringDir, { recursive: true })
  const attributes = { account, service }
  const key = entryKey(attributes)
  const attrs = Object.keys(attributes).sort().map(name => `${name}=${attributes[name]};`).join('')
  await writeFile(join(keyringDir, `${key}.secret`), encodeSecureStoragePayload(data))
  await writeFile(join(keyringDir, `${key}.attrs`), attrs)
  await writeFile(join(keyringDir, `${key}.label`), service)
}

function parseAttrs(text) {
  return Object.fromEntries(text.split(';').filter(Boolean).map(pair => {
    const index = pair.indexOf('=')
    return [pair.slice(0, index), pair.slice(index + 1)]
  }))
}

/** All entries: [{ attributes, label, raw, data }] (data is decoded JSON or undefined). */
export async function readKeyringEntries(keyringDir) {
  if (!existsSync(keyringDir)) return []
  const entries = []
  for (const file of (await readdir(keyringDir)).filter(name => name.endsWith('.secret')).sort()) {
    const key = file.slice(0, -'.secret'.length)
    const raw = await readFile(join(keyringDir, file), 'utf8')
    const attrs = await readFile(join(keyringDir, `${key}.attrs`), 'utf8').catch(() => '')
    const label = await readFile(join(keyringDir, `${key}.label`), 'utf8').catch(() => '')
    let data
    try { data = decodeSecureStoragePayload(raw) } catch { data = undefined }
    entries.push({ attributes: parseAttrs(attrs), label, raw, data })
  }
  return entries
}

/** The decoded record for one service/account, or null when absent. */
export async function readKeyringRecord({ keyringDir, service, account }) {
  const file = join(keyringDir, `${entryKey({ account, service })}.secret`)
  if (!existsSync(file)) return null
  return decodeSecureStoragePayload(await readFile(file, 'utf8'))
}

/** [{ action, attributes }] for every secret-tool call, in order. */
export async function readKeyringOps(keyringDir) {
  const text = await readFile(join(keyringDir, 'ops.log'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(line => {
    const [action, attrs = ''] = line.split('\t')
    return { action, attributes: parseAttrs(attrs) }
  })
}

// ---- Credential record builders (shapes from src/utils/*Credentials.ts) ----

/** `claudeNative` value for an Anthropic API key (what /claude login stores). */
export function claudeApiKeyCredential(apiKey) {
  const trimmed = apiKey.trim()
  return {
    authType: 'api-key',
    apiKey: trimmed,
    accountId: `anthropic-key-${createHash('sha256').update(trimmed).digest('hex').slice(0, 16)}`,
    keyHint: trimmed.slice(-4),
  }
}

/** Retired Claude subscription (OAuth) blob, for testing its removal on startup. */
export function claudeLegacyOAuthCredential({ accessToken = 'fixture-claude-oauth-access', accountId = 'fixture-claude-account', email = 'fixture@example.test' } = {}) {
  return {
    accessToken,
    refreshToken: 'fixture-claude-oauth-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    accountId,
    email,
    riskAcceptance: { version: 1, acceptedAt: '2026-01-01T00:00:00.000Z', accountId },
  }
}

/** `githubModels` value (retired Copilot login), for testing its purge on startup; valid in the keyring and in .credentials.json. */
export function githubModelsCredential(accessToken = 'fixture-copilot-token') {
  return { accessToken }
}

/** `openaiApiKey` value for an OpenAI API key (what /openai login stores). */
export function openaiApiKeyCredential(apiKey) {
  const trimmed = apiKey.trim()
  return { apiKey: trimmed, keyHint: trimmed.slice(-4) }
}
