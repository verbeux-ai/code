import { MSG } from '../controller/protocol.js'
import { replayRecordedSteps } from './replay.js'

/**
 * Resolve, validate, queue, and execute a saved routine.
 */
export function createRoutineRunner({
  routinesStore,
  runStore,
  queue,
  loadSession,
  loadModels,
  getSelectedModelId,
  getActiveTabMeta,
  runAgent,
  executeRecordedStep,
  assetsStore,
  broadcast,
  cryptoImpl = globalThis.crypto,
}) {
  const controls = new Map()

  async function run(request) {
    const context = await resolveContext(request)
    const { accountId, routine, modelId } = context
    const runId = cryptoImpl.randomUUID()
    let runRecord = await runStore.create(accountId, {
      id: runId,
      routineId: routine.id,
      routineRevision: routine.revision,
      modelId,
      variables: cloneValue(request?.variables ?? {}),
      source: request?.source ?? 'manual',
      ...(Number.isInteger(request?.senderTabId)
        ? { senderTabId: request.senderTabId }
        : {}),
      ...(request?.occurrenceKey ? { occurrenceKey: request.occurrenceKey } : {}),
      mode: request?.simulate === true ? 'simulation' : 'live',
      targetTab: summarizeTargetTab(context.activeTab),
      events: [{
        type: 'created',
        mode: request?.simulate === true ? 'simulation' : 'live',
        targetTab: summarizeTargetTab(context.activeTab),
      }],
    })
    runRecord = await transition(accountId, runId, 'ready')
    runRecord = await transition(accountId, runId, 'queued')
    return enqueueExecution(context, runRecord, request, 0)
  }

  async function resume(accountId, runId, request = {}) {
    const runRecord = await runStore.get(accountId, runId)
    if (!runRecord) throw new Error('routine_run_not_found')
    if (runRecord.status !== 'queued') throw new Error('routine_run_not_queued')
    const resumedRequest = {
      ...request,
      routineId: runRecord.routineId,
      expectedRevision: runRecord.routineRevision,
      variables: cloneValue(runRecord.variables ?? {}),
      modelId: runRecord.modelId,
      source: runRecord.source,
      senderTabId: request.senderTabId ?? runRecord.senderTabId,
      occurrenceKey: runRecord.occurrenceKey,
    }
    const context = await resolveContext(resumedRequest, accountId)
    return enqueueExecution(
      context,
      runRecord,
      resumedRequest,
      Number.isInteger(runRecord.checkpointIndex) ? runRecord.checkpointIndex : 0,
    )
  }

  async function resolveContext(request, requiredAccountId) {
    const session = await loadSession()
    const accountId = String(session?.accountId ?? '').trim()
    if (!accountId || !session?.accessToken) throw new Error('auth_required')
    if (requiredAccountId && accountId !== requiredAccountId) {
      throw new Error('routine_account_mismatch')
    }

    const routine = await routinesStore.get(accountId, request?.routineId)
    if (!routine) throw new Error('routine_not_found')
    if (routine.revision !== request?.expectedRevision) {
      throw new Error('routine_revision_conflict')
    }

    const baseInstructions = resolveInstructions(routine, request?.variables)
    const instructions = await expandSubroutineInstructions(routinesStore, accountId, routine, baseInstructions)
    const simulation = request?.simulate === true
    const modelId = simulation
      ? (routine.modelId || request?.modelId || 'simulation')
      : (routine.modelId || request?.modelId || await getSelectedModelId())
    const models = simulation ? [] : await loadModels(false)
    const model = simulation
      ? { id: modelId, supportsVision: false }
      : models.find((item) => item.id === modelId)
    if (!simulation && !model) throw new Error('routine_model_missing')
    if (!simulation && routineNeedsVision(routine) && model.supportsVision !== true) {
      throw new Error('routine_model_requires_vision')
    }

    const activeTab = await getActiveTabMeta(request?.senderTabId)
    validateAllowedSite(routine, activeTab?.url)
    const assets = assetsStore
      ? (await Promise.all(
          (routine.assets ?? []).map((asset) => assetsStore.get(accountId, asset.id)),
        )).filter(Boolean)
      : cloneValue(routine.assets ?? [])
    return {
      accountId,
      session,
      routine,
      instructions,
      modelId,
      model,
      activeTab,
      assets,
    }
  }

  function enqueueExecution(context, runRecord, request, startIndex) {
    const {
      accountId,
      session,
      routine,
      instructions,
      modelId,
      model,
      activeTab,
      assets,
    } = context
    const runId = runRecord.id
    const controller = new AbortController()
    const control = { controller, pauseRequested: false }
    controls.set(runId, control)
    const completion = queue.enqueue({
      id: runId,
      cancel: () => controller.abort(),
      pause: () => {
        control.pauseRequested = true
        controller.abort()
      },
      execute: async () => {
        const startedAt = Date.now()
        try {
          await transition(accountId, runId, 'running', { startedAt })
          await appendEvent(accountId, runId, {
            type: 'started',
            targetTab: summarizeTargetTab(activeTab),
          })

          if (request?.simulate === true) {
            const plan = buildSimulationPlan(routine)
            await appendEvent(accountId, runId, {
              type: 'simulation',
              steps: plan,
            })
            return transition(accountId, runId, 'completed', {
              finishedAt: Date.now(),
              durationMs: Date.now() - startedAt,
              assistantMessage: simulationMessage(routine, plan),
              simulation: true,
              toolResults: [],
            })
          }
          let runtimeInstructions = instructions
          if (routine.branch && typeof executeRecordedStep === 'function') {
            const branchResult = await executeRecordedStep(
              {
                id: cryptoImpl.randomUUID(),
                name: 'read_page',
                params: { selector: routine.branch.selector },
                reasoning: 'Checking the saved routine condition.',
              },
              {
                ...request,
                runId,
                routineAllowedOrigins: routine.allowedOrigins ?? [],
              },
              controller.signal,
            )
            if (!branchResult?.ok) throw new Error(branchResult?.error ?? 'routine_branch_probe_failed')
            const probeText = branchText(branchResult.result)
            const matched = probeText.toLocaleLowerCase().includes(routine.branch.contains.toLocaleLowerCase())
            const selected = matched ? routine.branch.thenInstructions : routine.branch.elseInstructions
            await appendEvent(accountId, runId, {
              type: 'conditional',
              matched,
              selector: routine.branch.selector,
            })
            if (selected) runtimeInstructions = `${runtimeInstructions}\n\nCONDITIONAL BRANCH:\n${selected}`
          }
          const agentInput = {
            turnId: runId,
            userMessage: routineRunPrompt(routine),
            accessToken: session.accessToken,
            modelId,
            modelSupportsVision: model.supportsVision === true,
            routineContext: {
              name: routine.name,
              instructions: runtimeInstructions,
              assets,
            },
            routineAllowedOrigins: cloneValue(routine.allowedOrigins ?? []),
            senderTabId: request?.senderTabId,
            signal: controller.signal,
          }
          let result
          let recoverySuggestion

          if ((routine.recordedSteps ?? []).length > 0) {
            if (typeof executeRecordedStep !== 'function') {
              throw new Error('routine_replay_unavailable')
            }
            if (
              startIndex === 0 &&
              routine.startUrl &&
              activeTab?.url !== routine.startUrl
            ) {
              const navigation = await executeRecordedStep(
                {
                  id: cryptoImpl.randomUUID(),
                  name: 'navigate',
                  params: { url: routine.startUrl },
                  reasoning: 'Opening the recorded routine start page.',
                },
                {
                  ...request,
                  runId,
                  routineAllowedOrigins: routine.allowedOrigins ?? [],
                },
                controller.signal,
              )
              if (!navigation?.ok) {
                throw new Error(navigation?.error ?? 'routine_start_navigation_failed')
              }
            }

            const replay = await replayRecordedSteps({
              steps: routine.recordedSteps,
              startIndex,
              execute: (toolCall) =>
                executeRecordedStep(
                  toolCall,
                  {
                    ...request,
                    runId,
                    routineAllowedOrigins: routine.allowedOrigins ?? [],
                  },
                  controller.signal,
                ),
              checkpoint: async (checkpointIndex) => {
                await runStore.patch?.(accountId, runId, { checkpointIndex })
              },
              signal: controller.signal,
            })
            if (replay.status === 'completed') {
              result = {
                assistantMessage: 'Recorded routine completed.',
                toolResults: [],
              }
            } else {
              const failedStep = replay.failure.step
              result = await runAgent({
                ...agentInput,
                userMessage: recoveryPrompt(routine, replay.failure),
                routineContext: {
                  ...agentInput.routineContext,
                  instructions: recoveryInstructions(runtimeInstructions, replay.failure),
                },
                toolAllowlist: recoveryToolAllowlist(
                  failedStep.name,
                  model.supportsVision === true,
                ),
              })
              recoverySuggestion = findRecoverySuggestion(
                replay.failure,
                result?.toolResults,
                routine.revision,
              )
            }
          } else {
            result = await runAgent(agentInput)
          }
          for (const toolResult of result?.toolResults ?? []) {
            await appendEvent(accountId, runId, {
              type: 'tool',
              name: toolResult?.name,
              success: toolResult?.success === true,
              durationMs: Number(toolResult?.durationMs ?? 0),
              ...(toolResult?.error ? { error: String(toolResult.error) } : {}),
              ...(toolResult?.params ? { params: cloneValue(toolResult.params) } : {}),
            })
          }
          if (routine.output?.format && typeof executeRecordedStep === 'function') {
            const extraction = await executeRecordedStep(
              {
                id: cryptoImpl.randomUUID(),
                name: 'structured_extract',
                params: {
                  format: routine.output.format,
                  ...(routine.output.selector ? { selector: routine.output.selector } : {}),
                },
                reasoning: 'Formatting the requested structured routine output.',
              },
              {
                ...request,
                runId,
                routineAllowedOrigins: routine.allowedOrigins ?? [],
              },
              controller.signal,
            )
            if (!extraction?.ok) throw new Error(extraction?.error ?? 'routine_structured_extract_failed')
            await appendEvent(accountId, runId, {
              type: 'tool',
              name: 'structured_extract',
              success: true,
              params: cloneValue(routine.output),
            })
            result = {
              ...result,
              assistantMessage: `${result?.assistantMessage ?? ''}\n\n${formatExtractionForMessage(extraction.result)}`.trim(),
              toolResults: [...(result?.toolResults ?? []), {
                name: 'structured_extract',
                params: cloneValue(routine.output),
                success: true,
              }],
            }
          }
          if (control.pauseRequested) {
            await appendEvent(accountId, runId, { type: 'paused' })
            return transition(accountId, runId, 'queued', {
              pausedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            })
          }
          if (controller.signal.aborted) {
            return transition(accountId, runId, 'cancelled')
          }
          await appendEvent(accountId, runId, { type: 'completed' })
          return transition(accountId, runId, 'completed', {
            assistantMessage: result?.assistantMessage ?? '',
            toolResults: compactToolResults(result?.toolResults),
            finishedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            ...(recoverySuggestion ? { recoverySuggestion } : {}),
          })
        } catch (error) {
          if (control.pauseRequested) {
            await appendEvent(accountId, runId, { type: 'paused' })
            return transition(accountId, runId, 'queued', {
              pausedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            })
          }
          if (controller.signal.aborted || error?.message === 'run_cancelled') {
            await appendEvent(accountId, runId, { type: 'cancelled' })
            return transition(accountId, runId, 'cancelled')
          }
          await appendEvent(accountId, runId, {
            type: 'failed',
            error: error?.message ?? String(error),
          })
          return transition(accountId, runId, 'failed', {
            error: error?.message ?? String(error),
            finishedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          })
        } finally {
          controls.delete(runId)
        }
      },
    })

    if (request?.waitForCompletion === false) {
      void completion.catch(() => {})
      return runRecord
    }
    return completion
  }

  async function cancel(accountId, runId) {
    const didCancel = queue.cancel(runId)
    controls.get(runId)?.controller.abort()
    if (!didCancel) return false
    const current = await runStore.get(accountId, runId)
    if (current && ['draft', 'ready', 'queued'].includes(current.status)) {
      await transition(accountId, runId, 'cancelled')
    }
    return true
  }

  async function pause(accountId, runId) {
    const current = await runStore.get(accountId, runId)
    if (!current || !['queued', 'running', 'waiting_approval'].includes(current.status)) {
      return false
    }
    if (current.status === 'running') {
      queue.pause(runId)
      controls.get(runId)?.controller.abort()
      return true
    }
    return true
  }

  async function transition(accountId, runId, status, patch) {
    const updated = await runStore.transition(accountId, runId, status, patch)
    broadcast({
      type: MSG.ROUTINE_RUN_CHANGED,
      run: updated,
    })
    return updated
  }

  async function appendEvent(accountId, runId, event) {
    if (typeof runStore.appendEvent !== 'function') return null
    const updated = await runStore.appendEvent(accountId, runId, event)
    broadcast({ type: MSG.ROUTINE_RUN_CHANGED, run: updated })
    return updated
  }

  return { run, resume, cancel, pause }
}

function resolveInstructions(routine, submittedVariables) {
  const values = submittedVariables && typeof submittedVariables === 'object'
    ? submittedVariables
    : {}
  let instructions = String(routine.instructions ?? '')
  for (const variable of routine.variables ?? []) {
    const submitted = values[variable.name]
    const value = submitted == null || String(submitted).length === 0
      ? variable.defaultValue
      : submitted
    if (variable.required !== false && (value == null || String(value).trim() === '')) {
      throw new Error(`routine_variable_missing:${variable.name}`)
    }
    instructions = instructions.replaceAll(`{{${variable.name}}}`, String(value ?? ''))
  }
  return instructions
}

function routineNeedsVision(routine) {
  return (routine.assets ?? []).some((asset) =>
    String(asset?.mime ?? asset?.type ?? '').startsWith('image/'),
  )
}

function validateAllowedSite(routine, activeUrl) {
  const allowed = new Set(routine.allowedOrigins ?? [])
  if (allowed.size === 0) return

  const targetUrl = routine.startUrl || activeUrl
  if (!targetUrl) throw new Error('routine_site_not_allowed')
  try {
    const origin = new URL(targetUrl).origin
    if (!allowed.has(origin)) throw new Error('routine_site_not_allowed')
  } catch (error) {
    if (error?.message === 'routine_site_not_allowed') throw error
    throw new Error('routine_site_not_allowed')
  }
}

function routineRunPrompt(routine) {
  return `Run the saved browser routine "${routine.name}".`
}

function recoveryPrompt(routine, failure) {
  return (
    `Recover step ${failure.index + 1} of the saved routine "${routine.name}". ` +
    'Do not repeat earlier confirmed steps.'
  )
}

function recoveryInstructions(instructions, failure) {
  return (
    `${instructions}\n\n` +
    `RECOVERY SCOPE: Only recover recorded step ${failure.index + 1}. ` +
    `Goal: ${JSON.stringify(failure.semantic)}. ` +
    `The saved action failed with: ${failure.error}. ` +
    'Inspect the page, perform one equivalent action, verify it, and stop.'
  )
}

function recoveryToolAllowlist(failedToolName, supportsVision) {
  return [...new Set([
    failedToolName,
    'read_page',
    ...(supportsVision ? ['screenshot'] : []),
  ])]
}

function findRecoverySuggestion(failure, toolResults, routineRevision) {
  const replacement = (Array.isArray(toolResults) ? toolResults : []).find(
    (result) =>
      result?.success === true &&
      result.name === failure.step.name &&
      result.params &&
      JSON.stringify(result.params) !== JSON.stringify(failure.step.params),
  )
  if (!replacement) return undefined
  return {
    stepIndex: failure.index,
    name: replacement.name,
    params: cloneValue(replacement.params),
    expectedRoutineRevision: routineRevision,
  }
}

function compactToolResults(results) {
  return (Array.isArray(results) ? results : []).map((result) => ({
    toolCallId: result?.toolCallId,
    name: result?.name,
    params: result?.params ? cloneValue(result.params) : undefined,
    success: result?.success === true,
    error: result?.error ?? null,
    durationMs: Number(result?.durationMs ?? 0),
  }))
}

function summarizeTargetTab(tab) {
  if (!tab || typeof tab !== 'object') return undefined
  return {
    ...(Number.isInteger(tab.id) ? { id: tab.id } : {}),
    ...(typeof tab.url === 'string' && tab.url ? { url: tab.url } : {}),
    ...(typeof tab.title === 'string' && tab.title ? { title: tab.title } : {}),
  }
}

function buildSimulationPlan(routine) {
  const recorded = Array.isArray(routine?.recordedSteps) ? routine.recordedSteps : []
  const plan = []
  if (routine?.branch) {
    plan.push({
      index: plan.length + 1,
      name: 'conditional',
      params: {
        selector: routine.branch.selector,
        contains: routine.branch.contains,
      },
      status: 'would_branch',
    })
  }
  if (recorded.length > 0) {
    plan.push(...recorded.map((step, index) => ({
      index: plan.length + index + 1,
      name: step?.name ?? 'unknown',
      params: cloneValue(step?.params ?? {}),
      status: 'would_run',
    })))
  } else {
    plan.push({
      index: plan.length + 1,
      name: 'agent',
      params: { instructions: String(routine?.instructions ?? '') },
      status: 'would_run',
    })
  }
  for (const command of routine?.subroutineCommands ?? []) {
    plan.push({
      index: plan.length + 1,
      name: 'subroutine',
      params: { command },
      status: 'would_run',
    })
  }
  if (routine?.output?.format) {
    plan.push({
      index: plan.length + 1,
      name: 'structured_extract',
      params: cloneValue(routine.output),
      status: 'would_run',
    })
  }
  return plan
}

function simulationMessage(routine, plan) {
  return `Simulation only: ${routine.name} would execute ${plan.length} step(s). No browser action was performed.`
}

async function expandSubroutineInstructions(store, accountId, routine, baseInstructions) {
  const commands = Array.isArray(routine?.subroutineCommands) ? routine.subroutineCommands : []
  if (commands.length === 0 || typeof store?.list !== 'function') return baseInstructions
  const routines = await store.list(accountId)
  const byCommand = new Map(routines.map((item) => [item.command, item]))
  const blocks = []
  const visited = new Set([routine.id])
  for (const command of commands) {
    const nested = byCommand.get(command.replace(/^\/+/, ''))
    if (!nested || visited.has(nested.id)) continue
    blocks.push(`SUB-ROUTINE /${nested.command}:\n${nested.instructions}`)
    visited.add(nested.id)
  }
  return blocks.length > 0
    ? `${baseInstructions}\n\nREUSABLE SUB-ROUTINES:\n${blocks.join('\n\n')}`
    : baseInstructions
}

function branchText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    if (typeof result.text === 'string') return result.text
    if (typeof result.data === 'string') return result.data
  }
  return JSON.stringify(result)
}

function formatExtractionForMessage(result) {
  if (!result || typeof result !== 'object') return String(result ?? '')
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
}

function cloneValue(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}
