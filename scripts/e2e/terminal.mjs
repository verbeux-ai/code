import pty from 'node-pty'
import xterm from '@xterm/headless'
import unicode11 from '@xterm/addon-unicode11'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createFakeRouter } from './fake-router.mjs'
import { CODEX_FIXTURE_README, createCodexFixtureCredentialRecord, createCodexRouter } from './codex-router.mjs'
import { installFakeSecretTool, readKeyringEntries, readKeyringOps, readKeyringRecord, secureStorageAccount, secureStorageServiceName, seedKeyring } from './human/keyring.mjs'
import { createFakeAnthropic } from './human/fake-anthropic.mjs'
import { createFakeOpenAI } from './human/fake-openai.mjs'
import { createInterceptingProxy } from './human/intercept-proxy.mjs'
import { redactRecords } from './human/http.mjs'

/** Escape sequences for cli.press(name). */
export const KEYS = {
  enter: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z', space: ' ', backspace: '\x7f', delete: '\x1b[3~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  'shift-up': '\x1b[1;2A', 'shift-down': '\x1b[1;2B',
  'ctrl-a': '\x01', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-e': '\x05', 'ctrl-l': '\x0c', 'ctrl-o': '\x0f', 'ctrl-r': '\x12', 'ctrl-t': '\x14', 'ctrl-u': '\x15',
}

// Env names a scenario may not remove: without them a run could reach the
// real profile (HOME), the real keyring (PATH order) or the network.
const PROTECTED_ENV = new Set(['HOME', 'PATH', 'CLI_E2E_ORIGIN', 'CLI_E2E_NETWORK_LOG', 'CLI_E2E_KEYRING_DIR'])

// The harness sets these to keep runs quiet; a real user has none of them. Pass
// as unsetEnv to see the traffic a real session produces (see README).
export const REAL_USER_TRAFFIC_ENV = ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY']

async function writeTree(root, files = {}) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents, null, 2))
  }
}

async function provider(option, create) {
  if (!option) return { instance: undefined, owned: false }
  // A fake created by the test (e.g. shared across two runs) is not closed by stop().
  if (typeof option === 'object' && typeof option.origin === 'string' && Array.isArray(option.requests)) return { instance: option, owned: false }
  return { instance: await create(option === true ? {} : option), owned: true }
}

function assertIsolated(path, label) {
  const realHome = resolve(homedir())
  const target = resolve(path)
  const profileDirs = ['.verboo', '.claude', '.openclaude', '.codex', '.config'].map(name => join(realHome, name))
  if (target === realHome || profileDirs.some(dir => target === dir || target.startsWith(`${dir}${sep}`))) throw new Error(`Refusing to run the CLI fixture with ${label} inside the real profile: ${target}`)
}

export async function startCli({
  columns = 80, rows = 24, fullscreen = false, usePty = true, slashCommands = false, model = 'fixture-model', args = [], routerOptions, codexOptions, trusted = true, projectFiles = {}, settingSources = 'user',
  // Human-session options (all optional; see scripts/e2e/human/README.md).
  anthropic, openai, routerHandler, codexHandler, secureStorage, secureStorageError, plainTextCredentials, env: extraEnv = {}, unsetEnv = [],
  plugins = false, skipPermissions = true, userSettings, globalConfig, cwd, extraProjects = {}, homeFiles, configFiles, reuse, failOnSubprocessNetwork = false, allowedNetwork = [], strictMcp = true,
} = {}) {
  const consumer = (await readFile(resolve('.artifacts/package/consumer-path.txt'), 'utf8')).trim()
  for (const name of unsetEnv) if (PROTECTED_ENV.has(name)) throw new Error(`startCli: ${name} cannot be unset (it keeps the fixture isolated); override it with env instead`)
  const root = resolve('.artifacts/pty')
  await mkdir(root, { recursive: true })
  // `reuse: previousCli` continues in the same fixture directory (config,
  // keyring, project, home), like a user restarting the CLI. Its artifacts go to
  // run-<n>/ so the previous run's files are kept.
  const dir = reuse ? reuse.dir : await mkdtemp(join(root, `${process.platform}-${process.versions.node}-${columns}x${rows}-`))
  let runDir = dir
  if (reuse) {
    let run = 2
    while (existsSync(join(dir, `run-${run}`))) run++
    runDir = join(dir, `run-${run}`)
    await mkdir(runDir)
  }
  const home = extraEnv.HOME ?? join(dir, 'home')
  const configDirFromEnv = extraEnv.VERBOO_CONFIG_DIR !== undefined || !unsetEnv.includes('VERBOO_CONFIG_DIR')
  const config = extraEnv.VERBOO_CONFIG_DIR ?? (unsetEnv.includes('VERBOO_CONFIG_DIR') ? join(home, '.verboo') : join(dir, 'config'))
  const projectsDir = extraEnv.VERBOO_PROJECTS_DIR ?? (unsetEnv.includes('VERBOO_PROJECTS_DIR') ? join(config, 'projects') : join(dir, 'projects'))
  assertIsolated(home, 'HOME')
  assertIsolated(config, 'the config dir')
  assertIsolated(projectsDir, 'the projects dir')
  const project = join(dir, 'project')
  const fixtureBin = join(dir, 'fixture-bin')
  const keyringDir = join(dir, 'keyring')
  for (const path of [config, home, join(dir, 'tmp')]) await mkdir(path, { recursive: true })
  if (routerOptions?.childToolLoop) {
    await mkdir(join(config, 'agents'), { recursive: true })
    await writeFile(join(config, 'agents/fixture-limited.md'), '---\nname: fixture-limited\ndescription: Deterministic bounded fixture agent\nmaxTurns: 1\ntools: Read\n---\nInspect README.md and report.\n')
  }
  if (!existsSync(project)) {
    await mkdir(project)
    const git = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' })
    if (git.status !== 0) throw new Error(git.stderr || 'Could not isolate fixture project')
    await writeFile(join(project, 'README.md'), `${CODEX_FIXTURE_README}\n`)
  }
  await writeTree(project, projectFiles)
  const extraProjectPaths = {}
  for (const [name, spec = {}] of Object.entries(extraProjects)) {
    const path = join(dir, 'workspaces', name)
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true })
      if (spec.git !== false) {
        const git = spawnSync('git', ['init', '-q', path], { encoding: 'utf8' })
        if (git.status !== 0) throw new Error(git.stderr || `Could not create extra project ${name}`)
      }
    }
    await writeTree(path, spec.files)
    extraProjectPaths[name] = path
  }
  const workingDir = cwd === undefined ? project : extraProjectPaths[cwd] ?? (isAbsolute(cwd) ? cwd : join(project, cwd))
  assertIsolated(workingDir, 'cwd')
  await mkdir(workingDir, { recursive: true })
  await writeTree(home, homeFiles)
  await writeTree(config, configFiles)
  if (userSettings) await writeFile(join(config, 'settings.json'), JSON.stringify(userSettings, null, 2))
  if (plainTextCredentials) {
    await writeFile(join(config, '.credentials.json'), JSON.stringify(plainTextCredentials), { mode: 0o600 })
  }

  const configKey = path => path.replaceAll('\\', '/')
  // Untrusted fixtures leave the project out of the config so the workspace
  // trust prompt appears exactly as it does for a freshly cloned repository.
  const globalConfigPath = join(config, '.config.json')
  if (!reuse || !existsSync(globalConfigPath)) {
    const projects = trusted ? { [configKey(project)]: { hasTrustDialogAccepted: true } } : {}
    for (const [name, spec = {}] of Object.entries(extraProjects)) if (spec.trusted ?? trusted) projects[configKey(extraProjectPaths[name])] = { hasTrustDialogAccepted: true }
    if (trusted && !workingDir.startsWith(`${project}${sep}`) && workingDir !== project && !Object.values(extraProjectPaths).includes(workingDir)) projects[configKey(workingDir)] = { hasTrustDialogAccepted: true }
    await writeFile(globalConfigPath, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects, ...globalConfig }))
  } else if (globalConfig) {
    const current = JSON.parse(await readFile(globalConfigPath, 'utf8'))
    await writeFile(globalConfigPath, JSON.stringify({ ...current, ...globalConfig }))
  }

  // The fake secret-tool is always first on PATH: no run touches the real keyring.
  await installFakeSecretTool({ binDir: fixtureBin, keyringDir })
  // The CLI env carries USER only when a scenario sets it; otherwise the CLI
  // falls back to the OS account name, exactly like secureStorageAccount.
  const account = secureStorageAccount({ USER: unsetEnv.includes('USER') ? undefined : extraEnv.USER })
  const keyringService = secureStorageServiceName({ configDir: config, configDirFromEnv })
  const router = await createFakeRouter({ ...routerOptions, ...(routerHandler && { routerHandler }) })
  const closers = [() => router.close()]
  let codexRouter, codexProxy, anthropicFake, openaiFake
  try {
    const wantsCodex = codexOptions || codexHandler
    codexRouter = wantsCodex ? await createCodexRouter({ projectRoot: project, ...codexOptions }) : undefined
    if (codexRouter) closers.push(() => codexRouter.close())
    codexProxy = codexRouter && codexHandler ? await createInterceptingProxy({ target: codexRouter.origin, handler: codexHandler }) : undefined
    if (codexProxy) closers.push(() => codexProxy.close())
    const anthropicProvider = await provider(anthropic, createFakeAnthropic)
    anthropicFake = anthropicProvider.instance
    if (anthropicProvider.owned) closers.push(() => anthropicFake.close())
    const openaiProvider = await provider(openai, createFakeOpenAI)
    openaiFake = openaiProvider.instance
    if (openaiProvider.owned) closers.push(() => openaiFake.close())
    if ((codexRouter || secureStorage) && process.platform !== 'linux') throw new Error('Seeding secure storage requires Linux Secret Service; it uses a per-test fake secret-tool executable.')
    if (codexRouter || secureStorage) {
      const current = reuse ? await readKeyringRecord({ keyringDir, service: keyringService, account }) : null
      const data = { ...current, ...(codexRouter && createCodexFixtureCredentialRecord()), ...secureStorage }
      await seedKeyring({ keyringDir, service: keyringService, account, data })
    }
  } catch (error) {
    for (const close of closers.reverse()) await close().catch(() => {})
    throw error
  }

  await writeFile(join(runDir, 'unexpected-network.log'), '')
  await writeFile(join(runDir, 'subprocess-network.log'), '')
  // Preserve OS runtime directories required by PowerShell/.NET, while keeping
  // provider credentials and user CLI configuration out of the fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(PATH|SystemRoot|SystemDrive|WINDIR|COMSPEC|PATHEXT|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles(?:\(x86\))?|ProgramW6432|CommonProgramFiles(?:\(x86\))?|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|SHELL)$/i.test(key)))
  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || ''
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  const pathSeparator = process.platform === 'win32' ? ';' : ':'
  Object.assign(env, {
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', FORCE_COLOR: '1',
    HOME: home,
    VERBOO_CONFIG_DIR: config, VERBOO_PROJECTS_DIR: projectsDir,
    TMPDIR: join(dir, 'tmp'), TMP: join(dir, 'tmp'), TEMP: join(dir, 'tmp'),
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-session', CLAUDE_CODE_NO_FLICKER: fullscreen ? '1' : '0',
    // Background memory extraction makes unrelated model calls after a turn.
    // Keep request counts deterministic for the goal/agent protocol fixtures.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    ...(!plugins && { VERBOO_DISABLE_PLUGINS: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' }),
    CLI_E2E_ORIGIN: router.origin, CLI_E2E_NETWORK_LOG: join(runDir, 'unexpected-network.log'),
    CLI_E2E_PROCESS_LOG: join(runDir, 'startup-processes.jsonl'),
    CLI_E2E_SUBPROCESS_NETWORK_LOG: join(runDir, 'subprocess-network.log'),
    CLI_E2E_KEYRING_DIR: keyringDir, CLI_E2E_BROWSER_LOG: join(runDir, 'browser-opens.log'),
    // Subprocess network guard: git and package managers cannot leave the machine.
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', npm_config_update_notifier: 'false',
    ...(secureStorageError && { CLI_E2E_KEYRING_ERROR: typeof secureStorageError === 'string' ? secureStorageError : 'Cannot autolaunch D-Bus without X11 $DISPLAY' }),
  })
  if (codexRouter) {
    Object.assign(env, {
      CLI_E2E_CODEX_ORIGIN: (codexProxy ?? codexRouter).origin,
      OPENAI_MODEL: 'gpt-5.5',
    })
  }
  if (anthropicFake) env.CLI_E2E_ANTHROPIC_ORIGIN = anthropicFake.origin
  if (openaiFake) env.CLI_E2E_OPENAI_ORIGIN = openaiFake.origin
  const { PATH: scenarioPath, ...scenarioEnv } = extraEnv
  Object.assign(env, scenarioEnv)
  for (const name of unsetEnv) delete env[name]
  env.PATH = [fixtureBin, dirname(process.execPath), scenarioPath ?? inheritedPath].filter(Boolean).join(pathSeparator)

  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 5000 })
  terminal.loadAddon(new unicode11.Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  let child
  let stderr = ''
  const cliArgs = ['--import', pathToFileURL(resolve('scripts/e2e/transport-preload.mjs')).href, join(consumer, 'node_modules/@verboo/code/bin/verboo'), ...(model === null ? [] : ['--model', model]), ...(skipPermissions ? ['--dangerously-skip-permissions'] : []), ...(settingSources === null ? [] : ['--setting-sources', settingSources]), ...(strictMcp ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : []), ...(slashCommands ? [] : ['--disable-slash-commands']), '--debug-file', join(runDir, 'debug.log'), ...args]
  try {
    if (usePty) {
      child = pty.spawn(process.execPath, cliArgs, { cwd: workingDir, env, cols: columns, rows, name: 'xterm-256color' })
    } else {
      // Machine-readable output uses pipes in SDK clients. ConPTY transforms
      // long JSON lines into screen redraws, so it cannot validate NDJSON bytes.
      const processChild = spawn(process.execPath, cliArgs, { cwd: workingDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
  } catch (error) { terminal.dispose(); for (const close of closers.reverse()) await close().catch(() => {}); throw error }
  let raw = ''
  const chunks = []
  let exited
  const frames = []
  const screen = () => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n')
  const normalize = text => text.replace(/\s+/g, ' ')
  const matches = (text, pattern) => pattern instanceof RegExp ? pattern.test(text) : normalize(text).includes(normalize(pattern))
  terminal.onData(data => { if (!exited) child.write(data) })
  child.onData(data => {
    raw += data
    chunks.push({ at: Date.now(), text: data })
    terminal.write(data, () => frames.push({ at: Date.now(), columns: terminal.cols, rows: terminal.rows, cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY, text: screen() }))
  })
  const exit = new Promise(resolve => child.onExit(value => { exited = value; resolve(value) }))
  const readText = path => readFile(path, 'utf8').catch(() => '')
  const cli = {
    dir, runDir, project, cwd: workingDir, config, home, projectsDir, keyringDir, extraProjects: extraProjectPaths, env,
    router, codexRouter, codexProxy, anthropic: anthropicFake, openai: openaiFake,
    frames, chunks, screen, get raw() { return raw }, get exited() { return exited }, exit,
    write(data) { child.write(data) },
    resize(cols, rows) { terminal.resize(cols, rows); child.resize(cols, rows) },
    async waitFor(predicate, timeout = 20_000) {
      const start = Date.now()
      while (!await predicate()) {
        if (exited || Date.now() - start > timeout) throw new Error(`CLI condition failed (${JSON.stringify(exited)}); artifacts: ${runDir}\n${screen()}`)
        await delay(25)
      }
    },
    /** Screen text with whitespace collapsed (wrapped lines join with a space). */
    screenText: () => normalize(screen()),
    /**
     * Waits until `pattern` (string, whitespace-insensitive, or RegExp) is on the
     * current screen or in any frame rendered after this call started.
     */
    async waitForText(pattern, timeout = 60_000) {
      let next = frames.length
      await cli.waitFor(() => {
        if (matches(screen(), pattern)) return true
        for (; next < frames.length; next++) if (matches(frames[next].text, pattern)) return true
        return false
      }, timeout)
    },
    /** Types text; with delayMs > 0 sends one character at a time like a person. */
    async type(text, { delayMs = 0 } = {}) {
      if (!delayMs) return child.write(text)
      for (const character of text) { child.write(character); await delay(delayMs) }
    },
    /** Presses a named key from KEYS (or a raw sequence), `times` times. */
    async press(key, times = 1) {
      const sequence = KEYS[key] ?? key
      for (let index = 0; index < times; index++) { child.write(sequence); if (times > 1) await delay(30) }
    },
    /** Types text, lets the input settle (no paste detection), then presses Enter. */
    async submit(text, { delayMs = 0, settleMs = 250 } = {}) {
      await cli.type(text, { delayMs })
      await delay(settleMs)
      child.write('\r')
    },
    /** Decoded credentials record the CLI keeps in the (fake) keyring, or null. */
    readSecureStorage: () => readKeyringRecord({ keyringDir, service: keyringService, account }),
    /** Every keyring entry: [{ attributes, label, raw, data }]. */
    readKeyring: () => readKeyringEntries(keyringDir),
    /** Every secret-tool call made so far: [{ action, attributes }]. */
    keyringOps: () => readKeyringOps(keyringDir),
    /** <config>/.credentials.json parsed, or null when absent. */
    async readPlainTextCredentials() { const text = await readText(join(config, '.credentials.json')); return text ? JSON.parse(text) : null },
    /** In-process HTTP(S) requests blocked by the network guard so far (stop() fails when non-empty). */
    async networkLog() { return (await readText(join(runDir, 'unexpected-network.log'))).split('\n').filter(Boolean) },
    /**
     * Network-capable subprocesses the CLI started (e.g. "npm view", "git clone https://host/path").
     * They run offline (git/npm network is disabled in the fixture env); stop()
     * fails on them only with failOnSubprocessNetwork: true.
     */
    async subprocessNetworkLog() { return (await readText(join(runDir, 'subprocess-network.log'))).split('\n').filter(Boolean) },
    /** URLs the CLI tried to open in a browser (fake xdg-open/open). */
    async browserOpens() { return (await readText(join(runDir, 'browser-opens.log'))).split('\n').filter(Boolean) },
    async stop() {
      // ConPTY retains its output worker even after the child exits naturally.
      // Release the terminal on Windows as well as stopping live children.
      if (!exited || (usePty && process.platform === 'win32')) child.kill()
      if (!exited) await Promise.race([exit, delay(3000, undefined, { ref: false })])
      await delay(25)
      await writeFile(join(runDir, 'terminal.ansi'), raw)
      await writeFile(join(runDir, 'terminal-chunks.json'), JSON.stringify(chunks, null, 2))
      await writeFile(join(runDir, 'stderr.log'), stderr)
      await writeFile(join(runDir, 'frames.json'), JSON.stringify(frames, null, 2))
      await writeFile(join(runDir, 'requests.json'), JSON.stringify(router.requests, null, 2))
      await writeFile(join(runDir, 'router-requests-all.json'), JSON.stringify(redactRecords(router.allRequests), null, 2))
      if (codexRouter) await writeFile(join(runDir, 'codex-requests.json'), JSON.stringify(codexRouter.requests, null, 2))
      if (codexProxy) await writeFile(join(runDir, 'codex-proxy-requests.json'), JSON.stringify(redactRecords(codexProxy.requests), null, 2))
      if (anthropicFake) await writeFile(join(runDir, 'anthropic-requests.json'), JSON.stringify(redactRecords(anthropicFake.requests.map(({ raw: _raw, ...record }) => record)), null, 2))
      if (openaiFake) await writeFile(join(runDir, 'openai-requests.json'), JSON.stringify(redactRecords(openaiFake.requests.map(({ raw: _raw, ...record }) => record)), null, 2))
      await writeFile(join(runDir, 'screen.txt'), screen())
      terminal.dispose()
      for (const close of [...closers].reverse()) await close()
      closers.length = 0
      // allowedNetwork only stops stop() from failing: the requests stay blocked and logged.
      const isAllowed = entry => allowedNetwork.some(pattern => new RegExp(pattern).test(entry))
      const unexpected = (await readFile(join(runDir, 'unexpected-network.log'), 'utf8')).split('\n').filter(Boolean)
      if (failOnSubprocessNetwork) unexpected.push(...(await readText(join(runDir, 'subprocess-network.log'))).split('\n').filter(Boolean).map(line => `SPAWN ${line}`))
      const problems = [...unexpected,
        ...router.unexpected,
        ...(codexRouter?.violations ?? []),
        ...(codexProxy?.unexpected ?? []),
        ...(anthropicFake?.unexpected ?? []).map(entry => `anthropic: ${entry}`),
        ...(openaiFake?.unexpected ?? []).map(entry => `openai: ${entry}`),
      ].filter(entry => !isAllowed(entry))
      if (problems.length) throw new Error(`Unexpected network traffic or invalid fixture protocol; artifacts: ${runDir}\n${problems.join('\n')}`)
    },
  }
  return cli
}
