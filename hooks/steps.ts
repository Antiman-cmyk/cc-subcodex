import type { TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { CLAUDE_TOOL } from './config'
import { editCall } from './edits'
import type { Ev, Run } from './types'

/** A tool-call id for a row the mod writes, unique in the agent's conversation. */
export function callId(e: TurnStepInput, short: string, what: string): string {
  return `toolu_subcodex_${short}_${e.turnId.slice(-8)}_${e.index}_${what}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '',
  )
}

/** The usage of a step the mod wrote: zero, as no Claude request was made. */
function spent(e: TurnStepInput): NonNullable<TurnStepResult['usage']> {
  return {
    model: e.model,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
}

/** One step that ends in a single tool call. */
export function* toolStep(
  e: TurnStepInput,
  block: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
  answer: string,
): Generator<TurnStepChunk, TurnStepResult> {
  const usage = spent(e)
  yield { kind: 'tool', index: block, id, name }
  yield { kind: 'input', index: block, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage }
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses: [{ name, input }],
    stopReason: 'tool_use',
    usage,
  }
}

/** One step that ends the agent's turn with what it has said. */
export function* lastStep(
  e: TurnStepInput,
  answer: string,
): Generator<TurnStepChunk, TurnStepResult> {
  const usage = spent(e)
  yield { kind: 'stop', stopReason: 'end_turn', usage }
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses: [],
    stopReason: 'end_turn',
    usage,
  }
}

/**
 * A Codex turn that ended inside a step: the next block, all the step's text,
 * and Codex's closing message (`own`): its final answer, else its last message.
 */
export type Ended = { ended: true; block: number; answer: string; own: string }

/**
 * Writes one step of the agent's transcript from Codex's events, up to the
 * first tool call (a command, an edit, a tool of the session's). Returns that step, or
 * `Ended` where Codex's turn ended first. A command is a row of `commandTool`.
 */
export async function* mirror(
  e: TurnStepInput,
  short: string,
  run: Run,
  commandTool: 'Bash' | 'PowerShell' = 'Bash',
): AsyncGenerator<TurnStepChunk, TurnStepResult | Ended> {
  let block = 0
  let open: 'text' | 'thinking' | undefined
  let answer = ''
  let closing = ''
  let last = ''
  let lastText: string | undefined
  let lastOwn: string | undefined
  const enter = (kind: 'text' | 'thinking'): void => {
    if (open !== undefined && open !== kind) block++
    open = kind
  }

  for (;;) {
    const taken = run.buffered.shift() ?? (await run.pull())
    const ev: Ev =
      taken.t === 'compacted'
        ? {
            t: 'text',
            text: `[Codex${taken.by === undefined ? '' : ` sub-agent ${taken.by}`} compacted its own context${taken.tokens === undefined ? '' : `, at about ${Math.round(taken.tokens / 1000)}k tokens`}]`,
            isAside: true,
          }
        : taken
    if (ev.t === 'thinking') {
      enter('thinking')
      yield { kind: 'thinking', index: block, text: ev.text }
      continue
    }
    if (ev.t === 'text') {
      const isSameBlock = open === 'text'
      enter('text')
      // Pieces of one message run on; a new message starts a paragraph.
      const isNewMessage = ev.id === undefined || ev.id !== lastText
      lastText = ev.id
      const text = isSameBlock && isNewMessage && answer !== '' ? `\n\n${ev.text}` : ev.text
      answer += text
      if (ev.by === undefined && ev.isAside !== true) {
        const isNewOwn = ev.id === undefined || ev.id !== lastOwn
        lastOwn = ev.id
        last = isNewOwn ? ev.text : last + ev.text
        if (ev.isClosing === true) closing += isNewOwn && closing !== '' ? `\n\n${ev.text}` : ev.text
      }
      yield { kind: 'text', index: block, text }
      continue
    }
    if (ev.t === 'cmd') {
      if (open !== undefined) block++
      const id = callId(e, short, ev.id)
      const input = {
        command: ev.command,
        description: ev.by === undefined ? 'Run by Codex' : `Run by Codex sub-agent ${ev.by}`,
      }
      run.tools.set(id, ev.id)
      return yield* toolStep(e, block, id, commandTool, input, answer)
    }
    if (ev.t === 'edit') {
      if (open !== undefined) block++
      const id = callId(e, short, ev.id)
      const { name, input } = editCall(ev)
      run.edits.set(id, ev)
      return yield* toolStep(e, block, id, name, input, answer)
    }
    if (ev.t === 'ctool') {
      if (open !== undefined) block++
      const id = callId(e, short, `c${run.calls.size}_${String(ev.rpc)}`)
      run.calls.set(id, ev)
      const input = { name: ev.name, arguments: ev.args }
      return yield* toolStep(e, block, id, CLAUDE_TOOL, input, answer)
    }
    if (ev.t === 'done') {
      return { ended: true, block: open === undefined ? block : block + 1, answer, own: closing !== '' ? closing : last }
    }
    // Anything else (an unawaited command end, a count) draws nothing.
  }
}
