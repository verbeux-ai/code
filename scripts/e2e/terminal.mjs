import pty from 'node-pty'
import xterm from '@xterm/headless'
import unicode11 from '@xterm/addon-unicode11'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { createFakeRouter } from './fake-router.mjs'
import { CODEX_FIXTURE_README, createCodexFixtureCredentialRecord, createCodexRouter } from './codex-router.mjs'

export async function startCli({ columns = 80, rows = 24, fullscreen = false, usePty = true, slashCommands = false, model = 'fixture-model', args = [], routerOptions, codexOptions, trusted = true, projectFiles = {}, settingSources = 'user' } = {}) {
  const consumer = (await readFile(resolve('.artifacts/package/consumer-path.txt'), 'utf8')).trim()
  const root = resolve('.artifacts/pty')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, `${process.platform}-${process.versions.node}-${columns}x${rows}-`))
  const config = join(dir, 'config')
  const project = join(dir, 'project')
  for (const path of [config, project, join(dir, 'tmp')]) await mkdir(path)
  if (routerOptions?.childToolLoop) {
    await mkdir(join(config, 'agents'))
    await writeFile(join(config, 'agents/fixture-limited.md'), '---\nname: fixture-limited\ndescription: Deterministic bounded fixture agent\nmaxTurns: 1\ntools: Read\n---\nInspect README.md and report.\n')
  }
  const git = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr || 'Could not isolate fixture project')
  await writeFile(join(project, 'README.md'), `${CODEX_FIXTURE_README}\n`)
  for (const [relativePath, contents] of Object.entries(projectFiles)) {
    await mkdir(dirname(join(project, relativePath)), { recursive: true })
    await writeFile(join(project, relativePath), contents)
  }
  const projectConfigKey = project.replaceAll('\\', '/')
  // Untrusted fixtures leave the project out of the config so the workspace
  // trust prompt appears exactly as it does for a freshly cloned repository.
  const projects = trusted ? { [projectConfigKey]: { hasTrustDialogAccepted: true } } : {}
  await writeFile(join(config, '.config.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects }))
  const router = await createFakeRouter(routerOptions)
  const codexRouter = codexOptions ? await createCodexRouter({ projectRoot: project, ...codexOptions }) : undefined
  let codexFixtureBin
  if (codexRouter) {
    if (process.platform !== 'linux') throw new Error('The Codex PTY fixture requires Linux Secret Service; it uses a per-test fake secret-tool executable.')
    codexFixtureBin = join(dir, 'codex-fixture-bin')
    await mkdir(codexFixtureBin)
    const keyringPath = join(dir, 'codex-fixture-keyring.txt')
    const payload = JSON.stringify(createCodexFixtureCredentialRecord())
    await writeFile(keyringPath, `verboo-secure-v1:${deflateRawSync(Buffer.from(payload, 'utf8')).toString('base64')}`)
    const secretToolPath = join(codexFixtureBin, 'secret-tool')
    await writeFile(secretToolPath, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'\nconst file = process.env.CLI_E2E_CODEX_KEYRING\nconst action = process.argv[2]\nif (action === 'lookup') { if (!existsSync(file)) process.exit(1); process.stdout.write(readFileSync(file, 'utf8')); process.exit(0) }\nif (action === 'store') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); writeFileSync(file, Buffer.concat(chunks)); process.exit(0) }\nif (action === 'clear') { if (existsSync(file)) unlinkSync(file); process.exit(0) }\nprocess.exit(2)\n`)
    await chmod(secretToolPath, 0o755)
  }
  await writeFile(join(dir, 'unexpected-network.log'), '')
  // Preserve OS runtime directories required by PowerShell/.NET, while keeping
  // provider credentials and user CLI configuration out of the fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(PATH|SystemRoot|SystemDrive|WINDIR|COMSPEC|PATHEXT|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles(?:\(x86\))?|ProgramW6432|CommonProgramFiles(?:\(x86\))?|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|SHELL)$/i.test(key)))
  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || ''
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  Object.assign(env, {
    PATH: [codexFixtureBin, dirname(process.execPath), inheritedPath].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', FORCE_COLOR: '1',
    VERBOO_DISABLE_PLUGINS: '1', VERBOO_CONFIG_DIR: config, VERBOO_PROJECTS_DIR: join(dir, 'projects'),
    TMPDIR: join(dir, 'tmp'), TMP: join(dir, 'tmp'), TEMP: join(dir, 'tmp'),
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-session', CLAUDE_CODE_NO_FLICKER: fullscreen ? '1' : '0',
    // Background memory extraction makes unrelated model calls after a turn.
    // Keep request counts deterministic for the goal/agent protocol fixtures.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLI_E2E_ORIGIN: router.origin, CLI_E2E_NETWORK_LOG: join(dir, 'unexpected-network.log'),
    CLI_E2E_PROCESS_LOG: join(dir, 'startup-processes.jsonl'),
  })
  if (codexRouter) {
    Object.assign(env, {
      CLI_E2E_CODEX_ORIGIN: codexRouter.origin,
      CLI_E2E_CODEX_KEYRING: join(dir, 'codex-fixture-keyring.txt'),
      OPENAI_MODEL: 'gpt-5.5',
    })
  }
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 5000 })
  terminal.loadAddon(new unicode11.Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  let child
  let stderr = ''
  const cliArgs = ['--import', pathToFileURL(resolve('scripts/e2e/transport-preload.mjs')).href, join(consumer, 'node_modules/@verboo/code/bin/verboo'), '--model', model, '--dangerously-skip-permissions', '--setting-sources', settingSources, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(slashCommands ? [] : ['--disable-slash-commands']), '--debug-file', join(dir, 'debug.log'), ...args]
  try {
    if (usePty) {
      child = pty.spawn(process.execPath, cliArgs, { cwd: project, env, cols: columns, rows, name: 'xterm-256color' })
    } else {
      // Machine-readable output uses pipes in SDK clients. ConPTY transforms
      // long JSON lines into screen redraws, so it cannot validate NDJSON bytes.
      const processChild = spawn(process.execPath, cliArgs, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      processChild.stdout.setEncoding('utf8')
      processChild.stderr.setEncoding('utf8')
      processChild.stderr.on('data', data => { stderr += data })
      await once(processChild, 'spawn')
      // The prompt is supplied in args; signal EOF instead of leaving the CLI
      // to wait for a producer that will never write to stdin.
      processChild.stdin.end()
      child = {
        write() { throw new Error('Piped fixture stdin is closed; supply the prompt in args') },
        kill() { processChild.kill() },
        resize() { throw new Error('A piped CLI has no terminal to resize') },
        onData(callback) { processChild.stdout.on('data', callback) },
        // close runs after stdout/stderr have drained, unlike exit.
        onExit(callback) { processChild.once('close', (exitCode, signal) => callback({ exitCode, signal })) },
      }
    }
  } catch (error) { terminal.dispose(); await router.close(); await codexRouter?.close(); throw error }
  let raw = ''
  const chunks = []
  let exited
  const frames = []
  const screen = () => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n')
  terminal.onData(data => { if (!exited) child.write(data) })
  child.onData(data => {
    raw += data
    chunks.push({ at: Date.now(), text: data })
    terminal.write(data, () => frames.push({ at: Date.now(), columns: terminal.cols, rows: terminal.rows, cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY, text: screen() }))
  })
  const exit = new Promise(resolve => child.onExit(value => { exited = value; resolve(value) }))
  return {
    dir, project, config, router, codexRouter, frames, chunks, screen, get raw() { return raw }, get exited() { return exited }, exit,
    write(data) { child.write(data) },
    resize(cols, rows) { terminal.resize(cols, rows); child.resize(cols, rows) },
    async waitFor(predicate, timeout = 20_000) {
      const start = Date.now()
      while (!await predicate()) {
        if (exited || Date.now() - start > timeout) throw new Error(`CLI condition failed (${JSON.stringify(exited)}); artifacts: ${dir}\n${screen()}`)
        await delay(25)
      }
    },
    async stop() {
      // ConPTY retains its output worker even after the child exits naturally.
      // Release the terminal on Windows as well as stopping live children.
      if (!exited || (usePty && process.platform === 'win32')) child.kill()
      if (!exited) await Promise.race([exit, delay(3000, undefined, { ref: false })])
      await delay(25)
      await writeFile(join(dir, 'terminal.ansi'), raw)
      await writeFile(join(dir, 'terminal-chunks.json'), JSON.stringify(chunks, null, 2))
      await writeFile(join(dir, 'stderr.log'), stderr)
      await writeFile(join(dir, 'frames.json'), JSON.stringify(frames, null, 2))
      await writeFile(join(dir, 'requests.json'), JSON.stringify(router.requests, null, 2))
      if (codexRouter) await writeFile(join(dir, 'codex-requests.json'), JSON.stringify(codexRouter.requests, null, 2))
      await writeFile(join(dir, 'screen.txt'), screen())
      terminal.dispose()
      await router.close()
      await codexRouter?.close()
      const unexpected = await readFile(join(dir, 'unexpected-network.log'), 'utf8')
      if (unexpected || router.unexpected.length || codexRouter?.violations.length) throw new Error(`Unexpected network traffic or invalid Codex protocol; artifacts: ${dir}\n${unexpected}${router.unexpected.join('\n')}${codexRouter?.violations.join('\n') ?? ''}`)
    },
  }
}
