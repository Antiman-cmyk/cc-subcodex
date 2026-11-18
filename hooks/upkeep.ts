import type { EngineInterface } from 'claude-code'

import { agents, recordOf } from './agents'
import { findCodex, loginOf } from './codex-home'
import { AGENTS_DIR, DATA_DIR, OWN_CODEX_HOME, PLUGIN, USAGE_MARK } from './config'
import { HOST_MISSING, codexSearch, hostRun, isAbsolute, type Op } from './host'
import { limitKey, limitText } from './usage'
import type { Limit } from './types'
import { forgetLastPass } from './usage-links'

// `/subcodex`: the mod's status (Codex, defaults, login, last usage limits),
// what it keeps on disk (session files, their links in the person's Codex
// home, agent records), and cleaning that up by age or entirely. The host
// operations `look`, `prune` and `wipe` (host.ts) do the disk work.
// Cleaning by age has the next usage-link pass look at every day folder.

/** The command's name. */
export const COMMAND = PLUGIN

/** Store key of the last reported usage limits. */
const LIMITS = 'limits'

/** Stores the usage limits a turn reported, for `/subcodex`. */
export async function keepLimits($: EngineInterface, limits: Map<string, Limit>): Promise<void> {
  if (limits.size === 0) return
  const kept = (await $.store.get(LIMITS)) as { limits?: Limit[] } | undefined
  const known = new Map((kept?.limits ?? []).map(limit => [limitKey(limit), limit]))
  for (const [key, limit] of limits) known.set(key, limit)
  await $.store.set(LIMITS, { at: Date.now(), limits: [...known.values()] })
}

/** Status lines: Codex, its defaults, the login, the last usage limits. */
async function standing($: EngineInterface): Promise<string[]> {
  const { bin, home, defaults, isHostMissing } = await findCodex($)
  const lines: string[] = []
  if (isHostMissing) {
    lines.push(`Codex: not looked for. ${HOST_MISSING}`)
  } else if (!isAbsolute(bin)) {
    const { where, fix } = codexSearch($)
    lines.push(`Codex: not found on ${where}. Install the Codex CLI, or ${fix}; then start a new session.`)
  } else {
    const version = (await hostRun($, 'version', [bin]).catch(() => undefined))?.stdout.trim()
    lines.push(
      `Codex: ${bin}${version === undefined || version === '' ? '' : ` (${version})`}. An agent runs on model ${defaults.model ?? "Codex's own default"}, effort ${defaults.effort ?? "Codex's own default"}, unless its call says otherwise.`,
    )
  }
  const login = `${home}/${OWN_CODEX_HOME}/auth.json`
  lines.push(
    (await loginOf($, home)) === undefined
      ? `Login: none in ${login}. Open Codex, or run \`codex login\`.`
      : `Login: found in ${login}.`,
  )
  const kept = (await $.store.get(LIMITS)) as { at?: number; limits?: Limit[] } | undefined
  // Limits whose window has reset are left out.
  const current = (kept?.limits ?? []).filter(
    limit => limit.resetsAt === undefined || limit.resetsAt * 1000 > Date.now(),
  )
  lines.push(
    kept?.at === undefined || current.length === 0
      ? 'Usage limits: none on record. Codex says them while an agent runs.'
      : `Usage limits, as Codex last said them (${new Date(kept.at).toLocaleString()}): ${current.map(limitText).join('; ')}.`,
  )
  return lines
}

const BUSY = 'A Codex agent is at work, in this session or another. Clean when it has finished.'

const HOW = [
  `/${COMMAND} clean <days>   removes the session files last written more than <days> days ago, with their links and records; Codex's own databases stay. Any link the other session files are missing is made as the next Codex agent starts. An agent whose session is gone starts afresh if it is sent another message, and usage tools no longer find those sessions.`,
  `/${COMMAND} clean all      removes all of it, Codex's own databases included: for before uninstalling the mod.`,
].join('\n')

/** Removes the agent records whose thread has no session file left; returns how many. */
async function forget($: EngineInterface, home: string, left: string): Promise<number> {
  const has = (thread: string | undefined): boolean => thread !== undefined && left.includes(thread)
  const folder = `${home}/${AGENTS_DIR}`
  const gone: string[] = []
  for (const entry of await $.fs.list(folder).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const path = `${folder}/${entry.name}`
    if (!has((await recordOf($, path))?.threadId)) gone.push(path)
  }
  for (let at = 0; at < gone.length; at += 200) {
    await hostRun($, 'remove', gone.slice(at, at + 200))
  }
  for (const agent of agents.values()) {
    if (!has(agent.threadId)) agent.threadId = undefined
  }
  return gone.length
}

/** Answers `/subcodex [clean <days> | clean all]`. */
export async function upkeep($: EngineInterface, typed: string): Promise<string> {
  const { home, isHostMissing } = await findCodex($)
  if (home === '') return 'Your home directory could not be found, so nothing was looked at or removed.'
  if (isHostMissing) return [...(await standing($)), '', 'Nothing on disk was looked at or removed.'].join('\n')
  const data = `${home}/${DATA_DIR}`
  const paths = [data, `${home}/${OWN_CODEX_HOME}`, USAGE_MARK]
  const run = async (op: Op, ...more: string[]): Promise<string> => (await hostRun($, op, [...paths, ...more])).stdout
  const seen = Object.fromEntries(
    (await run('look'))
      .split('\n')
      .filter(line => line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  ) as Record<string, string | undefined>

  const [verb, what] = typed.trim().split(/\s+/)
  if (verb === 'clean') {
    // A running server (in any session) has a session file open.
    const isBusy = Number(seen.servers ?? 0) > 0 || [...agents.values()].some(agent => agent.conn !== undefined)
    if (what === 'all') {
      if (isBusy) return BUSY
      await run('wipe')
      await forget($, home, '')
      await $.store.delete(LIMITS)
      return `Removed ${seen.sessions ?? 0} session files, ${seen.links ?? 0} links to them and ${seen.records ?? 0} agent records. ${data} is gone; the next Codex agent makes it anew.`
    }
    const days = Number(what)
    if (what === undefined || !Number.isInteger(days) || days < 0) return `Say how old, or all.\n${HOW}`
    if (isBusy && days === 0) return BUSY
    const [files = '0', ...left] = (await run('prune', String(days))).trim().split('\n')
    const gone = await forget($, home, left.join('\n'))
    await forgetLastPass($, home)
    return `Removed ${files} session files last written more than ${days} days ago, with their links, and ${gone} agent records that pointed at no session. Any link the other session files are missing is made as the next Codex agent starts.`
  }

  const stands = await standing($)
  if (seen.kept !== 'yes') {
    return [...stands, '', 'Nothing is kept on disk yet: no Codex agent has run.'].join('\n')
  }
  return [
    ...stands,
    '',
    `Kept under ${data} (${seen.size ?? '?'}):`,
    `- ${seen.sessions ?? 0} Codex session files${seen.oldest ? `, the oldest from ${seen.oldest}` : ''}: Codex's own full record of each agent's work, which a later message to an agent resumes from.`,
    `- ${seen.links ?? 0} links to them under ${home}/${OWN_CODEX_HOME}/sessions, by which usage tools count these runs as your Codex usage. Codex itself does not list them.`,
    `- ${seen.records ?? 0} agent records: which Codex thread each agent goes on in.`,
    `- Codex's own databases${seen.state === undefined ? '' : ` (${seen.state})`}: its index of threads, and its diagnostic logs, which Codex prunes itself.`,
    '',
    HOW,
  ].join('\n')
}
