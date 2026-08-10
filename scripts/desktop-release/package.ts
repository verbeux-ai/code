import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import {
  artifactName,
  parseDesktopTarget,
  type DesktopTarget,
} from './contract.js'

export type MaterializePayloadInput = {
  version: string
  target: DesktopTarget
  entrypoint: string
  nodeModules: string
  license: string
  stagingRoot: string
}

export type PackageDesktopCliInput = Omit<MaterializePayloadInput, 'stagingRoot'> & {
  outputDir: string
  nodeExecutable: string
}

export type PackageDesktopCliResult = {
  archivePath: string
  metadataPath: string
  version: string
  target: DesktopTarget
  size: number
  sha256: string
}

const DESKTOP_INTEGRATION_MARKERS = [
  { name: 'TodoWrite', minimum: 2 },
  { name: 'todoFeatureEnabled', minimum: 1 },
  { name: 'todo_reminder', minimum: 2 },
] as const

export function assertDesktopIntegrationContract(entrypoint: string): void {
  for (const { name, minimum } of DESKTOP_INTEGRATION_MARKERS) {
    const occurrences = entrypoint.split(name).length - 1
    if (occurrences < minimum) {
      throw new Error(
        `Desktop integration marker ${JSON.stringify(name)} appears ${occurrences} times; expected at least ${minimum}`,
      )
    }
  }
}

export async function materializePayload(input: MaterializePayloadInput): Promise<string> {
  parseDesktopTarget(input.target)
  assertDesktopIntegrationContract(await readFile(input.entrypoint, 'utf8'))
  const payload = join(
    input.stagingRoot,
    `verboo-cli-${input.version}-${input.target}`,
  )
  await mkdir(join(payload, 'dist'), { recursive: true })
  await cp(input.entrypoint, join(payload, 'dist', 'cli.mjs'), {
    errorOnExist: true,
    force: false,
  })
  await cp(input.nodeModules, join(payload, 'node_modules'), {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  })
  await cp(input.license, join(payload, 'LICENSE'), {
    errorOnExist: true,
    force: false,
  })
  await writeFile(
    join(payload, 'package.json'),
    `${JSON.stringify(
      {
        name: '@verboo/code',
        version: input.version,
        type: 'module',
        engines: { node: '>=24.0.0 <25.0.0' },
        verbooDesktop: {
          schemaVersion: 1,
          target: input.target,
        },
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  )
  await assertRegularPayloadTree(payload)
  await assertNodeIsNotBundled(payload)
  return payload
}

export async function assertRegularPayloadTree(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Payload contains a symbolic link: ${path}`)
      }
      if (metadata.isDirectory()) {
        await visit(path)
        continue
      }
      if (!metadata.isFile()) {
        throw new Error(`Payload contains a non-regular entry: ${path}`)
      }
    }
  }
  await visit(root)
}

export async function packageDesktopCli(
  input: PackageDesktopCliInput,
): Promise<PackageDesktopCliResult> {
  await mkdir(input.outputDir, { recursive: true })
  const stagingRoot = await mkdtemp(join(input.outputDir, '.staging-'))
  const archivePath = join(input.outputDir, artifactName(input.version, input.target))
  const metadataPath = `${archivePath.slice(0, -'.tar.gz'.length)}.metadata.json`

  try {
    const payload = await materializePayload({ ...input, stagingRoot })
    await smokePayload(input.nodeExecutable, payload, input.version)
    await smokeProviderAccounts(input.nodeExecutable, payload)
    await runProcess('tar', [
      '-czf',
      archivePath,
      '-C',
      payload,
      'package.json',
      'LICENSE',
      'dist',
      'node_modules',
    ])
    const { size, sha256 } = await hashFile(archivePath)
    const result: PackageDesktopCliResult = {
      archivePath,
      metadataPath,
      version: input.version,
      target: input.target,
      size,
      sha256,
    }
    await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    return result
  } catch (error) {
    await Promise.all([
      rm(archivePath, { force: true }),
      rm(metadataPath, { force: true }),
    ])
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function assertNodeIsNotBundled(payload: string): Promise<void> {
  for (const name of ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd']) {
    try {
      await lstat(join(payload, name))
      throw new Error(`Payload must not bundle the Node runtime: ${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function smokePayload(
  nodeExecutable: string,
  payload: string,
  version: string,
): Promise<void> {
  const result = await runProcess(
    nodeExecutable,
    [join(payload, 'dist', 'cli.mjs'), '--version'],
    payload,
  )
  const expected = `${version} (Verboo Code)`
  if (result.stdout.trim() !== expected) {
    throw new Error(
      `CLI smoke version mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result.stdout.trim())}`,
    )
  }
}

/**
 * Exercise the versioned provider-account entrypoint on every signed target.
 * Release builders do not have a user's Verboo session, so an auth-required
 * envelope is an expected result; a process crash, malformed JSON, or a
 * different failure is not.
 */
async function smokeProviderAccounts(
  nodeExecutable: string,
  payload: string,
): Promise<void> {
  const result = await runProcess(
    nodeExecutable,
    [join(payload, 'dist', 'cli.mjs'), 'provider-accounts', 'capabilities'],
    payload,
  )
  let envelope: unknown
  try {
    envelope = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error('Provider-account smoke did not return JSON')
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Provider-account smoke returned an invalid envelope')
  }
  const record = envelope as {
    schemaVersion?: unknown
    ok?: unknown
    data?: { protocols?: unknown; secureStorage?: { native?: unknown; backend?: unknown; probe?: unknown } }
    error?: { code?: unknown }
  }
  if (record.schemaVersion !== 1) {
    throw new Error('Provider-account smoke returned an unsupported schema')
  }
  if (record.ok === true) {
    if (!Array.isArray(record.data?.protocols)
      || !record.data.protocols.includes('provider_accounts_v1')) {
      throw new Error('Provider-account smoke omitted provider_accounts_v1')
    }
    if (record.data.secureStorage?.native !== true
      || typeof record.data.secureStorage.backend !== 'string'
      || !['ok', 'missing', 'error'].includes(String(record.data.secureStorage.probe))) {
      throw new Error('Provider-account smoke did not verify native secure storage')
    }
    return
  }
  if (record.ok === false && (
    record.error?.code === 'verboo_auth_required'
    || record.error?.code === 'provider_auth_required'
  )) return
  throw new Error('Provider-account smoke returned an unexpected failure')
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => {
      const bytes = chunk as Buffer
      size += bytes.length
      hash.update(bytes)
    })
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  return { size, sha256: hash.digest('hex') }
}

async function runProcess(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else {
        rejectPromise(
          new Error(
            `${command} exited with ${code ?? 'no status'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ),
        )
      }
    })
  })
}

function readArgument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument: ${name}`)
  return value
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, '..', '..')
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { version: string }
  const target = parseDesktopTarget(readArgument('--target'))
  const outputDir = resolve(readArgument('--output-dir'))
  const nodeExecutable = readArgument('--node-executable')
  const result = await packageDesktopCli({
    version: packageJson.version,
    target,
    entrypoint: join(repositoryRoot, 'dist', 'cli.mjs'),
    nodeModules: join(repositoryRoot, 'node_modules'),
    license: join(repositoryRoot, 'LICENSE'),
    outputDir,
    nodeExecutable,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
