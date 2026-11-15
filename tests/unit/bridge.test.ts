import { describe, expect, test } from 'claude-code/testing'

import type { ToolInfo } from 'claude-code'

import { MESSAGE, RESULT, claudeName, imagesOf, isOffered, sessionTools, toolsFor } from '../../hooks/bridge'

// Which of the session's tools Codex is offered.

describe("the session's tools Codex is offered", () => {
  test('not the built-in ones: Codex has its own shell, files, web search, plan, sub-agents and skills, and the rest steer the conversation', () => {
    for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Agent', 'Skill', 'ToolSearch', 'AskUserQuestion', 'Workflow', 'Artifact', 'CronCreate', 'Monitor']) {
      expect(isOffered(tool)).toBe(false)
    }
  })

  test("what the session has connected: an MCP server's tools, a connector's, another plugin's", () => {
    for (const tool of ['mcp__gmail__send_message', 'mcp__0f3e2d1c-5b6a__batch', 'mcp__easel__chart', 'mcp__subcodex-fixture__stamp']) {
      expect(isOffered(tool)).toBe(true)
    }
  })

  test("not the desktop app's controls of the conversation, and not this mod's own", () => {
    for (const tool of ['mcp__ccd_session__start_session', 'mcp__ccd_session_mgmt__delete_session', 'mcp__ccd_settings__set_setting', 'mcp__subcodex__approve', 'mcp__subcodex__checkpoint']) {
      expect(isOffered(tool)).toBe(false)
    }
  })
})

describe('the session tools as Codex is given them', () => {
  const tools: ToolInfo[] = [
    { name: 'mcp__easel__chart', description: 'Draw a chart.', mcp: true },
    { name: 'mcp__easel__table', description: '', mcp: true },
    { name: 'mcp__0f3e2d1c-5b6a-4c7d-8e9f-a0b1c2d3e4f5__batch', description: 'Apply operations.', mcp: true },
    { name: 'mcp__ccd_session__start_session', description: 'Start a session.', mcp: true },
    { name: 'mcp__subcodex__checkpoint', description: 'The mod own.', mcp: false },
    { name: 'Bash', description: 'Run a command.', mcp: false },
    { name: `mcp__${'s'.repeat(60)}__tool`, description: 'A connection name too long for a namespace.', mcp: true },
  ]

  test('one namespace per connection, named claude_<connection>, of deferred tools without schemas', () => {
    const spec = sessionTools(tools) as { type: string; name: string; tools: Record<string, unknown>[] }[]
    expect(spec.map(one => [one.type, one.name])).toEqual([
      ['namespace', 'claude_easel'],
      ['namespace', 'claude_0f3e2d1c-5b6a-4c7d-8e9f-a0b1c2d3e4f5'],
    ])
    expect(spec[0]?.tools.map(tool => [tool.name, tool.description, tool.deferLoading])).toEqual([
      ['chart', 'Draw a chart.', true],
      ['table', 'mcp__easel__table', true],
    ])
    expect(spec[0]?.tools[0]?.inputSchema).toEqual({ type: 'object', additionalProperties: true })
  })

  test("a call of Codex's names the session tool again, or one of the mod's own", () => {
    expect(claudeName('claude_easel', 'chart')).toBe('mcp__easel__chart')
    expect(claudeName('claude_0f3e2d1c-5b6a-4c7d-8e9f-a0b1c2d3e4f5', 'batch')).toBe('mcp__0f3e2d1c-5b6a-4c7d-8e9f-a0b1c2d3e4f5__batch')
    expect(claudeName(null, MESSAGE)).toBe(MESSAGE)
    expect(claudeName(undefined, RESULT)).toBe(RESULT)
  })

  test('a new thread gets the message tool, the result tool only with a schema, then the session tools', () => {
    const schema = { type: 'object', properties: { answer: { type: 'integer' } } }
    expect(toolsFor(undefined, tools).map(tool => tool.name)).toEqual([MESSAGE, 'claude_easel', 'claude_0f3e2d1c-5b6a-4c7d-8e9f-a0b1c2d3e4f5'])
    expect(toolsFor(schema, []).map(tool => tool.name)).toEqual([MESSAGE, RESULT])
  })
})

describe("the images of a session tool's result", () => {
  test('base64 images become data URLs, web images keep their URL, text and other blocks give none', () => {
    const result = [
      { type: 'text', text: 'Here.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
    ]
    expect(imagesOf(result)).toEqual(['data:image/png;base64,AAAA', 'https://example.com/a.png'])
  })

  test('a result that is text has none', () => {
    expect(imagesOf('STAMP-x-OK')).toEqual([])
    expect(imagesOf(undefined)).toEqual([])
  })
})
