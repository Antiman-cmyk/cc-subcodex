import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { agentOf, merged, newAgent, recordPath, remember, saidTo, untaken } from '../../hooks/agents'

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

/** A session that lists no agents, with the given files under the home directory `/h`. */
const filesOf = (files: Record<string, string>) =>
  ({
    agent: { list: async () => [] },
    env: { get: async (name: string) => (name === 'HOME' ? '/h' : undefined) },
    process: { run: async () => ({ stdout: '', stderr: '', code: 0 }) },
    fs: {
      exists: async (path: string) => path in files,
      read: async (path: string) => {
        if (!(path in files)) throw new Error('ENOENT')
        return files[path]
      },
    },
  }) as unknown as EngineInterface

describe('an agent the session does not list', () => {
  test("is a Codex agent where the mod keeps its record (a workflow's), restored with its thread and messages", async () => {
    const record = { threadId: 'thread-1', settings: { model: 'gpt-x', effort: 'low' }, mode: 'auto', unsent: ['Go on.'], isWorkflow: true }
    const $ = filesOf({ '/h/.claude/subcodex/agents/wf-agent-1.json': JSON.stringify(record) })
    const agent = await agentOf($, 'wf-agent-1')
    expect(agent?.threadId).toBe('thread-1')
    expect(agent?.unsent).toEqual(['Go on.'])
    expect(agent?.isWorkflow).toBe(true)
  })

  test('is not one where the mod keeps no record', async () => {
    expect(await agentOf(filesOf({}), 'someone-else')).toBe(undefined)
  })
})

describe("an agent's record", () => {
  test('is a file named by the agent id, which cannot leave the records folder', async () => {
    const $ = filesOf({})
    expect(await recordPath($, 'a1b2c3')).toBe('/h/.claude/subcodex/agents/a1b2c3.json')
    expect(await recordPath($, '../x')).toBe('/h/.claude/subcodex/agents/%2E%2E%2Fx.json')
  })

  test('is written one write at a time, the later state last', async () => {
    const steps: string[] = []
    let open = 0
    const $ = {
      ...filesOf({}),
      fs: {
        write: async (_path: string, text: string) => {
          open++
          steps.push(`${open}:${(JSON.parse(text) as { unsent: string[] }).unsent.length}`)
          await new Promise(resolve => setTimeout(resolve, 5))
          open--
        },
      },
    } as unknown as EngineInterface
    const agent = agentWith(1)
    agent.unsent = ['One.']
    const first = remember($, 'a1', agent)
    agent.unsent = ['One.', 'Two.']
    await Promise.all([first, remember($, 'a1', agent)])
    expect(steps).toEqual(['1:2', '1:2'])
  })
})
