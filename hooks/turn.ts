import type { EngineInterface } from 'claude-code'

import { REVIEW_CHANGES, merged, remember, untaken } from './agents'
import { closeConn, isAbort, openConn, readMessage, request, send } from './app-server'
import { CODEX_BRIEF, MESSAGE, RESULT, claudeName, toolsFor } from './bridge'
import { claudeInstructions, findCodex, loginOf } from './codex-home'
import { OWN_CODEX_HOME } from './config'
import { fromServer, fromThread, inline, newSeen, type Item } from './events'
import { NEARLY, limitKey, limitText } from './usage'
import { addOutput } from './live'
import { trace } from './log'
import type { Agent, Conn, Ev, Rpc, Run } from './types'

/** A turn that could not begin: says why, and ends. */
function failedRun(text: string): Run {
  const ready: Ev[] = [{ t: 'text', text }, { t: 'done' }]
  return {
    pull: async () => ready.shift() ?? { t: 'done' },
    buffered: [],
    tools: new Map(),
    edits: new Map(),
    calls: new Map(),
    reply: async () => undefined,
  }
}

/** The answer to a question Codex puts to the person. */
const NO_ONE_TO_ASK =
  'No one can be asked from here. If you cannot go on without this answer, end your turn with the question as your final message: it reaches the agent that delegated the task, and its reply arrives as your next message.'

/** Requests for leave to act outside the sandbox. */
const LEAVE_FOR_COMMAND = 'item/commandExecution/requestApproval'
const LEAVE_FOR_EDIT = 'item/fileChange/requestApproval'
const LEAVE_FOR_MORE = 'item/permissions/requestApproval'

/** The answer to a server request this client does not otherwise handle. */
function refusalOf(message: Rpc): Pick<Rpc, 'result' | 'error'> {
  const method = message.method ?? ''
  if (method === 'mcpServer/elicitation/request') {
    return { result: { action: 'decline', content: null, _meta: null } }
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = (message.params?.questions ?? []) as { id?: string }[]
    return {
      result: {
        answers: Object.fromEntries(
          questions.map(question => [String(question.id ?? ''), { answers: [NO_ONE_TO_ASK] }]),
        ),
      },
    }
  }
  if (method === 'currentTime/read') {
    return { result: { currentTimeAt: Math.floor(Date.now() / 1000) } }
  }
  return { error: { code: -32601, message: `${method} is not supported by this client` } }
}

/**
 * Thread settings for an agent's permission mode. Requests for leave go to
 * Codex's own reviewer (`auto_review`); under plan mode the sandbox is
 * read-only and requests come to this client, which refuses them. The effort
 * is also set on the thread, which a review and Codex's sub-agents run by.
 */
export function policyFor(
  mode: string | undefined,
  hasApprovalPolicy: boolean,
  effort: string | undefined,
): Record<string, unknown> {
  const isPlan = mode === 'plan'
  return {
    ...(hasApprovalPolicy ? {} : { approvalPolicy: 'on-request' }),
    approvalsReviewer: isPlan ? 'user' : 'auto_review',
    ...(isPlan ? { sandbox: 'read-only' } : {}),
    ...(effort === undefined ? {} : { config: { model_reasoning_effort: effort } }),
  }
}

/** Item kinds that get no line of their own (shown otherwise, or not at all). */
const SILENT = [
  'userMessage',
  'hookPrompt',
  'reasoning',
  'agentMessage',
  'collabAgentToolCall',
  'dynamicToolCall',
  'exitedReviewMode',
]

/**
 * The prompt for Codex where it lacks earlier messages: those it has not taken
 * in yet, or (`isLost`) all of them, its thread being gone. Oldest first.
 */
export function afresh(said: string[], isLost: boolean): string {
  const why = isLost
    ? 'The thread you worked in before for this task could not be reopened, so you start afresh: what you did and found there is gone. Say so if what follows depends on it. Here is everything you have been asked in this task'
    : 'Messages for you that had not reached you yet'
  return [`(${why}, oldest first; the last is what to do now.)`, ...said].join('\n\n---\n\n')
}

/**
 * What a Codex turn is given: the messages it has not taken in, oldest first;
 * `isLate` for those sent as its last turn was ending.
 */
export function promptFor(pending: string[], isLate: boolean): string {
  if (isLate) {
    return `Messages from the agent that delegated this task, sent as you were finishing, which you had not seen:\n\n${pending.join('\n\n---\n\n')}`
  }
  return pending.length > 1 ? afresh(pending, false) : (pending[0] ?? '')
}

/**
 * A Codex turn on the agent's thread, started on its first pull: a turn on
 * `prompt`, or a review. `said` is all the agent was told, oldest first.
 */
function codexRun(
  $: EngineInterface,
  agent: Agent,
  agentId: string,
  conn: Conn,
  cwd: string,
  said: string[],
  prompt: string,
  isReview: boolean,
): Run {
  const ready: Ev[] = []
  /** tool_use_id of a mirrored Bash row -> the Codex command it mirrors. */
  const tools = new Map<string, string>()
  /** Output of commands whose row is not written yet, by Codex item. */
  const early = new Map<string, string>()
  /** A piece of a running command's output: drawn under its row, with what came before the row. */
  const onOutput = async (ev: Extract<Ev, { t: 'cmd_output' }>): Promise<void> => {
    const rows = [...tools].filter(([, itemId]) => itemId === ev.id).map(([toolUseId]) => toolUseId)
    const text = `${early.get(ev.id) ?? ''}${ev.text}`
    if (rows.length === 0) {
      early.set(ev.id, text.slice(-4_000))
      return
    }
    early.delete(ev.id)
    for (const toolUseId of rows) await addOutput($, toolUseId, text).catch(() => undefined)
  }
  const seen = newSeen()
  let hasBegun = false
  let hasEnded = false
  /** True once this turn has started; earlier token counts are a resumed thread's. */
  let isUnderWay = false
  const fail = (text: string): void => {
    ready.push({ t: 'text', text }, { t: 'done' })
    hasEnded = true
  }

  const begin = async (): Promise<void> => {
    const { bin, home, hasApprovalPolicy } = await findCodex($)
    const { model, effort } = agent.settings
    if (conn.isStopped) {
      hasEnded = true
      return
    }
    if (!conn.isUp) {
      fail(
        `Codex did not start. The subcodex mod runs \`${bin} app-server\`, and that server gave no answer: check that the Codex CLI is installed, on your login shell's PATH, and recent enough to have \`app-server\`.`,
      )
      return
    }
    if (!conn.isLoggedIn) {
      fail(
        `Codex could not be logged in for this run. The subcodex mod uses the login of your own Codex (${home}/${OWN_CODEX_HOME}/auth.json), and that login is missing or no longer accepted. Open Codex, or run \`codex login\`, then try again.`,
      )
      return
    }
    let asked = prompt
    if (conn.threadId === undefined) {
      const policy = policyFor(agent.mode, hasApprovalPolicy, effort)
      let id: string | undefined
      let opened: Rpc | undefined
      if (agent.threadId !== undefined) {
        opened = await request($, conn, 'thread/resume', {
          threadId: agent.threadId,
          ...policy,
          ...(model === undefined ? {} : { model }),
        })
        id = opened.result?.thread?.id as string | undefined
        trace($, `resume ${agent.threadId}: ${id === undefined ? `failed (${opened.error?.message})` : 'ok'}`)
      }
      if (id === undefined) {
        opened = await request($, conn, 'thread/start', {
          cwd,
          ...policy,
          dynamicTools: toolsFor(agent.outputSchema, await $.tool.list()),
          developerInstructions: [CODEX_BRIEF, ...(await claudeInstructions($, home, cwd)), ...(agent.outputSchema === undefined ? [] : [`This workflow requires a structured result. Complete the task, then call ${RESULT} with the result, instead of ending with a prose report. The native workflow validates it; correct any errors returned by that tool.`])].join('\n\n'),
          ...(model === undefined ? {} : { model }),
        })
        id = opened.result?.thread?.id as string | undefined
        if (id === undefined) {
          fail(`Codex could not open a thread: ${opened.error?.message ?? 'no thread in the answer'}`)
          return
        }
        // The earlier thread is gone: the new one gets every message.
        if (agent.threadId !== undefined) {
          ready.push({
            t: 'text',
            text: "[Codex could not reopen this agent's earlier thread: it goes on in a new one, with what it was asked but without what it did]",
            isAside: true,
          })
          asked = afresh(said, true)
        }
      }
      conn.threadId = id
      agent.threadId = id
      await remember($, agentId, agent)
      trace(
        $,
        `thread ${id}: model ${opened?.result?.model}, approvals ${opened?.result?.approvalPolicy}/${opened?.result?.approvalsReviewer}, sandbox ${JSON.stringify(opened?.result?.sandbox?.type ?? opened?.result?.sandbox)}`,
      )
    }
    const begun = isReview && agent.outputSchema === undefined
      ? await request($, conn, 'review/start', {
          threadId: conn.threadId,
          target:
            prompt.trim() === REVIEW_CHANGES
              ? { type: 'uncommittedChanges' }
              : { type: 'custom', instructions: prompt },
          delivery: 'inline',
        })
      : await request($, conn, 'turn/start', {
          threadId: conn.threadId,
          input: [{ type: 'text', text: isReview && agent.outputSchema !== undefined ? `Review the code changes as requested: ${asked}. Submit the findings with the workflow_result tool.` : asked, text_elements: [] }],
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        })
    if (begun.error !== undefined) {
      fail(`Codex could not start the ${isReview ? 'review' : 'turn'}: ${begun.error.message ?? 'unknown error'}`)
      return
    }
    conn.turnId = begun.result?.turn?.id as string | undefined
  }

  /** The sub-agent a thread other than the agent's own belongs to. */
  const subOf = (thread: string): { path: string; headed: Set<string> } => {
    const known = conn.subs.get(thread)
    if (known !== undefined) return known
    const unnamed = { path: 'sub-agent', headed: new Set<string>() }
    conn.subs.set(thread, unnamed)
    return unnamed
  }

  const pull = async (): Promise<Ev> => {
    try {
      return await next()
    } catch (error) {
      conn.hasEnded = true
      const why = error instanceof Error ? error.message : String(error)
      if (isAbort(error)) hasEnded = true
      else fail(`The connection to Codex failed: ${why}`)
      return ready.shift() ?? { t: 'done' }
    }
  }

  /** A server request: answered here, or shown as a row whose hook answers it. */
  const onRequest = async (message: Rpc & { id: number | string }): Promise<void> => {
    if (message.method === 'account/chatgptAuthTokens/refresh') {
      const login = await loginOf($, (await findCodex($)).home)
      await send(
        $,
        conn,
        login === undefined
          ? { id: message.id, error: { message: 'no login to refresh from' } }
          : { id: message.id, result: login },
      )
      return
    }
    if (message.method === 'item/tool/call') {
      const asked = (message.params?.arguments ?? {}) as Record<string, unknown>
      const name = claudeName(message.params?.namespace as string | null | undefined, String(message.params?.tool ?? ''))
      ready.push({
        t: 'ctool',
        rpc: message.id,
        name,
        args: name === MESSAGE ? { message: String(asked.message ?? '') } : asked,
      })
      return
    }
    if (
      message.method === LEAVE_FOR_COMMAND ||
      message.method === LEAVE_FOR_EDIT ||
      message.method === LEAVE_FOR_MORE
    ) {
      await onLeave(message)
      return
    }
    trace($, `app-server asked ${message.method}: not granted`)
    if (message.method === 'item/tool/requestUserInput') {
      const asked = ((message.params?.questions ?? []) as { question?: string }[])
        .map(one => one.question ?? '')
        .join(' / ')
      ready.push({
        t: 'text',
        text: `[Codex wanted to ask the person: ${asked} It was told that no one can be asked from here, and to end its turn with the question instead]`,
        isAside: true,
      })
    }
    await send($, conn, { id: message.id, ...refusalOf(message) })
  }

  /** A request for leave that came to this client (plan mode): refused. */
  const onLeave = async (message: Rpc & { id: number | string }): Promise<void> => {
    const params = message.params ?? {}
    const isForMore = message.method === LEAVE_FOR_MORE
    // The command inside Codex's shell wrapper.
    const actions = (params.commandActions ?? []) as { command?: string }[]
    const command =
      actions.length === 1 && typeof actions[0]?.command === 'string'
        ? actions[0].command
        : typeof params.command === 'string'
          ? params.command
          : undefined
    const reason = typeof params.reason === 'string' && params.reason !== '' ? ` (${params.reason})` : ''
    const request =
      command !== undefined
        ? `run \`${command}\` outside its sandbox`
        : message.method === LEAVE_FOR_EDIT
          ? 'change files outside the folders its sandbox lets it write to'
          : isForMore
            ? `have more permissions for this turn: ${JSON.stringify(params.permissions ?? {})}`
            : 'reach the network for a command'
    const why = agent.mode === 'plan' ? 'as plan mode lets nothing be changed' : "as only Codex's own reviewer answers that"
    trace($, `leave to ${request}: refused (${why})`)
    ready.push({ t: 'text', text: `[Codex asked leave to ${request}${reason}: refused, ${why}]`, isAside: true })
    await send($, conn, { id: message.id, result: isForMore ? { permissions: {}, scope: 'turn' } : { decision: 'decline' } })
  }

  /** A sub-agent of Codex's own started, or ended. */
  const onSubAgent = (item: Item): void => {
    const path = item.agentPath ?? 'sub-agent'
    trace($, `sub-agent ${path} ${item.kind}`)
    if (item.kind !== 'started') {
      ready.push({ t: 'text', text: `[Codex sub-agent ${path} ${item.kind ?? 'changed'}]`, id: item.id, by: path, isAside: true })
      return
    }
    if (item.agentThreadId !== undefined) conn.subs.set(item.agentThreadId, { path, headed: new Set() })
    const how = [item.model, item.reasoningEffort].filter(Boolean).join(', ')
    ready.push({
      t: 'text',
      text: `[Codex started sub-agent ${path}${how === '' ? '' : ` (${how})`}]`,
      id: item.id,
      by: path,
      isAside: true,
    })
  }

  /** A notification about the agent's own thread, or about none. */
  const onOwn = async (message: Rpc, item: Item | undefined): Promise<void> => {
    if (message.method === 'turn/started') isUnderWay = true
    // Codex's first item of the turn: it has taken in what it was given.
    if (isUnderWay && item !== undefined && agent.unsent.some(text => agent.given.includes(text))) {
      agent.unsent = untaken(agent)
      await remember($, agentId, agent)
    }
    if (message.method === 'turn/completed') {
      hasEnded = true
      conn.turnId = undefined
    }
    const events = [...fromServer(message), ...fromThread(message, seen)]
    for (const ev of events) {
      if (ev.t === 'cmd_output') {
        await onOutput(ev)
        continue
      }
      if (ev.t === 'usage') {
        if (!isUnderWay) continue
        if (ev.tokens > 0) conn.contextTokens = ev.tokens
      }
      ready.push(ev.t === 'compacted' ? { ...ev, tokens: conn.contextTokens } : ev)
      if (ev.t !== 'limits') continue
      // A limit nearly used up gets a line, once per server.
      for (const limit of ev.limits) {
        if (limit.used < NEARLY || conn.warned.has(limitKey(limit))) continue
        conn.warned.add(limitKey(limit))
        ready.push({ t: 'text', text: `[Codex usage limit nearly used up: ${limitText(limit)}]`, isAside: true })
      }
    }
    if (message.method === 'item/completed' && events.length === 0 && !SILENT.includes(item?.type ?? '')) {
      trace($, `not shown: a ${item?.type} item of Codex's`)
    }
  }

  const next = async (): Promise<Ev> => {
    if (!hasBegun) {
      hasBegun = true
      await begin()
    }
    while (ready.length === 0) {
      if (hasEnded) return { t: 'done' }
      const message = conn.held.shift() ?? (await readMessage(conn))
      if (message === undefined) {
        fail('Codex app-server ended before the turn did.')
        break
      }
      if (message.id !== undefined && message.method !== undefined) {
        await onRequest({ ...message, id: message.id })
        continue
      }
      if (message.id !== undefined) {
        // A steer's answer: a message Codex took is no longer pending.
        const text = conn.steers.get(Number(message.id))
        conn.steers.delete(Number(message.id))
        if (message.error === undefined && text !== undefined) {
          agent.unsent = agent.unsent.filter(one => one !== text)
          await remember($, agentId, agent)
        }
        continue
      }
      const item = message.params?.item as Item | undefined
      const thread = message.params?.threadId as string | undefined
      if (item?.type === 'subAgentActivity') {
        if (message.method === 'item/started') onSubAgent(item)
      } else if (thread !== undefined && thread !== conn.threadId) {
        // A sub-agent's thread.
        const sub = subOf(thread)
        for (const ev of fromThread(message, seen).flatMap(one => inline(sub.path, sub.headed, one))) {
          if (ev.t === 'cmd_output') await onOutput(ev)
          else ready.push(ev)
        }
      } else {
        await onOwn(message, item)
      }
    }
    return ready.shift() ?? { t: 'done' }
  }

  const reply = (rpc: number | string, result: Record<string, unknown>): Promise<void> =>
    send($, conn, { id: rpc, result })

  return { pull, buffered: [], tools, edits: new Map(), calls: new Map(), reply }
}

/**
 * Passes a message from the agent's caller into Codex's turn in flight, and
 * keeps it in `conn.steers` until Codex answers. Returns whether there was a
 * turn to pass it to.
 */
export async function steer(
  $: EngineInterface,
  conn: Conn,
  text: string,
): Promise<boolean> {
  const id = conn.nextId++
  conn.steers.set(id, text)
  if (conn.threadId === undefined || conn.turnId === undefined || conn.hasEnded) return false
  // The response is read by the turn's reader: there is one reader per server.
  await send($, conn, {
    id,
    method: 'turn/steer',
    params: {
      threadId: conn.threadId,
      expectedTurnId: conn.turnId,
      input: [
        {
          type: 'text',
          text: `A message from the agent that delegated this task, sent while you were working:\n${text}`,
          text_elements: [],
        },
      ],
    },
  })
  return true
}

/**
 * Starts the agent's next Codex turn on its server, opening one if none is up.
 * `said` is all the agent was told, oldest first; `pending` the messages the
 * turn gives Codex, as `prompt`; `isReview` makes it a review.
 */
export async function startTurn(
  $: EngineInterface,
  agent: Agent,
  agentId: string,
  said: string[],
  pending: string[],
  prompt: string,
  isReview: boolean,
): Promise<Run> {
  agent.limits.clear()
  const tracked = (run: Run): Run => ({
    ...run,
    pull: async () => {
      const ev = await run.pull()
      if (ev.t === 'limits') for (const limit of ev.limits) agent.limits.set(limitKey(limit), limit)
      return ev
    },
  })
  agent.unsent = merged(agent.unsent, pending)
  agent.given = pending
  await remember($, agentId, agent)
  const { bin, home } = await findCodex($)
  // The call's directory, else the agent's own (its worktree, where isolated).
  const cwd = agent.cwd ?? (await $.session.cwd())
  if (agent.conn?.hasEnded === true) {
    await closeConn($, agent.conn, false)
    agent.conn = undefined
  }
  try {
    agent.conn ??= await openConn($, bin, home, cwd)
  } catch (error) {
    return failedRun(
      `Codex could not be started: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return tracked(codexRun($, agent, agentId, agent.conn, cwd, said, prompt, isReview))
}
