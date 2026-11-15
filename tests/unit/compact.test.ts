import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { COMPACT_MARK, compacted } from '../../hooks/compact'
import { KEPT_CHARS } from '../../hooks/config'

// Compacting an agent's context without a model: the task, one line, the latest rows.

const said = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] }) as SessionMessage
const row = (n: number): SessionMessage[] => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${n}`, tool: 'Bash', input: { command: `scan ${n}` } }] } as unknown as SessionMessage,
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${n}`, isError: false, text: 'x'.repeat(8000) }] } as unknown as SessionMessage,
]

describe("cutting the engine's copy of the context", () => {
  test('the task stays first, a marked line says what is left out, the latest rows stay', () => {
    const messages = [said('user', 'Scan every shard.'), ...Array.from({ length: 40 }, (_, n) => row(n)).flat()]
    const cut = compacted(messages) ?? []
    expect(cut[0]).toEqual(messages[0])
    expect(cut[1]?.role).toBe('user')
    expect(cut[1]?.text.startsWith(COMPACT_MARK)).toBe(true)
    expect(cut[cut.length - 1]).toEqual(messages[messages.length - 1])
    expect(cut.length).toBeLessThan(messages.length)
    // What is kept is about the size it should be, not everything and not nothing.
    const size = JSON.stringify(cut.slice(2)).length
    expect(size).toBeGreaterThan(KEPT_CHARS / 2)
    expect(size).toBeLessThan(KEPT_CHARS * 1.5)
  })

  test('no call is parted from its result: the kept rows begin with a call', () => {
    const messages = [said('user', 'Scan.'), ...Array.from({ length: 40 }, (_, n) => row(n)).flat()]
    const cut = compacted(messages) ?? []
    expect(cut[2]?.role).toBe('assistant')
    const calls = cut.flatMap(m => m.toolUses.map(use => use.tool_use_id))
    const results = cut.flatMap(m => ((m as { toolResults?: { tool_use_id: string }[] }).toolResults ?? []).map(result => result.tool_use_id))
    expect(results).toEqual(calls)
  })

  test('where the size runs out in the middle of a pair, the cut moves on to the next call', () => {
    // Here the calls are the long rows and the results the short ones, so
    // counting back by size stops on a result.
    const pair = (n: number): SessionMessage[] => [
      { role: 'assistant', text: 'y'.repeat(9000), toolUses: [{ tool_use_id: `u${n}`, tool: 'Bash', input: { command: `scan ${n}` } }] } as unknown as SessionMessage,
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${n}`, isError: false, text: 'ok' }] } as unknown as SessionMessage,
    ]
    const cut = compacted([said('user', 'Scan.'), ...Array.from({ length: 40 }, (_, n) => pair(n)).flat()]) ?? []
    expect(cut[2]?.role).toBe('assistant')
    const calls = cut.flatMap(m => m.toolUses.map(use => use.tool_use_id))
    const results = cut.flatMap(m => ((m as { toolResults?: { tool_use_id: string }[] }).toolResults ?? []).map(result => result.tool_use_id))
    expect(results).toEqual(calls)
  })

  test('a conversation with nothing to leave out is not cut', () => {
    expect(compacted([said('user', 'Scan.'), ...row(0)])).toBeUndefined()
  })
})
