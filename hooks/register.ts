import type { EngineInterface, Register } from 'claude-code'

import {
  agentOf,
  agents,
  merged,
  untaken,
  newAgent,
  noteType,
  planned,
  readDirective,
  remember,
  saidTo,
  settingsFor,
  typeOf,
} from './agents'
import { closeConn } from './app-server'
import { MESSAGE, REMIND, RESULT, runForCodex } from './bridge'
import { findCodex, keepInstructions } from './codex-home'
import { compacted } from './compact'
import {
  CHECKPOINT,
  CLAUDE_TOOL,
  NAME,
  ROW_OUTPUT_HEAD,
  ROW_OUTPUT_TAIL,
  SYNTHETIC,
  TYPE,
} from './config'
import { editResult } from './edits'
import { dropOutput, registerLive } from './live'
import { trace } from './log'
import {
  LOCAL_MODEL,
  NO_REPORT,
  NO_RESULT,
  mockRequests,
  registerModelMock,
  type MockRequest,
} from './model-mock'
import { callId, lastStep, mirror, toolStep } from './steps'
import { promptFor, startTurn, steer } from './turn'
import type { Agent, Ev, Relay, Run } from './types'
import { COMMAND, keepLimits, upkeep } from './upkeep'
import { commandTool, learnSystem } from './host'

// Codex supplies every step. Native communication runs through a local
// protocol response so the engine retains delivery, permissions and task state.

/** Settle a native submission once, including a denial or validation error. */
async function settle(
  $: EngineInterface,
  agent: Agent,
  relay: Relay,
  isLetThrough: boolean,
  why: string,
): Promise<void> {
  agent.relay = undefined
  if (relay.tool === 'StructuredOutput' && isLetThrough) agent.hasResult = true
  trace($, `${relay.tool}: ${isLetThrough ? 'let through' : `not let through (${why})`}`)
  await agent.run?.reply(relay.rpc, relay.answer(isLetThrough, why))
}

/** The error text of the agent's latest tool result, where it is one. */
async function lastError($: EngineInterface, agentId: string): Promise<string | undefined> {
  const rows = await $.session.messages({ agentId }).catch(() => undefined)
  return Array.isArray(rows) ? rows.at(-1)?.toolResults?.find(result => result.isError)?.text : undefined
}

/** Whether a call is made inside a Codex agent. */
async function isInCodex($: EngineInterface, agentId: string | undefined): Promise<boolean> {
  return agentId !== undefined && (agents.has(agentId) || (await typeOf($, agentId)) === TYPE)
}

/** The answer to an Edit or Write row: the edit Codex made, never a run of the tool. */
function editAnswer(agentId: string, toolUseId: string) {
  const run = agents.get(agentId)?.run
  const edit = run?.edits.get(toolUseId)
  if (run === undefined || edit === undefined) return { deny: "subcodex: this call mirrors no edit of Codex's." }
  run.edits.delete(toolUseId)
  return { result: editResult(edit) as never }
}

/** The run's next event; undefined once the call is stopped, the event then kept for whoever reads next. */
async function pullUntil(run: Run, signal: AbortSignal): Promise<Ev | undefined> {
  if (signal.aborted) return undefined
  const pulled = run.pull()
  let onStop = (): void => undefined
  const stopped = new Promise<undefined>(resolve => {
    onStop = () => resolve(undefined)
    signal.addEventListener('abort', onStop, { once: true })
  })
  const ev = await Promise.race([pulled, stopped])
  signal.removeEventListener('abort', onStop)
  if (ev === undefined) void pulled.then(late => run.buffered.push(late), () => undefined)
  return ev
}

export const register: Register = on => {
  registerModelMock(on)
  registerLive(on)
  /** The tool of the rows that mirror Codex's commands (`commandTool`), set as the session starts. */
  let commandRow: 'Bash' | 'PowerShell' = 'Bash'
  on('session.start', async ($, e, next) => {
    await learnSystem($)
    const { defaults, models } = await findCodex($)
    const model = defaults.model ?? 'its own default model'
    const effort = defaults.effort ?? 'its own default effort'
    commandRow = await commandTool($)
    // Written only by the mod; deferred to keep the main prompt small.
    await $.tool.register({
      name: 'checkpoint',
      description:
        'Marks a local protocol boundary inside a Codex agent. Raised by the subcodex mod itself: never call it.',
      inputSchema: { type: 'object', properties: { turn: { type: 'number' } } },
      isDeferred: true,
    })
    await $.tool.register({
      name: 'claude_tool',
      description:
        'Raised by the subcodex mod when Codex, inside a Codex agent, uses a tool of this Claude session: never call it.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, arguments: { type: 'object' } },
        required: ['name'],
      },
      isDeferred: true,
    })
    await $.command.register({
      name: COMMAND,
      description: 'Shows how the subcodex mod stands (Codex, its login, your usage limits) and what it keeps on disk, and cleans that up.',
      argumentHint: '[clean <days> | clean all]',
    })
    await $.agent.register({
      name: NAME,
      description:
        "Has OpenAI Codex (a different model family) do any task a general-purpose agent would: research a question, search and read code, carry out multi-step work, write and edit code, review. Use it only when the user asks for it: for Codex, OpenAI or GPT by name, or for another model's view; otherwise choose another agent. The result is Codex's own closing message, as it wrote it; where it ends on a question for you, answer with a message to this agent and Codex goes on. " +
        `Unless the call says otherwise Codex runs as it is configured: model ${model}, reasoning effort ${effort}. ` +
        "Effort: set the Agent tool's `effort` parameter. " +
        "Model: the Agent tool's `model` parameter names Claude models and does not apply here; to choose a Codex model, make the first line of the prompt `@codex model=<id>`" +
        (models.length > 0 ? `, where <id> is one of ${models.join(', ')}. ` : '. ') +
        'That line is read by this agent and cut from the task before Codex sees it. It also takes `effort=ultra`, a Codex level the `effort` parameter lacks. ' +
        "For a review of code changes, and only of code, `@codex review` on that line runs Codex's own review mode, a fixed reviewer that answers with bugs in the change ranked by priority: the rest of the prompt says what to review, and with nothing more it reviews the uncommitted changes. It starts without this conversation, so say there what matters. To have anything else checked (a paper, prose, data, results), give an ordinary task that says what to check and by what standard, without `review`. " +
        'The agent can be sent a later message: Codex goes on in the same thread.',
      prompt: 'OpenAI Codex performs this task. The subcodex mod supplies its steps and native tool calls locally. No Claude model is needed.',
      // Command, Edit and Write rows mirror Codex's commands and edits; any other call of them is refused.
      tools: [commandRow, 'Edit', 'Write', CHECKPOINT, CLAUDE_TOOL, 'SendMessage', 'StructuredOutput'],
      model: SYNTHETIC,
      omitClaudeMd: true,
    })
    return next(e)
  })

  // `/subcodex` (upkeep.ts).
  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await upkeep($, e.args) }))

  // Keeps the instruction files the engine loaded, for Codex's threads.
  on('prompt.context', async ($, e, next) => {
    if (e.instructionFiles !== undefined && e.instructionFiles.length > 0) await keepInstructions($, e.instructionFiles)
    return next(e)
  })

  // Reads an Agent call's `effort`, which the spawn does not carry. The call goes on unchanged.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type !== TYPE) return next(e)
    planned.set(e.tool_use_id, await settingsFor($, e.prompt, e.effort))
    const ran = await next(e)
    planned.delete(e.tool_use_id)
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== TYPE) {
      const other = await next(e)
      if (other.agentId !== undefined) noteType(other.agentId, e.subagentType)
      return other
    }
    // A message resumes an agent: it keeps its settings; its mode is refreshed.
    if (e.resume !== undefined) {
      const resumed = await agentOf($, e.resume.agentId)
      if (resumed !== undefined) resumed.mode = e.permissionMode ?? resumed.mode
      return next(e)
    }
    const asked = planned.get(e.tool_use_id)
    planned.delete(e.tool_use_id)
    const settings = asked ?? (await settingsFor($, e.prompt, undefined))
    const mode = e.permissionMode
    // The task's title shows the Codex model and effort.
    const tag = [settings.model, settings.effort]
      .filter(part => part !== undefined)
      .join(' · ')
    const description =
      tag === '' || e.workflow !== undefined ? e.description : `${e.description} · ${tag}`
    trace($, `spawn: settings ${JSON.stringify(settings)}, mode ${mode}`)
    const { isReview, rest: task } = readDirective(e.prompt)
    const begun = await next({
      ...e,
      ...(description === e.description ? {} : { description }),
      prompt: task,
      model: SYNTHETIC,
    })
    if (begun.agentId !== undefined) {
      noteType(begun.agentId, TYPE)
      const agent = newAgent(settings, mode, e.cwd)
      agent.caller = e.parentAgentId
      agent.task = task
      agent.isReview = isReview
      agent.isWorkflow = e.workflow !== undefined
      agents.set(begun.agentId, agent)
      await remember($, begun.agentId, agent)
    }
    return begun
  })

  on('turn.step', async function* ($, e, next) {
    let isOurs = false
    try {
      const agentId = e.agentId
      const agent = agentId === undefined ? undefined : await agentOf($, agentId)
      if (agentId === undefined || agent === undefined) return yield* next(e)
      isOurs = true
      const short = agentId.slice(-6)
      const mockStep = async function* (request: MockRequest) {
        mockRequests.set(agentId, request)
        try { return yield* next({ ...e, model: LOCAL_MODEL, effort: 'low' }) }
        finally { mockRequests.delete(agentId) }
      }
      // Workflow schemas are on the model request, not on agent.spawn.
      // Read the native StructuredOutput schema locally before Codex starts.
      if (agent.isWorkflow && !agent.isPrepared) return yield* mockStep({ kind: 'prepare' })

      if (agent.run === undefined) {
        // A message came while Codex could not take it: Codex goes on with it first.
        if (untaken(agent).length > 0 && (agent.closing === 'echo' || agent.closing === 'deliver')) {
          agent.closing = undefined
          agent.carryOn = 'late'
        }
        if (agent.closing === 'echo') {
          // Codex's closing message alone, as the agent's last words: its result.
          agent.closing = undefined
          yield { kind: 'text', index: 0, text: agent.turnReport }
          return yield* lastStep(e, agent.turnReport)
        }
        if (agent.closing === 'deliver') {
          agent.closing = 'delivered'
          return yield* mockStep(
            agent.outputSchema !== undefined
              ? { kind: 'error', message: NO_RESULT }
              : { kind: 'call', name: 'SubagentHandback', input: { message: agent.turnReport || NO_REPORT } },
          )
        }
        if (agent.closing === 'delivered') {
          // The closing call did not end the turn: it was refused.
          agent.closing = undefined
          const why = await lastError($, agentId)
          return yield* mockStep({
            kind: 'error',
            message: `subcodex: Codex's result could not be handed back${why === undefined ? '.' : `: ${why}`}`,
          })
        }
        const isSameTurn = agent.turnId === e.turnId
        if (!isSameTurn) {
          agent.turnId = e.turnId
          agent.hasResult = false
          agent.isReminded = false
          agent.carryOn = undefined
        }
        const carryOn = agent.carryOn
        agent.carryOn = undefined
        const said = await saidTo($, agentId, agent)
        const all = said.all.map(text => readDirective(text).rest)
        // What Codex is given: messages it has not taken in, and those said since the agent's last reply.
        const told = !isSameTurn && said.fresh.length === 0 ? said.all.slice(-1) : said.fresh
        const pending =
          carryOn === 'remind'
            ? []
            : carryOn === 'late'
              ? agent.unsent
              : merged(isSameTurn ? untaken(agent) : agent.unsent, told.map(text => readDirective(text).rest))
        if (carryOn === undefined && isSameTurn && pending.length === 0) {
          // The engine asks for more in a turn whose result has been given.
          return yield* mockStep({ kind: 'error', message: "subcodex: this turn of the Codex agent is over, and it has nothing more to say." })
        }
        const isReview = agent.turns === 0 ? agent.isReview : carryOn === undefined && readDirective(told.at(-1) ?? '').isReview
        const prompt = carryOn === 'remind' ? REMIND : promptFor(pending, carryOn === 'late' || isSameTurn)
        agent.turns++
        trace(
          $,
          `agent ${short}: Codex turn ${agent.turns}${carryOn === undefined ? '' : ` (${carryOn})`}, settings ${JSON.stringify(agent.settings)}, thread ${agent.threadId}`,
        )
        agent.run = await startTurn($, agent, agentId, all, pending, prompt, isReview)
      }
      const run = agent.run

      if (agent.relay !== undefined) {
        const relay = agent.relay
        if (!relay.isWritten) {
          relay.isWritten = true
          // Auto mode needs a model response for the call; elsewhere the mod writes it.
          if (agent.mode === 'auto') return yield* mockStep({ kind: 'call', name: relay.tool, input: relay.input })
          return yield* toolStep(e, 0, callId(e, short, `x_${String(relay.rpc)}`), relay.tool, relay.input, '')
        }
        // The call did not reach its tool.call hook (schema validation, a
        // missing tool): Codex gets the native error, to correct it.
        await settle($, agent, relay, false, (await lastError($, agentId)) ?? 'the native tool call did not complete')
      }

      const shown = yield* mirror(e, short, run, commandRow)
      if (!('ended' in shown)) return shown

      // The Codex turn is over.
      agent.run = undefined
      agent.turnReport = shown.own.trim()
      trace($, `agent ${short}: Codex turn ${agent.turns} done`)
      if (next.signal.aborted) return yield* lastStep(e, shown.answer)
      // The streamed work stays in this step; what follows takes the next.
      const checkpoint = () =>
        toolStep(e, shown.block, callId(e, short, 'checkpoint'), CHECKPOINT, { turn: agent.turns }, shown.answer)
      // Messages sent during the turn that Codex did not take: it goes on with them.
      if (untaken(agent).length > 0) {
        agent.carryOn = 'late'
        return yield* checkpoint()
      }
      if (agent.outputSchema !== undefined) {
        if (agent.hasResult) return yield* lastStep(e, shown.answer)
        if (!agent.isReminded) {
          agent.isReminded = true
          agent.carryOn = 'remind'
        } else agent.closing = 'deliver'
        return yield* checkpoint()
      }
      // A workflow's agent has no hand-back tool: its last words are its result.
      if (agent.mode === 'auto' && !agent.isWorkflow) {
        agent.closing = 'deliver'
        return yield* checkpoint()
      }
      if (agent.turnReport === '') {
        yield { kind: 'text', index: shown.block, text: NO_REPORT }
        return yield* lastStep(e, shown.answer === '' ? NO_REPORT : `${shown.answer}\n\n${NO_REPORT}`)
      }
      if (shown.answer.trim() === agent.turnReport) return yield* lastStep(e, shown.answer)
      // The step holds other lines too: Codex's closing message follows alone.
      agent.closing = 'echo'
      return yield* checkpoint()
    } catch (error) {
      // A stopped agent: every engine call fails from then on.
      if (isOurs && next.signal.aborted) return yield* lastStep(e, '')
      throw error
    }
  })

  // A local boundary between mirrored work and native protocol steps.
  on('tool.call', { tool: CHECKPOINT }, async (_$, e) => {
    if (e.agentId === undefined || !agents.has(e.agentId)) {
      return { deny: 'subcodex: only the mod raises a checkpoint, inside a Codex agent.' }
    }
    return { result: 'Codex protocol checkpoint.' }
  })

  // Native communication is relayed by the next step; connected tools run now.
  on('tool.call', { tool: CLAUDE_TOOL }, async ($, e) => {
    const agent = e.agentId === undefined ? undefined : agents.get(e.agentId)
    const run = agent?.run
    const asked = run?.calls.get(e.tool_use_id)
    if (agent === undefined || run === undefined || asked === undefined) {
      return { deny: 'subcodex: only the mod raises this, for something Codex asked.' }
    }
    run.calls.delete(e.tool_use_id)
    const { rpc, name, args } = asked
    if (name === RESULT && agent.outputSchema !== undefined) {
      agent.relay = {
        rpc,
        tool: 'StructuredOutput',
        input: args,
        isWritten: false,
        answer: (ok, why) => ({
          contentItems: [{
            type: 'inputText',
            text: ok ? 'The workflow result was accepted.' : `The native output validator refused this result: ${why}. Correct it and submit again.`,
          }],
          success: ok,
        }),
      }
      return { result: 'Codex submitted its workflow result for native validation.' }
    }
    if (name === MESSAGE) {
      const message = String(args.message ?? '').trim()
      if (message === '') {
        await run.reply(rpc, { contentItems: [{ type: 'inputText', text: 'Not sent: the message is empty.' }], success: false })
        return { result: 'Codex asked to send an empty message; nothing was sent.' }
      }
      const to = agent.caller ?? 'main'
      agent.relay = {
        rpc,
        tool: 'SendMessage',
        input: { to, summary: 'Message from Codex', message },
        answer: (isSent, why) => ({
          contentItems: [
            {
              type: 'inputText',
              text: isSent ? 'Sent. Keep working: a reply, if any, arrives as a new user message.' : `Not sent: ${why}`,
            },
          ],
          success: isSent,
        }),
        isWritten: false,
      }
      return {
        result: 'Codex queued a message to its caller; the next native call delivers it.',
      }
    }
    // Run as asked; deny rules still apply (`runForCodex`). In plan mode, only what the engine allows there.
    const answerOf = (text: string, isDone: boolean) => ({ contentItems: [{ type: 'inputText', text }], success: isDone })
    if (agent.mode === 'plan') {
      const checked = await $.tool.check({ tool: name, input: args }).catch(() => undefined)
      trace($, `claude tool ${name} in plan mode: ${checked?.decision ?? 'not checked'}`)
      if (checked?.decision !== 'allow') {
        const text = `The Claude session is in plan mode, which lets only reads run, and this call is not one it allows${checked?.reason === undefined ? '' : ` (${checked.reason})`}: it was not run.`
        await run.reply(rpc, answerOf(text, false))
        return { result: text }
      }
    }
    const { text, images, isDone } = await runForCodex($, name, args)
    trace($, `claude tool ${name}: ${isDone ? 'ok' : 'failed'}, ${text.length} chars, ${images.length} images`)
    await run.reply(rpc, {
      ...answerOf(text, isDone),
      contentItems: [{ type: 'inputText', text }, ...images.map(imageUrl => ({ type: 'inputImage', imageUrl }))],
    })
    return { result: images.length === 0 ? text : `${text}\n[${images.length === 1 ? 'An image' : `${images.length} images`} went to Codex with this result]` }
  })

  // A message to an agent during its turn: kept in its record until Codex
  // takes it, and passed into Codex's turn if one is in flight.
  on('session.receive', async ($, e, next) => {
    const agent = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (
      e.agentId !== undefined &&
      agent?.turnId !== undefined &&
      e.origin.kind !== 'task-notification' &&
      e.text.trim() !== ''
    ) {
      const conn = agent.conn
      agent.unsent = merged(agent.unsent, [e.text])
      await remember($, e.agentId, agent)
      const isPassed = agent.run !== undefined && conn !== undefined && (await steer($, conn, e.text).catch(() => false))
      trace($, `a message for agent ${e.agentId.slice(-6)} ${isPassed ? 'passed on to Codex' : 'kept for its next Codex turn'}`)
    }
    return next(e)
  })

  // Handle native submissions and guard against a premature handback.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    const agent = e.agentId === undefined ? undefined : agents.get(e.agentId)
    const relay = agent?.relay
    if (agent !== undefined && relay !== undefined && tool === relay.tool && agent.run !== undefined) {
      const ran = await next(e)
      const ok = ran.deny === undefined && ran.isError !== true
      await settle($, agent, relay, ok, ran.deny ?? ran.text ?? 'the session refused it')
      return ran
    }
    // No hand-back while Codex is still at work.
    if (tool === 'SubagentHandback' && agent?.run !== undefined) {
      return {
        deny: 'subcodex: Codex is still at work. Do only what the last tool result asked; the result is handed back after its turn.',
      }
    }
    return next(e)
  })

  // Compacts a Codex agent's context without a model (compact.ts).
  on('session.compact', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)
    if (!agents.has(id) && (await typeOf($, id)) !== TYPE) return next(e)
    if (e.trigger === 'precompute') return { skip: 'subcodex cuts a Codex agent\'s context when it is due' }
    const messages = compacted(e.messages)
    if (messages === undefined) return { skip: 'subcodex: nothing to leave out yet' }
    trace($, `agent ${id.slice(-6)}: context cut down, ${e.messages.length} rows to ${messages.length}`)
    return { messages }
  })

  // The agent's turn is over: interrupt a Codex turn still in flight, close the server.
  on('turn.complete', async ($, e, next) => {
    const agent = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (agent !== undefined) {
      const isMidTurn = agent.run !== undefined
      const conn = agent.conn
      agent.conn = undefined
      agent.run = undefined
      agent.relay = undefined
      mockRequests.delete(String(e.agentId))
      agent.closing = undefined
      agent.carryOn = undefined
      agent.turnId = undefined
      trace(
        $,
        `agent ${String(e.agentId).slice(-6)}: turn over (${e.reason})${isMidTurn ? ', Codex interrupted' : ''}`,
      )
      await keepLimits($, agent.limits).catch(() => undefined)
      await dropOutput($, `toolu_subcodex_${String(e.agentId).slice(-6)}_`).catch(() => undefined)
      if (conn !== undefined) await closeConn($, conn, isMidTurn)
    }
    return next(e)
  })

  // Edit and Write rows show edits Codex has made: the tools never run.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    (await isInCodex($, e.agentId)) ? editAnswer(String(e.agentId), e.tool_use_id) : next(e),
  ).catch((_$, e, next) =>
    next.called || e.agentId === undefined || !agents.has(e.agentId) ? next(e) : { deny: 'subcodex: mirroring this edit failed.' },
  )
  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    (await isInCodex($, e.agentId)) ? editAnswer(String(e.agentId), e.tool_use_id) : next(e),
  ).catch((_$, e, next) =>
    next.called || e.agentId === undefined || !agents.has(e.agentId) ? next(e) : { deny: 'subcodex: mirroring this edit failed.' },
  )

  // Command rows (`commandRow`) show commands Codex has run: the tools never run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (await commandAnswer($, e, next.signal)) ?? next(e)).catch((_$, e, next) =>
    // A failed hook must not let a mirrored command run for real.
    next.called || e.agentId === undefined || !agents.has(e.agentId)
      ? next(e)
      : { deny: 'subcodex: mirroring this command failed.' },
  )
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => (await commandAnswer($, e, next.signal)) ?? next(e)).catch((_$, e, next) =>
    next.called || e.agentId === undefined || !agents.has(e.agentId)
      ? next(e)
      : { deny: 'subcodex: mirroring this command failed.' },
  )
}

/**
 * The answer to a command row: the output of the command Codex ran, never a
 * run of the tool; undefined for a call outside a Codex agent.
 */
async function commandAnswer(
  $: EngineInterface,
  e: { agentId?: string; tool_use_id: string },
  signal: AbortSignal,
): Promise<{ deny: string } | { result: { stdout: string; stderr: string; interrupted: boolean } } | undefined> {
  if (!(await isInCodex($, e.agentId))) return undefined
  const run = agents.get(String(e.agentId))?.run
  const itemId = run?.tools.get(e.tool_use_id)
  if (run === undefined || itemId === undefined) {
    return { deny: 'subcodex: this call mirrors no Codex command.' }
  }
  // The row keeps its command until the end, for the output drawn under it while it runs.
  const ended = async <T>(answer: T): Promise<T> => {
    run.tools.delete(e.tool_use_id)
    await dropOutput($, e.tool_use_id).catch(() => undefined)
    return answer
  }
  const outputOf = (ev: Extract<Ev, { t: 'cmd_done' }>) => ({
    result: {
      stdout:
        ev.output.length > ROW_OUTPUT_HEAD + ROW_OUTPUT_TAIL
          ? `${ev.output.slice(0, ROW_OUTPUT_HEAD)}\n[... ${ev.output.length - ROW_OUTPUT_HEAD - ROW_OUTPUT_TAIL} characters left out here, which Codex has ...]\n${ev.output.slice(-ROW_OUTPUT_TAIL)}`
          : ev.output,
      stderr: ev.exitCode !== null && ev.exitCode !== 0 ? `Exit code ${ev.exitCode}` : '',
      interrupted: false,
    },
  })
  // Commands run side by side: the end may already have been read.
  const at = run.buffered.findIndex(ev => ev.t === 'cmd_done' && ev.id === itemId)
  const kept = at < 0 ? undefined : run.buffered.splice(at, 1)[0]
  if (kept?.t === 'cmd_done') return ended(outputOf(kept))
  for (;;) {
    const ev = await pullUntil(run, signal)
    // The agent was stopped: its turn's end closes Codex.
    if (ev === undefined) return ended({ result: { stdout: '', stderr: 'Stopped.', interrupted: true } })
    if (ev.t === 'cmd_done' && ev.id === itemId) return ended(outputOf(ev))
    run.buffered.push(ev)
    if (ev.t === 'done') {
      return ended({
        result: {
          stdout: '',
          stderr: 'Codex ended before this command reported its output.',
          interrupted: true,
        },
      })
    }
  }
}
