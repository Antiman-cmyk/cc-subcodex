import { isEditable } from './edits'
import type { Ev, Limit, Rpc } from './types'

/** Per thread: messages that were streamed, and those marked as the final answer. */
export type Seen = { streamed: Set<string>; closing: Set<string> }

export const newSeen = (): Seen => ({ streamed: new Set(), closing: new Set() })

export type Item = {
  id?: string
  type?: string
  text?: string
  // Whether a message is said along the way or is the final answer: `agentMessage`.
  phase?: string | null
  command?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  changes?: { path?: string; kind?: { type?: string; move_path?: string | null }; diff?: string }[]
  // A tool of Codex's own (an MCP server's): `mcpToolCall`.
  server?: string
  tool?: string
  status?: string
  arguments?: unknown
  error?: { message?: string } | null
  // A web search of Codex's: `webSearch`, with what it found.
  query?: string
  action?: { type?: string; url?: string; pattern?: string } | null
  results?: { title?: string; url?: string }[] | null
  // A sub-agent Codex started: `subAgentActivity`.
  kind?: string
  agentThreadId?: string
  agentPath?: string
  model?: string | null
  reasoningEffort?: string | null
  // What a review of Codex's is of: `enteredReviewMode`.
  review?: string
  // An image Codex looked at (`imageView`) or made (`imageGeneration`).
  path?: string
  savedPath?: string | null
  revisedPrompt?: string | null
  // How long Codex waited: `sleep`.
  durationMs?: number
}

/** A bracketed line about what Codex did; not Codex's own words. */
const aside = (text: string, id?: string): Ev => ({ t: 'text', text: `[${text}]`, id, isAside: true })

const cut = (text: string, most: number): string =>
  text.length > most ? `${text.slice(0, most)}…` : text

/** How many results of a web search are named. */
const RESULTS = 5

/** The action Codex's reviewer judged, in a few words. */
function actionText(action: Record<string, unknown> | undefined): string {
  switch (action?.type) {
    case 'command':
      return `the command \`${cut(String(action.command ?? ''), 200)}\``
    case 'execve':
      return `running \`${cut([action.program, ...((action.argv as unknown[] | undefined) ?? [])].join(' '), 200)}\``
    case 'applyPatch':
      return `an edit of ${((action.files as unknown[] | undefined) ?? []).join(', ')}`
    case 'networkAccess':
      return `network access to ${String(action.host ?? action.target ?? '?')}`
    case 'mcpToolCall':
      return `its tool ${String(action.server ?? '?')}.${String(action.toolName ?? '?')}`
    case 'writeStdin':
      return 'input to a running command'
    case 'requestPermissions':
      return `more permissions${action.reason == null ? '' : ` (${String(action.reason)})`}`
    default:
      return 'an action'
  }
}

/**
 * One app-server notification about a thread (the agent's own or a
 * sub-agent's) -> its events. `seen` is kept per thread by the caller.
 */
export function fromThread(message: Rpc, seen: Seen): Ev[] {
  const params = message.params ?? {}
  const item = params.item as Item | undefined
  const { streamed, closing } = seen

  if (message.method === 'item/started' && item?.type === 'agentMessage') {
    if (item.phase === 'final_answer' && item.id !== undefined) closing.add(item.id)
    return []
  }
  if (message.method === 'item/agentMessage/delta') {
    const id = String(params.itemId)
    streamed.add(id)
    return [{ t: 'text', text: String(params.delta ?? ''), id, ...(closing.has(id) ? { isClosing: true } : {}) }]
  }
  if (
    message.method === 'item/reasoning/summaryTextDelta' ||
    message.method === 'item/reasoning/textDelta'
  ) {
    return [{ t: 'thinking', text: String(params.delta ?? ''), id: String(params.itemId) }]
  }
  if (message.method === 'item/started' && item?.type === 'commandExecution') {
    return [{ t: 'cmd', id: item.id ?? '', command: item.command ?? '' }]
  }
  if (message.method === 'item/completed' && item !== undefined) {
    if (item.type === 'commandExecution') {
      return [
        {
          t: 'cmd_done',
          id: item.id ?? '',
          output: item.aggregatedOutput ?? '',
          exitCode: item.exitCode ?? null,
        },
      ]
    }
    if (item.type === 'agentMessage') {
      return streamed.has(item.id ?? '')
        ? []
        : [
            {
              t: 'text',
              text: item.text ?? '',
              id: item.id,
              ...(item.phase === 'final_answer' ? { isClosing: true } : {}),
            },
          ]
    }
    // Other items, one line each.
    if (item.type === 'mcpToolCall') {
      const asked = cut(JSON.stringify(item.arguments ?? {}), 300)
      const failed = item.status === 'failed' ? ` failed: ${item.error?.message ?? 'no reason given'}` : ''
      return [aside(`Codex used its own tool ${item.server ?? '?'}.${item.tool ?? '?'} ${asked}${failed}`, item.id)]
    }
    if (item.type === 'webSearch') {
      const what =
        item.action?.type === 'open_page'
          ? `opened ${item.action.url ?? 'a page'}`
          : item.action?.type === 'find_in_page'
            ? `looked for "${item.action.pattern ?? ''}" in ${item.action.url ?? 'a page'}`
            : `searched the web: ${item.query ?? ''}`
      const found = (item.results ?? [])
        .filter(one => typeof one.url === 'string')
        .slice(0, RESULTS)
        .map(one => `\n- ${one.title ?? one.url} ${one.title === undefined ? '' : `(${one.url})`}`.trimEnd())
      const more = (item.results ?? []).length - found.length
      return [aside(`Codex ${what}${found.length === 0 ? '' : `; it found:${found.join('')}${more > 0 ? `\n- and ${more} more` : ''}`}`, item.id)]
    }
    if (item.type === 'plan' && (item.text ?? '') !== '') {
      return [{ t: 'text', text: `[Codex's plan]\n${item.text}`, id: item.id, isAside: true }]
    }
    if (item.type === 'imageView') return [aside(`Codex looked at the image ${item.path ?? '?'}`, item.id)]
    if (item.type === 'imageGeneration') {
      const about = item.revisedPrompt == null ? '' : `: ${cut(item.revisedPrompt, 200)}`
      return [
        aside(
          item.savedPath == null
            ? `Codex generated an image${about}`
            : `Codex generated an image, saved at ${item.savedPath}${about}`,
          item.id,
        ),
      ]
    }
    if (item.type === 'sleep') {
      return [aside(`Codex waited ${Math.round((item.durationMs ?? 0) / 1000)} s`, item.id)]
    }
    if (item.type === 'enteredReviewMode') {
      return [aside(`Codex's review mode: ${cut(item.review ?? '', 300)}`, item.id)]
    }
    if (item.type === 'contextCompaction') {
      return [{ t: 'compacted' }]
    }
    if (item.type === 'fileChange') {
      const changes = item.changes ?? []
      const id = item.id ?? ''
      const isApplied = item.status !== 'failed' && item.status !== 'declined'
      // Applied updates in place and new files are edit rows, one per file.
      if (isApplied && changes.length > 0 && changes.every(isEditable)) {
        return changes.map((change, at): Ev => ({
          t: 'edit',
          id: changes.length === 1 ? id : `${id}_${at}`,
          path: change.path ?? '',
          kind: change.kind?.type === 'add' ? 'add' : 'update',
          diff: change.diff ?? '',
        }))
      }
      // Anything else (a delete, a move, a failure) is a command row whose output is the diff.
      const diff = changes
        .map(change => `${change.kind?.type ?? 'update'} ${change.path}\n${change.diff ?? ''}`)
        .join('\n')
        .slice(0, 8000)
      return [
        { t: 'cmd', id, command: `apply_patch  # ${changes.map(change => change.path).join(', ')}` },
        {
          t: 'cmd_done',
          id,
          output: isApplied ? diff : `The edit was ${item.status === 'declined' ? 'declined' : 'not applied'}.\n${diff}`,
          exitCode: isApplied ? 0 : 1,
        },
      ]
    }
  }
  if (message.method === 'item/commandExecution/outputDelta') {
    return [{ t: 'cmd_output', id: String(params.itemId ?? ''), text: String(params.delta ?? '') }]
  }
  if (message.method === 'thread/tokenUsage/updated') {
    const last = (params.tokenUsage?.last ?? {}) as { totalTokens?: number }
    return [{ t: 'usage', tokens: Number(last.totalTokens ?? 0) }]
  }
  if (message.method === 'turn/plan/updated') {
    const steps = (params.plan ?? []) as { step?: string; status?: string }[]
    if (steps.length === 0) return []
    const lines = steps.map(
      one =>
        `- [${one.status === 'completed' ? 'x' : ' '}] ${one.step ?? ''}${one.status === 'inProgress' ? ' (in progress)' : ''}`,
    )
    const why = params.explanation == null || params.explanation === '' ? '' : ` ${String(params.explanation)}`
    return [{ t: 'text', text: `[Codex's plan]${why}\n${lines.join('\n')}`, isAside: true }]
  }
  if (message.method === 'item/autoApprovalReview/completed') {
    // Codex's reviewer judged a request for leave. (`guardianWarning` repeats it.)
    const review = (params.review ?? {}) as { status?: string; riskLevel?: string | null; rationale?: string | null }
    const verdict =
      review.status === 'approved'
        ? 'allowed'
        : review.status === 'denied'
          ? 'refused'
          : review.status === 'timedOut'
            ? 'did not answer in time on'
            : undefined
    if (verdict === undefined) return []
    const risk = review.riskLevel == null ? '' : ` (risk ${review.riskLevel})`
    const why = review.rationale == null || review.rationale === '' ? '' : `: ${cut(review.rationale, 300)}`
    return [aside(`Codex's own reviewer ${verdict} ${actionText(params.action as Record<string, unknown>)}${risk}${why}`)]
  }
  if (message.method === 'model/rerouted') {
    return [
      aside(
        `Codex's service moved this turn from ${String(params.fromModel)} to ${String(params.toModel)} (${String(params.reason ?? 'no reason given')})`,
      ),
    ]
  }
  if (message.method === 'warning') {
    return [aside(`Codex warning: ${String(params.message ?? '')}`)]
  }
  if (message.method === 'error') {
    // Errors the server retries itself are not shown.
    if (params.willRetry === true) return []
    return [{ t: 'text', text: `Codex error: ${String(params.error?.message ?? 'unknown')}` }]
  }
  if (message.method === 'turn/completed') {
    const turn = params.turn as { status?: string; error?: { message?: string } } | undefined
    return turn?.status === 'failed'
      ? [
          { t: 'text', text: `Codex turn failed: ${turn.error?.message ?? 'unknown error'}` },
          { t: 'done' },
        ]
      : [{ t: 'done' }]
  }
  return []
}

/** One app-server notification about no thread (usage limits, config warnings) -> events. */
export function fromServer(message: Rpc): Ev[] {
  const params = message.params ?? {}
  if (message.method === 'account/rateLimits/updated') {
    const snapshot = (params.rateLimits ?? {}) as Record<string, unknown>
    const name = (snapshot.limitName ?? undefined) as string | undefined
    const limits: Limit[] = []
    for (const key of ['primary', 'secondary']) {
      const one = snapshot[key] as
        | { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null }
        | null
        | undefined
      if (typeof one?.usedPercent !== 'number') continue
      limits.push({
        name,
        minutes: one.windowDurationMins ?? undefined,
        resetsAt: one.resetsAt ?? undefined,
        used: one.usedPercent,
      })
    }
    return limits.length === 0 ? [] : [{ t: 'limits', limits }]
  }
  if (message.method === 'configWarning') {
    const details = params.details == null || params.details === '' ? '' : ` ${cut(String(params.details), 300)}`
    return [aside(`Codex config warning: ${String(params.summary ?? '')}${details}`)]
  }
  return []
}

/**
 * A sub-agent's event as the agent's transcript shows it: text headed with
 * its name, commands marked as its. `headed` holds the messages already headed.
 */
export function inline(path: string, headed: Set<string>, ev: Ev): Ev[] {
  if (ev.t === 'text') {
    const isHeaded = ev.id !== undefined && headed.has(ev.id)
    if (ev.id !== undefined) headed.add(ev.id)
    return [
      { ...ev, text: isHeaded ? ev.text : `[Codex sub-agent ${path}] ${ev.text}`, by: path },
    ]
  }
  if (ev.t === 'cmd' || ev.t === 'edit' || ev.t === 'compacted') return [{ ...ev, by: path }]
  if (ev.t === 'cmd_done' || ev.t === 'cmd_output') return [ev]
  return []
}
