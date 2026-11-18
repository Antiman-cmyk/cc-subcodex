import type { EngineInterface, FsEntry } from 'claude-code'

import { CODEX_HOME, DATA_DIR, OWN_CODEX_HOME, SHARED, USAGE_MARK } from './config'
import { hostRun, isWindows } from './host'
import { trace } from './log'

// Links the session files of the mod's Codex home into the person's, where
// usage tools count them: `sessions/<year>/<month>/<day>/rollout-….jsonl` of
// the mod's gets a link at the same path in the person's, its name marked
// (`USAGE_MARK`). A pass looks only at the mod's day folders changed since the
// last whole pass began: a file made, renamed (Codex compresses older ones to
// `.jsonl.zst`) or removed in a folder changes the folder's time. In each such
// folder it links the files that have no link, and removes the mod's links
// there that lead to no file. The links are made and removed by the host
// operation `links`.

/** When the last whole pass began, relative to the home directory. */
const RECORD = `${DATA_DIR}/usage-links.json`
/** How long before the last pass began a folder's time still counts as a change. */
const MARGIN_MS = 60_000

/** The links this session could not make: what of the person's Codex home the mod's lacks, and the usage links. */
const unmade: { shared: string[]; isUsage: boolean } = { shared: [], isUsage: false }
/** The note of unmade links last put in an agent's transcript in this session. */
let told: string | undefined

/** Whether an entry is a session file of Codex's. */
const isSession = (entry: FsEntry): boolean =>
  entry.kind === 'file' && !entry.isLink && entry.name.startsWith('rollout-') && entry.name.includes('.jsonl')

/** Whether an entry is a link of the mod's. */
const isUsageLink = (entry: FsEntry): boolean =>
  entry.isLink && entry.name.startsWith('rollout-') && entry.name.includes(`${USAGE_MARK}.jsonl`)

/** The name of a session file's link. */
const linkName = (name: string): string => name.replace('.jsonl', `${USAGE_MARK}.jsonl`)

/** A folder's entries; none where it cannot be listed. */
async function entriesOf($: EngineInterface, dir: string): Promise<FsEntry[]> {
  return $.fs.list(dir).catch(() => [])
}

/** How many file system calls a pass has in flight at once. */
const AT_ONCE = 64

/** `work` done for each item, `AT_ONCE` at a time; the results in the items' order. */
async function eachOf<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = []
  for (let at = 0; at < items.length; at += AT_ONCE) done.push(...(await Promise.all(items.slice(at, at + AT_ONCE).map(work))))
  return done
}

/** The folders in a folder, by name. */
async function foldersOf($: EngineInterface, dir: string): Promise<string[]> {
  return (await entriesOf($, dir)).filter(entry => entry.kind === 'dir').map(entry => entry.name)
}

/** The day folders of a sessions folder, as `<year>/<month>/<day>`. */
async function dayFolders($: EngineInterface, sessions: string): Promise<string[]> {
  const years = await foldersOf($, sessions)
  const months = (await eachOf(years, async year => (await foldersOf($, `${sessions}/${year}`)).map(month => `${year}/${month}`))).flat()
  return (await eachOf(months, async month => (await foldersOf($, `${sessions}/${month}`)).map(day => `${month}/${day}`))).flat()
}

/**
 * What one day folder needs, for `links`: pairs of a link's path and the file
 * it leads to; an empty file is a link to remove, and comes before the same
 * link made again.
 */
async function dayChanges($: EngineInterface, mod: string, own: string): Promise<string[]> {
  const changes: string[] = []
  const linked = new Set<string>()
  const links = (await entriesOf($, own)).filter(isUsageLink)
  const leads = await eachOf(links, link => $.fs.stat(`${own}/${link.name}`).then(stat => stat.kind === 'file', () => false))
  links.forEach((link, at) => {
    if (leads[at] === true) linked.add(link.name)
    else changes.push(`${own}/${link.name}`, '')
  })
  for (const entry of (await entriesOf($, mod)).filter(isSession)) {
    const link = linkName(entry.name)
    if (!linked.has(link)) changes.push(`${own}/${link}`, `${mod}/${entry.name}`)
  }
  return changes
}

/** When the last whole pass began; undefined before the first. */
async function lastPass($: EngineInterface, record: string): Promise<number | undefined> {
  try {
    const began = (JSON.parse(await $.fs.read(record)) as { began?: unknown }).began
    return typeof began === 'number' ? began : undefined
  } catch {
    return undefined
  }
}

/** Has the next pass look at every day folder: the record holds no pass. */
export async function forgetLastPass($: EngineInterface, home: string): Promise<void> {
  await $.fs.write(`${home}/${RECORD}`, '{}').catch(() => undefined)
}

/**
 * Links the session files that have no link yet, in the day folders of the
 * mod's Codex home changed since the last pass, and removes the mod's links
 * there that lead to no file. The pass is recorded once every link is made.
 */
export async function linkSessions($: EngineInterface, home: string): Promise<void> {
  // After a pass that could not make a link, none is made again in this session.
  if (unmade.isUsage) return
  const began = Date.now()
  const record = `${home}/${RECORD}`
  const last = await lastPass($, record)
  const since = last === undefined ? -Infinity : last - MARGIN_MS
  const mod = `${home}/${CODEX_HOME}/sessions`
  const own = `${home}/${OWN_CODEX_HOME}/sessions`
  const days = await dayFolders($, mod)
  const times = await eachOf(days, day => $.fs.stat(`${mod}/${day}`).then(stat => stat.mtimeMs, () => -Infinity))
  const changed = days.filter((_, at) => (times[at] ?? -Infinity) >= since)
  const changes = (await eachOf(changed, day => dayChanges($, `${mod}/${day}`, `${own}/${day}`))).flat()
  if (changes.length > 0) {
    const made = await hostRun($, 'links', changes).catch(() => undefined)
    if (made === undefined) return
    if (made.exitCode !== 0) {
      unmade.isUsage = true
      trace($, 'usage links: not all could be made; no more passes in this session')
      return
    }
  }
  await $.fs.write(record, JSON.stringify({ began })).catch(() => undefined)
}

/**
 * Notes what the mod's Codex home lacks of what it shares from the person's
 * (`SHARED`), once a server's start has linked them.
 */
export async function checkShared($: EngineInterface, home: string): Promise<void> {
  const lacks = await Promise.all(
    SHARED.map(
      async name =>
        (await $.fs.exists(`${home}/${OWN_CODEX_HOME}/${name}`).catch(() => false)) &&
        !(await $.fs.exists(`${home}/${CODEX_HOME}/${name}`).catch(() => true)),
    ),
  )
  unmade.shared = SHARED.filter((_, at) => lacks[at] === true)
}

/** What is said of the links this session could not make; undefined while it has made every one. */
export function unmadeNote($: EngineInterface): string | undefined {
  const lost = [
    ...(unmade.shared.length > 0 ? [`Codex runs without ${unmade.shared.join(', ')} from your Codex home`] : []),
    ...(unmade.isUsage ? ["usage tools do not count Codex's sessions"] : []),
  ]
  if (lost.length === 0) return undefined
  const fix = isWindows($)
    ? 'On Windows they need Developer Mode (Settings > System > For developers): turn it on, then start a new session.'
    : 'Check that the folders they go in can be written to, then start a new session.'
  return `The subcodex mod could not make its symbolic links, so ${lost.join(', and ')}. ${fix}`
}

/** The note of unmade links for an agent's transcript, where this session has not put it in one yet. */
export function newUnmadeNote($: EngineInterface): string | undefined {
  const note = unmadeNote($)
  if (note === undefined || note === told) return undefined
  told = note
  return note
}
