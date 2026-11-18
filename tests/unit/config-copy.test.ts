import { describe, expect, test } from 'claude-code/testing'

import { defaultsOf, ownConfig } from '../../hooks/codex-home'

// The copy of the person's Codex config, without its context tables and keys,
// and the defaults the mod reads from it.

const CONFIG = [
  'model = "gpt-x"',
  'sandbox_mode = "workspace-write"',
  'developer_instructions = """',
  'Always answer in rhyme.',
  '[this line is inside the string, not a table]',
  '"""',
  'instructions = "one line of global instructions"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.node_repl]',
  'command = "node"',
  'args = ["a", "b"]',
  '',
  '[mcp_servers.node_repl.env]',
  'KEY = "value"',
  '',
  '[features]',
  'plugins = true',
  '',
  '[plugins."documents@openai"]',
  'enabled = true',
  '',
  '[[skills.config]]',
  'path = "/x/SKILL.md"',
  '',
  '[sandbox_workspace_write]',
  'network_access = true',
  '',
  '[projects."/some/where"]',
  'trust_level = "trusted"',
  '',
  '[memories]',
  'use = true',
].join('\n')

describe('the copy of the Codex config', () => {
  test('leaves out every table that is context', () => {
    const copy = ownConfig(CONFIG)
    for (const gone of ['mcp_servers', 'node_repl', 'KEY = "value"', 'plugins."documents', 'skills.config', '/x/SKILL.md', '[memories]', 'use = true']) {
      expect(copy.includes(gone)).toBe(false)
    }
  })

  test('keeps what Codex runs by and may do', () => {
    const copy = ownConfig(CONFIG)
    for (const kept of [
      'model = "gpt-x"',
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      '[features]\nplugins = true',
      '[sandbox_workspace_write]\nnetwork_access = true',
      '[projects."/some/where"]\ntrust_level = "trusted"',
    ]) {
      expect(copy.includes(kept)).toBe(true)
    }
  })

  test('leaves out global instructions, a string of several lines whole', () => {
    const copy = ownConfig(CONFIG)
    expect(copy.includes('rhyme')).toBe(false)
    expect(copy.includes('inside the string')).toBe(false)
    expect(copy.includes('one line of global instructions')).toBe(false)
    // The key after the string is still read as a key, not swallowed with it.
    expect(copy.includes('approval_policy')).toBe(true)
  })

  test('a context table set in place before the first header goes too, inline or dotted, whole', () => {
    const copy = ownConfig(
      [
        'model = "gpt-x"',
        'mcp_servers = { node_repl = { command = "node" } }',
        'mcp_servers.computer-use.command = "cu"',
        '"apps".docs.enabled = true',
        'plugins."documents@openai".enabled = true',
        'mcp_servers . "a/b:c" . command = "x"',
        'plugins = [',
        '  "documents@openai",',
        '  "pdf@openai",',
        ']',
        'instructions = "has [a bracket"',
        'sandbox_mode = "workspace-write"',
        '[tui]',
        'mcp_servers.x = "a key of the tui table, not the context table"',
      ].join('\n'),
    )
    for (const gone of ['node_repl', 'computer-use', 'docs.enabled', 'documents@openai', 'a/b:c', 'pdf@openai', 'a bracket']) {
      expect(copy.includes(gone)).toBe(false)
    }
    // What follows each of them is read as its own key again.
    for (const kept of ['model = "gpt-x"', 'sandbox_mode = "workspace-write"', '[tui]\nmcp_servers.x']) {
      expect(copy.includes(kept)).toBe(true)
    }
  })

  test('brackets inside strings and comments of a left-out value do not hide the keys after it', () => {
    const copy = ownConfig(
      [
        'mcp_servers = {',
        '  x = { command = "node", args = ["--glob=[a-z", \'[raw\'] }, # a [comment',
        '}',
        'sandbox_mode = "workspace-write"',
        'approval_policy = "on-request"',
      ].join('\n'),
    )
    expect(copy.includes('--glob')).toBe(false)
    expect(copy.includes('sandbox_mode = "workspace-write"')).toBe(true)
    expect(copy.includes('approval_policy = "on-request"')).toBe(true)
  })

  test('a key named like a context key inside a kept table stays', () => {
    const copy = ownConfig('[profiles.work]\ninstructions = "kept"\n')
    expect(copy.includes('instructions = "kept"')).toBe(true)
  })

  test('a value that spans lines goes or stays whole, whatever its lines look like', () => {
    const kept = ownConfig(['[profiles.work]', 'notes = """', '[mcp_servers.x]', '"""', 'model = "kept"', '[mcp_servers.y]', 'command = "gone"'].join('\n'))
    expect(kept).toBe(['[profiles.work]', 'notes = """', '[mcp_servers.x]', '"""', 'model = "kept"'].join('\n'))
    const gone = ownConfig(['[mcp_servers.x]', 'notes = """', '[features]', '"""', '[features]', 'plugins = true'].join('\n'))
    expect(gone).toBe('[features]\nplugins = true')
  })

  test('an empty or missing config is an empty copy', () => {
    expect(ownConfig('')).toBe('')
  })
})

describe("the person's Codex defaults", () => {
  test('are the model and effort set before the first header', () => {
    expect(defaultsOf(CONFIG)).toEqual({ defaults: { model: 'gpt-x', effort: undefined }, hasApprovalPolicy: true })
    expect(defaultsOf("  \"model\" = 'gpt-y'\nmodel_reasoning_effort = \"high\"\n").defaults).toEqual({ model: 'gpt-y', effort: 'high' })
    expect(defaultsOf('[profiles.work]\nmodel = "gpt-z"\nmodel_reasoning_effort = "low"').defaults).toEqual({ model: undefined, effort: undefined })
    expect(defaultsOf('model = 5\nmodel_reasoning_effort = ""').defaults).toEqual({ model: undefined, effort: undefined })
  })

  test('set an approval policy only by its own key before the first header', () => {
    expect(defaultsOf('approval_policy = "never"').hasApprovalPolicy).toBe(true)
    expect(defaultsOf('"approval_policy" = "never"').hasApprovalPolicy).toBe(true)
    for (const config of ['', 'approval_policy.x = 1', '[approval_policy]\nx = 1', '[profiles.work]\napproval_policy = "never"', 'notes = """\napproval_policy = "never"\n"""']) {
      expect(defaultsOf(config).hasApprovalPolicy).toBe(false)
    }
  })
})
