import { atom, read, update } from 'claude-code'
import type { EngineInterface, InstructionFile } from 'claude-code'

import { CONTEXT_KEYS, CONTEXT_TABLES, OWN_CODEX_HOME } from './config'
import type { Codex, Settings } from './types'

let found: Codex | undefined

/** The Codex binary, the home directory, the person's Codex defaults and models; looked up once. */
export async function findCodex($: EngineInterface): Promise<Codex> {
  if (found !== undefined) return found
  let bin = 'codex'
  const home = (await $.env.get('HOME')) ?? ''
  const defaults: Settings = { model: undefined, effort: undefined }
  const models: string[] = []
  let hasApprovalPolicy = false
  try {
    // The login shell's PATH; the last line, as a login shell may print first.
    const shell = (await $.env.get('SHELL')) ?? '/bin/sh'
    const asked = await $.process.run([shell, '-lc', 'command -v codex']).catch(() => undefined)
    const path = asked?.stdout.trim().split('\n').pop() ?? ''
    if (path.startsWith('/')) bin = path
    // Top-level keys: the text before the first table header.
    const config = await $.fs.read(`${home}/${OWN_CODEX_HOME}/config.toml`)
    const top = config.split(/^\[/m)[0] ?? ''
    defaults.model = /^model\s*=\s*"([^"]+)"/m.exec(top)?.[1]
    defaults.effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1]
    hasApprovalPolicy = /^approval_policy\s*=/m.test(top)
    // The models Codex lists, from its cache.
    const cache = JSON.parse(
      await $.fs.read(`${home}/${OWN_CODEX_HOME}/models_cache.json`),
    ) as { models?: { slug?: string; visibility?: string }[] }
    for (const model of cache.models ?? []) {
      if (model.visibility === 'list' && typeof model.slug === 'string') {
        models.push(model.slug)
      }
    }
  } catch {
  }
  found = { bin, home, defaults, models, hasApprovalPolicy }
  return found
}

/** The person's Codex login (access token and account), read for a server; never stored or logged. */
export async function loginOf(
  $: EngineInterface,
  home: string,
): Promise<
  | { accessToken: string; chatgptAccountId: string; chatgptPlanType: null }
  | undefined
> {
  try {
    const auth = JSON.parse(await $.fs.read(`${home}/${OWN_CODEX_HOME}/auth.json`)) as {
      tokens?: { access_token?: string; account_id?: string }
    }
    const accessToken = auth.tokens?.access_token
    const chatgptAccountId = auth.tokens?.account_id
    return accessToken === undefined || chatgptAccountId === undefined
      ? undefined
      : { accessToken, chatgptAccountId, chatgptPlanType: null }
  } catch {
    return undefined
  }
}

/** How many more brackets and braces a line opens than it closes, outside strings and comments. */
export function depthOf(text: string): number {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '')
  return (bare.match(/[[{]/g)?.length ?? 0) - (bare.match(/[\]}]/g)?.length ?? 0)
}

/**
 * The person's Codex config without its context tables and keys (config.ts),
 * including ones set before the first header, inline or dotted.
 */
export function ownConfig(text: string): string {
  const kept: string[] = []
  let isTop = true
  let isDropping = false
  /** What ends a left-out value that spans lines: closing quotes, or bracket depth. */
  let closing: string | undefined
  let depth = 0
  for (const line of text.split('\n')) {
    if (closing !== undefined) {
      if (line.includes(closing)) closing = undefined
      continue
    }
    if (depth > 0) {
      depth += depthOf(line)
      continue
    }
    const header = /^\s*\[\[?\s*["']?([A-Za-z0-9_-]+)/.exec(line)
    if (header !== null) {
      isTop = false
      isDropping = CONTEXT_TABLES.includes(header[1] ?? '')
    }
    if (isDropping) continue
    const key = isTop ? /^\s*["']?([A-Za-z0-9_-]+)["']?\s*(\.[^=]*)?=\s*(.*)$/.exec(line) : null
    const name = key?.[1] ?? ''
    if (key !== null && (CONTEXT_TABLES.includes(name) || (key[2] === undefined && CONTEXT_KEYS.includes(name)))) {
      const value = key[3] ?? ''
      const quote = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : undefined
      if (quote !== undefined && !value.slice(3).includes(quote)) closing = quote
      else if (/^[[{]/.test(value)) depth = Math.max(0, depthOf(value))
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** Which plugins the settings turn on or off (`enabledPlugins`): the person's, then the project's, then the local ones. */
async function pluginSwitches($: EngineInterface, home: string, cwd: string): Promise<Record<string, boolean>> {
  const switches: Record<string, boolean> = {}
  for (const path of [`${home}/.claude/settings.json`, `${cwd}/.claude/settings.json`, `${cwd}/.claude/settings.local.json`]) {
    try {
      const settings = JSON.parse(await $.fs.read(path)) as { enabledPlugins?: Record<string, unknown> }
      for (const [name, isOn] of Object.entries(settings.enabledPlugins ?? {})) switches[name] = isOn !== false
    } catch {
      // No such settings, or none readable.
    }
  }
  return switches
}

/**
 * Claude Code's skill folders that exist: the person's, the project's, each
 * installed plugin's that the settings do not turn off (installed for the
 * person, or for this project), and each plugin folder
 * `CLAUDE_CODE_PLUGIN_DIRS` names.
 */
export async function skillRoots(
  $: EngineInterface,
  home: string,
  cwd: string,
): Promise<string[]> {
  const roots = [`${home}/.claude/skills`, `${cwd}/.claude/skills`]
  const switches = await pluginSwitches($, home, cwd)
  const project = await $.session.root().catch(() => cwd)
  try {
    const installed = JSON.parse(
      await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`),
    ) as { plugins?: Record<string, { installPath?: string; scope?: string; projectPath?: string }[]> }
    for (const [name, entries] of Object.entries(installed.plugins ?? {})) {
      if (switches[name] === false) continue
      for (const entry of entries) {
        const isHere = entry.scope === undefined || entry.scope === 'user' || entry.projectPath === project
        if (isHere && entry.installPath !== undefined) roots.push(`${entry.installPath}/skills`)
      }
    }
  } catch {
    // No plugins on record.
  }
  const dirs = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? ''
  for (const dir of dirs.split(':')) if (dir.trim() !== '') roots.push(`${dir.trim().replace(/\/$/, '')}/skills`)
  const there: string[] = []
  for (const root of new Set(roots)) {
    if (await $.fs.exists(root).catch(() => false)) there.push(root)
  }
  return there
}

/** The instruction files the engine loaded for this session's context; null until it has. */
const instructions = atom({ plugin: 'subcodex', key: 'instructions' } as const, null)

/** Keeps the instruction files the engine loaded for the session's context. */
export async function keepInstructions(
  $: EngineInterface,
  files: readonly InstructionFile[],
): Promise<void> {
  const kept = files.map(file => ({ path: file.path, content: file.content }))
  await update($, instructions, () => kept).catch(() => undefined)
}

/**
 * The Claude Code instructions a subagent would have in its context: the
 * files the engine loaded for this session, else the CLAUDE.md files here.
 */
export async function claudeInstructions(
  $: EngineInterface,
  home: string,
  cwd: string,
): Promise<string[]> {
  const framed = (path: string, text: string): string =>
    `Instructions the Claude Code session has in ${path} (written for Claude Code; follow what applies to your task):\n${text}`
  const loaded = await read($, instructions).catch(() => null)
  if (loaded !== null) {
    return loaded.filter(file => file.content.trim() !== '').map(file => framed(file.path, file.content.trim()))
  }
  const parts: string[] = []
  for (const path of [`${home}/.claude/CLAUDE.md`, `${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`]) {
    try {
      const text = (await $.fs.read(path)).trim()
      if (text !== '') parts.push(framed(path, text))
    } catch {
      // No such file.
    }
  }
  return parts
}
