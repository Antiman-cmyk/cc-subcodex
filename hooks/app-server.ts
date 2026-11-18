import type { EngineInterface } from 'claude-code'

import {
  CODEX_HOME,
  OWN_CODEX_HOME,
  PLUGIN,
  RUN_DIR,
  SHARED,
  UNSHARED,
} from './config'
import { loginOf, ownConfig, sandboxChoice, skillRoots } from './codex-home'
import { hostCommand, hostRun } from './host'
import { trace } from './log'
import type { Conn, Rpc } from './types'
import { linkSessions } from './usage-links'

// Runs `codex app-server` and speaks its newline-delimited JSON-RPC, through
// the host operations of host.ts: the server's stdin is a pipe the mod writes
// each message to (`send`).

/** What the server is started with, after the Codex binary. */
const SERVER_ARGS = [
  'app-server',
  '--disable',
  'memories',
  '--disable',
  'chronicle',
  '--disable',
  'plugins',
  '--disable',
  'apps',
  '-c',
  'skills.bundled.enabled=false',
  '-c',
  'notify=[]',
]

let version: string | undefined

/** The mod's version, from its plugin.json; read once. */
async function versionOf($: EngineInterface): Promise<string> {
  if (version !== undefined) return version
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
  }
  return version ?? 'unknown'
}

/** Writes one message to the server, after any write still in flight. */
export async function send($: EngineInterface, conn: Conn, message: Rpc): Promise<void> {
  const sent = conn.sending.then(() => hostRun($, 'send', [conn.fifo], { stdin: `${JSON.stringify(message)}\n` }))
  conn.sending = sent.then(
    () => undefined,
    () => undefined,
  )
  await sent
}

/** The next message the server wrote; undefined once it has ended. */
export async function readMessage(conn: Conn): Promise<Rpc | undefined> {
  for (;;) {
    const at = conn.partial.indexOf('\n')
    if (at >= 0) {
      const line = conn.partial.slice(0, at).trim()
      conn.partial = conn.partial.slice(at + 1)
      if (line === '') continue
      try {
        return JSON.parse(line) as Rpc
      } catch {
        continue
      }
    }
    if (conn.hasEnded) return undefined
    const piece = await conn.next()
    if (piece.done === true || piece.value === undefined) {
      conn.hasEnded = true
      continue
    }
    if (piece.value.stream === 'stdout') conn.partial += piece.value.text
  }
}

/** Whether an error comes from the agent being stopped. */
export const isAbort = (error: unknown): boolean =>
  /\baborted\b/.test(error instanceof Error ? error.message : String(error))

/** Sends a request and waits for its response, holding what comes between. */
export async function request(
  $: EngineInterface,
  conn: Conn,
  method: string,
  params: Record<string, unknown>,
): Promise<Rpc> {
  const id = conn.nextId++
  await send($, conn, { id, method, params })
  for (;;) {
    const message = await readMessage(conn)
    if (message === undefined) return { error: { message: 'app-server ended' } }
    if (message.id === id && message.method === undefined) return message
    conn.held.push(message)
  }
}

/**
 * Starts an app-server (`openOnce`), up to three times if it exits at once:
 * servers started together on a fresh Codex home can fail to set up its state.
 */
export async function openConn(
  $: EngineInterface,
  bin: string,
  home: string,
  cwd: string,
): Promise<Conn> {
  for (let tries = 1; ; tries++) {
    const conn = await openOnce($, bin, home, cwd)
    if (conn.isUp || conn.isStopped || tries === 3) return conn
    trace($, `app-server gave no answer (try ${tries}); starting it again`)
    await closeConn($, conn, false)
    await hostRun($, 'sleep', [String(tries)]).catch(() => undefined)
  }
}

/** Starts an app-server on the mod's Codex home, logs it in and gives it Claude's skills. */
async function openOnce(
  $: EngineInterface,
  bin: string,
  home: string,
  cwd: string,
): Promise<Conn> {
  const name = Math.random().toString(36).slice(2, 12)
  const fifo = `${home}/${RUN_DIR}/${name}.fifo`
  const config = await $.fs.read(`${home}/${OWN_CODEX_HOME}/config.toml`).catch(() => '')
  const written = `${home}/${CODEX_HOME}/config.toml.${name}`
  await $.fs.write(written, ownConfig(config)).catch(() => undefined)
  const serve = hostCommand($, 'serve', [
    fifo,
    `${home}/${CODEX_HOME}`,
    `${home}/${OWN_CODEX_HOME}`,
    written,
    ...SHARED,
    ...UNSHARED.map(name => `-${name}`),
    '--',
    bin,
    ...SERVER_ARGS,
    ...sandboxChoice($, config),
  ])
  const child = $.process.spawn({
    argv: serve.argv,
    ...(serve.stdin === undefined ? {} : { input: serve.stdin }),
    env: { CODEX_HOME: `${home}/${CODEX_HOME}` },
  })
  // The child starts at its first pull; that pull goes to the first reader.
  let first: ReturnType<typeof child.next> | undefined = child.next()
  const conn: Conn = {
    home,
    next: async () => {
      const pull = first ?? child.next()
      first = undefined
      const piece = await pull
      return piece.done === true ? { done: true } : { value: piece.value }
    },
    kill: () => {
      void child.return({ code: null, signal: null }).catch(() => undefined)
    },
    fifo,
    partial: '',
    held: [],
    nextId: 1,
    threadId: undefined,
    turnId: undefined,
    contextTokens: undefined,
    warned: new Set(),
    steers: new Map(),
    isUp: false,
    isLoggedIn: false,
    isStopped: false,
    hasEnded: false,
    sending: Promise.resolve(),
    subs: new Map(),
  }
  // The connection is returned even when start-up fails, so that it is closed.
  try {
    const greeted = await request($, conn, 'initialize', {
      clientInfo: { name: PLUGIN, title: PLUGIN, version: await versionOf($) },
      capabilities: { experimentalApi: true },
    })
    conn.isUp = greeted.error === undefined
    if (!conn.isUp) return conn
    await send($, conn, { method: 'initialized' })
    const login = await loginOf($, home)
    if (login !== undefined) {
      await request($, conn, 'account/login/start', { type: 'chatgptAuthTokens', ...login })
    }
    const account = await request($, conn, 'account/read', {})
    // A provider of its own (an API key) needs no OpenAI login.
    conn.isLoggedIn = account.result?.account != null || account.result?.requiresOpenaiAuth === false
    const roots = await skillRoots($, home, cwd)
    if (roots.length > 0) {
      const set = await request($, conn, 'skills/extraRoots/set', { extraRoots: roots })
      trace($, `skills: ${roots.length} folders ${set.error === undefined ? 'given' : `refused (${set.error.message})`}`)
    }
  } catch (error) {
    conn.hasEnded = true
    conn.isUp = false
    // A stopped agent's `$` calls all fail; a server that ended by itself leaves them working, and is retried.
    conn.isStopped = isAbort(error) && !(await hostRun($, 'noop').then(() => true, () => false))
  }
  return conn
}

/** Stops the server (interrupting a turn in flight), removes its pipe and links its new session files. */
export async function closeConn(
  $: EngineInterface,
  conn: Conn,
  isMidTurn: boolean,
): Promise<void> {
  if (isMidTurn && conn.threadId !== undefined && conn.turnId !== undefined && !conn.hasEnded) {
    await send($, conn, {
      id: conn.nextId++,
      method: 'turn/interrupt',
      params: { threadId: conn.threadId, turnId: conn.turnId },
    }).catch(() => undefined)
  }
  conn.hasEnded = true
  conn.kill()
  await hostRun($, 'leave', [conn.fifo]).catch(() => undefined)
  await linkSessions($, conn.home)
}
