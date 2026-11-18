import { atom, read, update } from 'claude-code'
import type { EngineInterface, InstructionFile } from 'claude-code'

import { CONTEXT_KEYS, CONTEXT_TABLES, OWN_CODEX_HOME } from './config'
import { folderList, homeOf, hostRun, isAbsolute, isWindows } from './host'
import type { Codex, Settings } from './types'

let found: Codex | undefined

/** The Codex binary, the home directory, the person's Codex defaults and models; looked up once. */
export async function findCodex($: EngineInterface): Promise<Codex> {
  if (found !== undefined) return found
  let bin = 'codex'
  const home = await homeOf($)
  let settings = defaultsOf('')
  const models: string[] = []
  let isHostMissing = false
  try {
    // Where `codex` is (`find`): the last line, as a login shell may print first.
    const shell = (await $.env.get('SHELL')) ?? '/bin/sh'
    const asked = await hostRun($, 'find', [shell]).catch((error: unknown) => {
      isHostMissing = isWindows($) && /\bENOENT\b/.test(String(error))
      return undefined
    })
    const path = asked?.stdout.trim().split('\n').pop()?.trim() ?? ''
    if (isAbsolute(path)) bin = path
    settings = defaultsOf(await $.fs.read(`${home}/${OWN_CODEX_HOME}/config.toml`))
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
  found = { bin, home, ...settings, models, isHostMissing }
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
function depthOf(text: string): number {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '')
  return (bare.match(/[[{]/g)?.length ?? 0) - (bare.match(/[\]}]/g)?.length ?? 0)
}

/** One part of a dotted TOML key: bare, or quoted. */
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`

/** A key at the start of a TOML line, and what follows its `=`. */
const KEY = new RegExp(String.raw`^\s*(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*=\s*(.*)$`)

/** A TOML name without its quotes and spaces: `projects."/a b"` is `projects./ab`. */
const bare = (name: string): string => name.replace(/["'\s]/g, '')

/** The first part of a dotted TOML name. */
const headOf = (name: string): string => name.split('.')[0] ?? ''

/** One line of a TOML text, with the lines of a value it starts that spans lines. */
type Statement = {
  lines: string[]
  /** The table it is in, or the table a header opens, its parts joined by dots; '' before the first header. */
  table: string
  /** The key it sets, its dotted parts joined; undefined for a header and a line without a key. */
  key: string | undefined
  /** What follows the key's `=` on its first line. */
  value: string
}

/** A TOML text, line by line; a value that spans lines is part of the statement it starts. */
function statementsOf(toml: string): Statement[] {
  const all: Statement[] = []
  let table = ''
  /** What ends a value that spans lines: closing quotes, or bracket depth. */
  let closing: string | undefined
  let depth = 0
  for (const line of toml.split('\n')) {
    if (closing !== undefined || depth > 0) {
      all[all.length - 1]?.lines.push(line)
      if (closing === undefined) depth += depthOf(line)
      else if (line.includes(closing)) closing = undefined
      continue
    }
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]/.exec(line)
    if (header !== null) table = bare(header[1] ?? '')
    const key = header === null ? KEY.exec(line) : null
    const value = key?.[2] ?? ''
    all.push({ lines: [line], table, key: key === null ? undefined : bare(key[1] ?? ''), value })
    const quote = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : undefined
    if (quote !== undefined && !value.slice(3).includes(quote)) closing = quote
    else if (/^[[{]/.test(value)) depth = Math.max(0, depthOf(value))
  }
  return all
}

/** The model and effort a Codex config sets before its first header, and whether it sets an approval policy there. */
export function defaultsOf(config: string): { defaults: Settings; hasApprovalPolicy: boolean } {
  const top = new Map<string, string>()
  for (const { table, key, value } of statementsOf(config)) {
    if (table === '' && key !== undefined && !top.has(key)) top.set(key, value)
  }
  /** A string value on one line, without its quotes. */
  const text = (key: string): string | undefined => {
    const found = /^(?:"([^"]+)"|'([^']+)')/.exec(top.get(key) ?? '')
    return found?.[1] ?? found?.[2]
  }
  return {
    defaults: { model: text('model'), effort: text('model_reasoning_effort') },
    hasApprovalPolicy: top.has('approval_policy'),
  }
}

/**
 * The person's Codex config without its context tables and keys (config.ts),
 * including ones set before the first header, inline or dotted.
 */
export function ownConfig(text: string): string {
  const isContext = ({ table, key }: Statement): boolean =>
    table !== ''
      ? CONTEXT_TABLES.includes(headOf(table))
      : key !== undefined && (CONTEXT_TABLES.includes(headOf(key)) || CONTEXT_KEYS.includes(key))
  return statementsOf(text)
    .filter(statement => !isContext(statement))
    .flatMap(statement => statement.lines)
    .join('\n')
}

/** The keys a TOML text sets, each with the table it is in (`table.key`, dotted keys joined); values that span lines are skipped. */
export function keysOf(toml: string): string[] {
  return statementsOf(toml).flatMap(({ table, key, value }) => {
    if (key === undefined) return []
    const name = table === '' ? key : `${table}.${key}`
    // An inline table: `windows = { sandbox = "mxc" }`.
    const inner = (value.match(/[{,]\s*([A-Za-z0-9_-]+)\s*=/g) ?? []).map(found => `${name}.${bare(found.replace(/^[{,]|=$/g, ''))}`)
    return [name, ...inner]
  })
}

/**
 * What Codex's server is also started with: on Windows, where the person's
 * Codex config chooses neither `features.prefer_mxc` nor `windows.sandbox`,
 * Codex prefers its MXC sandbox, and says nothing of the feature being under
 * development.
 */
export function sandboxChoice($: EngineInterface, config: string): string[] {
  if (!isWindows($)) return []
  const keys = keysOf(config)
  if (keys.includes('features.prefer_mxc') || keys.includes('windows.sandbox')) return []
  return ['-c', 'features.prefer_mxc=true', '-c', 'suppress_unstable_features_warning=true']
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
  for (const dir of folderList($, (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '')) roots.push(`${dir}/skills`)
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
