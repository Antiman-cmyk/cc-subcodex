import type { TurnStepChunk, TurnStepInput } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { mirror } from '../../hooks/steps'
import type { Ev, Run } from '../../hooks/types'

// One step of the agent's transcript, written from Codex's events.

const STEP = { turnId: 'turn-abcdefgh', index: 0, model: '<synthetic>', messageCount: 1, agentId: 'agent-1' } as TurnStepInput
const runOf = (events: Ev[]): Run => ({ pull: async () => events.shift() ?? { t: 'done' }, buffered: [], tools: new Map(), edits: new Map(), calls: new Map(), reply: async () => undefined })
async function step(run: Run) {
  const chunks: TurnStepChunk[] = []
  const walk = mirror(STEP, 'abc123', run)
  for (;;) {
    const next = await walk.next()
    if (next.done === true) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}

describe('a step written from what Codex does', () => {
  test('text up to a command, then the command as a Bash call that waits for its output', async () => {
    const run = runOf([{ t: 'text', text: 'Running it.', id: 'm1' }, { t: 'cmd', id: 'exec-1', command: 'echo hi' }, { t: 'text', text: 'never reached in this step' }])
    const { chunks, result } = await step(run)
    expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'Running it.' })
    expect('ended' in result).toBe(false)
    if ('ended' in result) return
    expect(result.stopReason).toBe('tool_use')
    expect(result.toolUses).toEqual([{ name: 'Bash', input: { command: 'echo hi', description: 'Run by Codex' } }])
    // The call is remembered as the mirror of that command, for the hook that answers it.
    expect([...run.tools.values()]).toEqual(['exec-1'])
    // A step the mod wrote costs no Claude tokens, and says so.
    expect(result.usage).toEqual({ model: '<synthetic>', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  test("the closing message is the one Codex marked final: not what it said along the way, a sub-agent's words, or a line of the mod's", async () => {
    const { result } = await step(
      runOf([
        { t: 'text', text: 'I will look.', id: 'm1' },
        { t: 'text', text: '[Codex looked at the image red.png]', isAside: true },
        { t: 'text', text: '[Codex sub-agent /root/x] three lines', id: 's1', by: '/root/x' },
        { t: 'text', text: 'It is ', id: 'm2', isClosing: true },
        { t: 'text', text: 'red.', id: 'm2', isClosing: true },
        { t: 'done' },
      ]),
    )
    expect('ended' in result && result.own).toBe('It is red.')
    expect('ended' in result && result.answer).toContain('I will look.')
    expect('ended' in result && result.answer).toContain('[Codex looked at the image red.png]')
  })

  test('where Codex marks no final message, the last message of its own is the closing one', async () => {
    const { result } = await step(runOf([{ t: 'text', text: 'First.', id: 'm1' }, { t: 'text', text: 'Review comment: one finding.', id: 'm2' }, { t: 'done' }]))
    expect('ended' in result && result.own).toBe('Review comment: one finding.')
  })

  test("Codex compacting its own context is a line, and a sub-agent's is named as its", async () => {
    const { result } = await step(runOf([{ t: 'compacted', tokens: 450_000 }, { t: 'compacted', by: '/root/x' }, { t: 'done' }]))
    expect('ended' in result && result.answer).toBe('[Codex compacted its own context, at about 450k tokens]\n\n[Codex sub-agent /root/x compacted its own context]')
    expect('ended' in result && result.own).toBe('')
  })

  test('counts and limits leave no line', async () => {
    const { chunks, result } = await step(runOf([{ t: 'usage', tokens: 0 }, { t: 'limits', limits: [] }, { t: 'done' }]))
    expect(chunks).toEqual([])
    expect('ended' in result && result.answer).toBe('')
  })

  test("something Codex asks of the session is a row of the mod's own tool, remembered with the request to answer", async () => {
    const asked: Ev = { t: 'ctool', rpc: 7, name: 'message_parent', args: { message: 'halfway there' } }
    const run = runOf([asked])
    const { result } = await step(run)
    expect('ended' in result).toBe(false)
    if ('ended' in result) return
    expect(result.toolUses[0]?.name).toBe('mcp__subcodex__claude_tool')
    expect(result.toolUses[0]?.input).toEqual({ name: 'message_parent', arguments: { message: 'halfway there' } })
    expect([...run.calls.values()]).toEqual([asked])
  })
})
