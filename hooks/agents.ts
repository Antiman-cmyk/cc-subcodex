import type { EngineInterface } from 'claude-code'

import { findCodex } from './codex-home'
import { COMPACT_MARK } from './compact'
import { AGENTS_DIR, TYPE } from './config'
import type { Agent, Settings } from './types'

/** This session's Codex agents, by agent id. */
export const agents = new Map<string, Agent>()
/** Each agent's type, as looked up. */
const types = new Map<string, string>()
/** Settings of an Agent call for this type, by its tool_use_id. */
export const planned = new Map<string, Settings>()

export const noteType = (agentId: string, type: string): void => {
  types.set(agentId, type)
}

/** Lookups of agents the session does not list. */
const misses = new Map<string, number>()

/**
 * An agent's type: as noted, as the session lists it, else this type where
 * the mod keeps a record of it (a workflow's agents are not listed); empty
 * otherwise. An agent still starting is listed a moment later, so only a
 * third miss is final.
 */
export async function typeOf($: EngineInterface, agentId: string): Promise<string> {
  const known = types.get(agentId)
  if (known !== undefined) return known
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  const path = info === undefined ? await recordPath($, agentId) : undefined
  const isKept = path !== undefined && (await $.fs.exists(path).catch(() => false))
  const type = info?.type ?? (isKept ? TYPE : undefined)
  if (type !== undefined) {
    types.set(agentId, type)
    return type
  }
  const missed = (misses.get(agentId) ?? 0) + 1
  misses.set(agentId, missed)
  if (missed >= 3) types.set(agentId, '')
  return ''
}

export const newAgent = (
  settings: Settings,
  mode: string | undefined,
  cwd: string | undefined,
): Agent => ({
  settings,
  mode,
  cwd,
  caller: undefined,
  task: '',
  isReview: false,
  run: undefined,
  closing: undefined,
  carryOn: undefined,
  turnId: undefined,
  isReminded: false,
  hasResult: false,
  turns: 0,
  threadId: undefined,
  conn: undefined,
  limits: new Map(),
  turnReport: '',
  unsent: [],
  given: [],
  isWorkflow: false,
  isPrepared: false,
  outputSchema: undefined,
  relay: undefined,
})

/** The review request for `@codex review` with nothing after it. */
export const REVIEW_CHANGES = 'Review the uncommitted changes.'

/** Reads a leading `@codex [review] [model=<id>] [effort=<level>]` line and the prompt after it. */
export function readDirective(prompt: string): { asked: Settings; isReview: boolean; rest: string } {
  const asked: Settings = { model: undefined, effort: undefined }
  const found = /^\s*@codex\b([^\n]*)\n?/.exec(prompt)
  if (found === null) return { asked, isReview: false, rest: prompt }
  let isReview = false
  for (const part of (found[1] ?? '').trim().split(/\s+/)) {
    if (part === 'review') isReview = true
    const at = part.indexOf('=')
    if (at < 1) continue
    const value = part.slice(at + 1)
    if (value === '') continue
    if (part.slice(0, at) === 'model') asked.model = value
    if (part.slice(0, at) === 'effort') asked.effort = value
  }
  const rest = prompt.slice(found[0].length)
  return { asked, isReview, rest: isReview && rest.trim() === '' ? REVIEW_CHANGES : rest }
}

/** Model: the `@codex` line, else Codex's config. Effort: the line, the call, else the config. */
export async function settingsFor(
  $: EngineInterface,
  prompt: string,
  callEffort: string | undefined,
): Promise<Settings> {
  const { asked } = readDirective(prompt)
  const { defaults } = await findCodex($)
  return {
    model: asked.model ?? defaults.model,
    effort: asked.effort ?? callEffort ?? defaults.effort,
  }
}

/** The file of an agent's record (`AGENTS_DIR`); undefined without a home directory. */
export async function recordPath($: EngineInterface, agentId: string): Promise<string | undefined> {
  const { home } = await findCodex($)
  if (home === '') return undefined
  return `${home}/${AGENTS_DIR}/${encodeURIComponent(agentId).replace(/\./g, '%2E')}.json`
}

/** What an agent's record holds. */
export type AgentRecord = {
  threadId?: string
  settings?: Settings
  mode?: string
  cwd?: string
  caller?: string
  unsent?: string[]
  isWorkflow?: boolean
}

/** Each agent's latest record write, which the next one waits for. */
const writing = new Map<string, Promise<void>>()

/** Writes an agent's record, for a later session or a reload; one write at a time per agent. */
export async function remember(
  $: EngineInterface,
  agentId: string,
  agent: Agent,
): Promise<void> {
  const write = async (): Promise<void> => {
    try {
      const path = await recordPath($, agentId)
      if (path === undefined) return
      const record: AgentRecord = {
        threadId: agent.threadId,
        settings: agent.settings,
        mode: agent.mode,
        cwd: agent.cwd,
        caller: agent.caller,
        unsent: agent.unsent,
        isWorkflow: agent.isWorkflow,
      }
      await $.fs.write(path, JSON.stringify(record))
    } catch {
    }
  }
  const written = (writing.get(agentId) ?? Promise.resolve()).then(write)
  writing.set(agentId, written)
  await written
}

/** An agent's record, read from its file; undefined if there is none or it cannot be read. */
export async function recordOf($: EngineInterface, path: string): Promise<AgentRecord | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as AgentRecord
  } catch {
    return undefined
  }
}

/** An agent's record: kept in memory, else restored from its file. */
export async function agentOf(
  $: EngineInterface,
  agentId: string,
): Promise<Agent | undefined> {
  const known = agents.get(agentId)
  if (known !== undefined) return known
  if ((await typeOf($, agentId)) !== TYPE) return undefined
  const path = await recordPath($, agentId)
  const kept = path === undefined ? undefined : await recordOf($, path)
  const agent = newAgent(
    kept?.settings ?? (await settingsFor($, '', undefined)),
    kept?.mode,
    kept?.cwd,
  )
  agent.threadId = kept?.threadId
  agent.caller = kept?.caller
  agent.unsent = kept?.unsent ?? []
  agent.isWorkflow = kept?.isWorkflow ?? false
  agents.set(agentId, agent)
  return agent
}

/** Whether a user row is something said to the agent, not text the host adds. */
const isSaid = (text: string): boolean => {
  const said = text.trim()
  return (
    said !== '' &&
    !said.startsWith('<system-reminder>') &&
    !said.startsWith('<task-notification') &&
    !said.startsWith(COMPACT_MARK) &&
    !said.startsWith('[handback-send-enforce]') &&
    !said.startsWith('[Request interrupted')
  )
}

/**
 * What the agent has been told, oldest first: its task and each later message
 * (`all`), and those since its last reply (`fresh`). For an agent whose
 * conversation cannot be read (a workflow's), its task.
 */
export async function saidTo(
  $: EngineInterface,
  agentId: string,
  agent: Agent,
): Promise<{ all: string[]; fresh: string[] }> {
  const unread = { all: [agent.task], fresh: agent.turns === 0 ? [agent.task] : [] }
  try {
    const rows = await $.session.messages({ agentId })
    if (!Array.isArray(rows)) return unread
    const replied = rows.map(row => row.role).lastIndexOf('assistant')
    const said = (from: number): string[] =>
      rows.slice(from).filter(row => row.role === 'user' && isSaid(row.text)).map(row => row.text)
    const all = said(0)
    return all.length > 0 ? { all, fresh: said(replied + 1) } : unread
  } catch {
    return unread
  }
}

/** Messages Codex has not taken in, other than those its latest turn was given. */
export const untaken = (agent: Agent): string[] => agent.unsent.filter(text => !agent.given.includes(text))

/** `more` added to `kept`, less any message already there. */
export function merged(kept: string[], more: string[]): string[] {
  const all = [...kept]
  const seen = new Set(kept.map(text => text.trim()))
  for (const text of more) {
    if (seen.has(text.trim())) continue
    seen.add(text.trim())
    all.push(text)
  }
  return all
}
