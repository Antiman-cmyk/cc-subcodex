import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { skillRoots } from '../../hooks/codex-home'

// Which of Claude Code's skill folders Codex is given.

describe("Claude's skill folders", () => {
  const files: Record<string, string> = {
    '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }),
    '/w/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'a@m': false, 'c@m': true } }),
    '/h/.claude/plugins/installed_plugins.json': JSON.stringify({
      plugins: {
        'a@m': [{ installPath: '/p/a', scope: 'user' }],
        'b@m': [{ installPath: '/p/b', scope: 'user' }],
        'c@m': [{ installPath: '/p/c', scope: 'user' }],
        'd@m': [{ installPath: '/p/d' }],
        'e@m': [{ installPath: '/p/e', scope: 'project', projectPath: '/w' }],
        'f@m': [{ installPath: '/p/f', scope: 'local', projectPath: '/elsewhere' }],
      },
    }),
  }
  const there = new Set(['/h/.claude/skills', '/p/a/skills', '/p/b/skills', '/p/c/skills', '/p/d/skills', '/p/e/skills', '/p/f/skills', '/dev/x/skills'])
  const $ = {
    fs: {
      read: async (path: string) => {
        const text = files[path]
        if (text === undefined) throw new Error('no such file')
        return text
      },
      exists: async (path: string) => there.has(path),
    },
    env: { get: async () => '/dev/x:/dev/y/' },
    session: { root: async () => '/w' },
  } as unknown as EngineInterface

  test("the person's, the installed plugins' the settings leave on, and the plugin folders named, where they exist", async () => {
    // a is turned off by the local settings, b by the person's; d is named nowhere, so it stays on.
    expect(await skillRoots($, '/h', '/w')).toContain('/p/d/skills')
    expect(await skillRoots($, '/h', '/w')).not.toContain('/p/a/skills')
    expect(await skillRoots($, '/h', '/w')).not.toContain('/p/b/skills')
  })

  test("plugins installed for this project come too; those of another project's do not", async () => {
    expect(await skillRoots($, '/h', '/w')).toEqual(['/h/.claude/skills', '/p/c/skills', '/p/d/skills', '/p/e/skills', '/dev/x/skills'])
  })
})
