import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { agentOf, merged, newAgent, saidTo, untaken } from '../../hooks/agents'

// What an agent has been told, and which of it is new since its last reply.

const agentWith = (turns: number) => ({
  ...newAgent({ model: undefined, effort: undefined }, 'default', undefined),
  task: 'Fix the bug.',
  turns,
})
const sessionOf = (rows: unknown) => ({ session: { messages: async () => rows } }) as unknown as EngineInterface

describe('what the agent has been told', () => {
  test('its task and each later message; those since its last reply are fresh', async () => {
    const rows = [
      { role: 'user', text: 'Fix the bug.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ name: 'Bash' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'ok', isError: false }] },
      { role: 'assistant', text: 'Fixed.', toolUses: [] },
      { role: 'user', text: '<system-reminder>context</system-reminder>', toolUses: [] },
      { role: 'user', text: 'Now add a test.', toolUses: [] },
      { role: 'user', text: 'And run it.', toolUses: [] },
    ]
    expect(await saidTo(sessionOf(rows), 'a', agentWith(1))).toEqual({
      all: ['Fix the bug.', 'Now add a test.', 'And run it.'],
      fresh: ['Now add a test.', 'And run it.'],
    })
  })

  test('before any reply, everything said is fresh', async () => {
    const rows = [{ role: 'user', text: 'Fix the bug.', toolUses: [] }]
    expect(await saidTo(sessionOf(rows), 'a', agentWith(0))).toEqual({ all: ['Fix the bug.'], fresh: ['Fix the bug.'] })
  })

  test('a conversation that cannot be read is the task, fresh only before the first Codex turn', async () => {
    const denied = sessionOf({ deny: 'not readable' })
    expect(await saidTo(denied, 'a', agentWith(0))).toEqual({ all: ['Fix the bug.'], fresh: ['Fix the bug.'] })
    expect(await saidTo(denied, 'a', agentWith(1))).toEqual({ all: ['Fix the bug.'], fresh: [] })
  })
})

describe('messages merged for a Codex turn', () => {
  test('keeps the order and drops a message already there', () => {
    expect(merged(['Fix the bug.', 'Add a test.'], ['Add a test. ', 'Run it.', 'Run it.'])).toEqual([
      'Fix the bug.',
      'Add a test.',
      'Run it.',
    ])
  })
})

describe('messages Codex has not taken in', () => {
  test("are those not among what Codex's latest turn was given", () => {
    const agent = { ...agentWith(1), unsent: ['Fix the bug.', 'Also add a test.'], given: ['Fix the bug.'] }
    expect(untaken(agent)).toEqual(['Also add a test.'])
  })
})

describe('an agent the session does not list', () => {
  test("is a Codex agent where the mod keeps its record (a workflow's), restored with its thread and messages", async () => {
    const record = { threadId: 'thread-1', settings: { model: 'gpt-x', effort: 'low' }, mode: 'auto', unsent: ['Go on.'], isWorkflow: true }
    const $ = {
      agent: { list: async () => [] },
      store: { get: async (key: string) => (key === 'agent:wf-agent-1' ? record : undefined) },
    } as unknown as EngineInterface
    const agent = await agentOf($, 'wf-agent-1')
    expect(agent?.threadId).toBe('thread-1')
    expect(agent?.unsent).toEqual(['Go on.'])
    expect(agent?.isWorkflow).toBe(true)
  })

  test('is not one where the mod keeps no record', async () => {
    const $ = { agent: { list: async () => [] }, store: { get: async () => undefined } } as unknown as EngineInterface
    expect(await agentOf($, 'someone-else')).toBe(undefined)
  })
})
