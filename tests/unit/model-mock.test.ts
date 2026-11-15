import { describe, expect, test } from 'claude-code/testing'
import type { Register } from 'claude-code'

import { toolsFor, RESULT } from '../../hooks/bridge'
import { agents, newAgent } from '../../hooks/agents'
import { LOCAL_MODEL, mockRequests, mockResponse, outputSchema, registerModelMock } from '../../hooks/model-mock'

describe('local model response mock', () => {
  test('JSON and SSE preserve the exact tool input and bind the acknowledgement to its ID', () => {
    const request = { kind: 'call' as const, name: 'SendMessage' as const, input: { to: 'parent', message: 'quotes "\n汉字', summary: 'progress' } }
    const message = JSON.parse(mockResponse(request, false, 'one').text)
    const wire = mockResponse(request, true, 'one').text.split('\n\n').filter(Boolean)
      .map(event => JSON.parse(event.split('\ndata: ')[1] as string))
    expect(message.model).toBe('<synthetic>')
    expect(message.content[0].input).toEqual(request.input)
    expect(JSON.parse(wire[2].delta.partial_json)).toEqual(request.input)
    expect(wire[4].delta.safeguard_results[0].status.tool_uses).toEqual({ one: { type: 'evaluated', outcome: 'not_flagged' } })
    expect(Object.values(message.usage).every(value => value === 0)).toBe(true)
  })

  test('a workflow result is submitted through a Codex tool that has the native schema', () => {
    const schema = { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } } }
    expect(outputSchema({ tools: [{ name: 'StructuredOutput', input_schema: schema }] })).toEqual(schema)
    expect(outputSchema({ tools: [{ name: 'Other', input_schema: schema }] })).toBe(undefined)
    expect(toolsFor(schema, []).find(tool => tool.name === RESULT)?.inputSchema).toEqual(schema)
    expect(toolsFor(undefined, []).some(tool => tool.name === RESULT)).toBe(false)
  })

  test('an error request is a response the engine does not retry', () => {
    const response = mockResponse({ kind: 'error', message: 'no result' }, true, 'bad')
    expect(response.status).toBe(400)
    expect(response.headers['x-should-retry']).toBe('false')
    expect(response.text).toContain('no result')
  })

  test('HTTP interception is per agent, preserves unrelated requests, and refuses missing protocol state', async () => {
    let handler: (...args: any[]) => Promise<any> = async () => undefined
    let catcher: (...args: any[]) => any = () => undefined
    registerModelMock(((_event: string, callback: typeof handler) => {
      handler = callback
      return { catch: (callback: typeof catcher) => { catcher = callback } }
    }) as unknown as Parameters<Register>[0])
    let network = 0
    const next = Object.assign(async () => { network++; return { value: 'network' } }, { origin: { plugin: 'engine' } })
    const $ = { ui: { log: () => undefined } }
    const first = newAgent({ model: undefined, effort: undefined }, 'auto', undefined)
    const second = newAgent({ model: undefined, effort: undefined }, 'auto', undefined)
    agents.set('mock-test-a', first)
    agents.set('mock-test-b', second)
    mockRequests.set('mock-test-a', { kind: 'call', name: 'SubagentHandback', input: { message: 'first' } })
    mockRequests.set('mock-test-b', { kind: 'call', name: 'SendMessage', input: { to: 'main', message: 'second' } })
    const event = (id: string, safeguards = true, model = LOCAL_MODEL) => ({ url: 'https://example.invalid/v1/messages', init: {
      headers: { 'X-Claude-Code-Agent-Id': id }, body: JSON.stringify({ model, safeguards: safeguards ? [{ type: 'dangerous_tool_use' }] : [] }),
    } })
    try {
      const a = await handler($, event('mock-test-a'), next)
      const b = await handler($, event('mock-test-b'), next)
      expect(JSON.parse(a.value.text).content[0].input.message).toBe('first')
      expect(JSON.parse(b.value.text).content[0].input.message).toBe('second')
      expect((await handler($, event('mock-test-a', false), next)).deny).toContain('unsupported')
      mockRequests.delete('mock-test-a')
      expect((await handler($, event('mock-test-a'), next)).deny).toContain('no pending')
      expect((await handler($, event('unknown'), next)).deny).toContain('no pending')
      expect(network).toBe(0)
      await handler($, event('foreign', true, 'some-real-model'), next)
      expect(network).toBe(1)
      const main = { url: 'https://example.invalid/v1/messages', init: { body: '{"model":"claude-main"}' } }
      expect(await handler($, main, next)).toEqual({ value: 'network' })
      expect(network).toBe(2)
      const pluginNext = Object.assign(async (e: unknown) => ({ forwarded: e }), { origin: { plugin: 'another-plugin' }, called: false })
      const pluginRequest = event('mock-test-b')
      expect((await handler($, pluginRequest, pluginNext)).forwarded).toBe(pluginRequest)
      // Simulate a hook failure/timeout before it gets to next(). Foreign
      // traffic must still pass, even while our own requests are pending.
      const failedNext = Object.assign(next, { called: false })
      expect(await catcher($, main, failedNext)).toEqual({ value: 'network' })
      expect(await catcher($, event('foreign', true, 'claude-other'), failedNext)).toEqual({ value: 'network' })
      expect((await catcher($, pluginRequest, pluginNext)).forwarded).toBe(pluginRequest)
      const before = network
      expect((await catcher($, event('mock-test-b'), failedNext)).deny).toContain('local protocol failed')
      expect(network).toBe(before)
    } finally {
      for (const id of ['mock-test-a', 'mock-test-b']) { agents.delete(id); mockRequests.delete(id) }
    }
  })
})
