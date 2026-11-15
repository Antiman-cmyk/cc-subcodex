import type { EngineInterface } from 'claude-code'

import {
  CODEX_HOME,
  OWN_CODEX_HOME,
  PLUGIN,
  RUN_DIR,
  SHARED,
  UNSHARED,
  USAGE_MARK,
  VERSION,
} from './config'
import { loginOf, ownConfig, skillRoots } from './codex-home'
import { trace } from './log'
import type { Conn, Rpc } from './types'

// Runs `codex app-server` and speaks its newline-delimited JSON-RPC.
//
// A spawned child's stdin can be written only once, so the server's stdin is
// a named pipe (mode 600, in a folder of mode 700) that it holds open itself;
// each message is one `cat` into the pipe. A watcher process stops the server
// when the process that started it is gone. It holds the pipe open until the
// server has ended and the pipe is removed, so that a write after the server's
// end does not wait for a reader.
const SERVE = `mkfifo -m 600 "$0" && exec 3<>"$0" || exit 1
(
  while kill -0 "$PPID" 2>/dev/null && kill -0 "$$" 2>/dev/null; do sleep 2; done
  kill "$$" 2>/dev/null
  rm -f "$0"
) </dev/null >/dev/null 2>&1 &
exec "$1" app-server --disable memories --disable chronicle --disable plugins --disable apps -c "skills.bundled.enabled=false" -c "notify=[]" <&3`
// Writes stdin to the pipe once it exists, and never to anything but a pipe.
const SEND =
  'i=0; while [ ! -p "$0" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; [ -p "$0" ] && cat > "$0"'
// Prepares the mod's Codex home. $0: the mod's Codex home, $1: the person's,
// $2: the pipe folder, $3: the new config file; the rest: entries to link, and
// (prefixed `-`) old links to remove. Removes pipes over a day old, then moves
// the new config into place.
const LINK =
  'mkdir -p "$0" "$2" && chmod 700 "$2" && find "$2" -name "*.fifo" -mtime +1 -delete; home="$0" && own="$1" && new="$3" && shift 3 && for name in "$@"; do case "$name" in -*) [ -L "$home/${name#-}" ] && rm -f "$home/${name#-}" ;; *) [ -e "$own/$name" ] && [ ! -e "$home/$name" ] && ln -s "$own/$name" "$home/$name" ;; esac; done; [ -f "$new" ] && mv -f "$new" "$home/config.toml"; exit 0'

// After a server stops: removes its pipe, drops links whose file is gone, and
// links each new session file into the person's Codex home at the same path
// (`USAGE_MARK`). $0: the pipe, $1: the mod's Codex home, $2: the person's,
// $3: the mark.
const LEAVE = `rm -f "$0"
for link in "$2"/sessions/*/*/*/rollout-*"$3".jsonl*; do
  [ -L "$link" ] && [ ! -e "$link" ] && rm -f "$link"
done
cd "$1" || exit 0
for file in sessions/*/*/*/rollout-*.jsonl*; do
  [ -f "$file" ] || continue
  case "$file" in
    *.jsonl.zst) link="$2/\${file%.jsonl.zst}$3.jsonl.zst" ;;
    *) link="$2/\${file%.jsonl}$3.jsonl" ;;
  esac
  [ -L "$link" ] || { mkdir -p "\${link%/*}" && ln -s "$1/$file" "$link"; }
done`

/** Writes one message to the server, after any write still in flight. */
export async function send($: EngineInterface, conn: Conn, message: Rpc): Promise<void> {
  const sent = conn.sending.then(() =>
    $.process.run(['/bin/sh', '-c', SEND, conn.fifo], {
      stdin: `${JSON.stringify(message)}\n`,
    }),
  )
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
    await $.process.run(['/bin/sleep', String(tries)]).catch(() => undefined)
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
  await $.process.run(['/bin/mkdir', '-p', `${home}/${CODEX_HOME}`]).catch(() => undefined)
  await $.fs.write(written, ownConfig(config)).catch(() => undefined)
  await $.process
    .run([
      '/bin/sh',
      '-c',
      LINK,
      `${home}/${CODEX_HOME}`,
      `${home}/${OWN_CODEX_HOME}`,
      `${home}/${RUN_DIR}`,
      written,
      ...SHARED,
      ...UNSHARED.map(name => `-${name}`),
    ])
    .catch(() => undefined)
  const child = $.process.spawn({
    argv: ['/bin/sh', '-c', SERVE, fifo, bin],
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
      clientInfo: { name: PLUGIN, title: PLUGIN, version: VERSION },
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
    conn.isStopped = isAbort(error) && !(await $.process.run(['/usr/bin/true']).then(() => true, () => false))
  }
  return conn
}

/** Stops the server (interrupting a turn in flight) and links its new session files. */
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
  await $.process
    .run([
      '/bin/sh',
      '-c',
      LEAVE,
      conn.fifo,
      `${conn.home}/${CODEX_HOME}`,
      `${conn.home}/${OWN_CODEX_HOME}`,
      USAGE_MARK,
    ])
    .catch(() => undefined)
}
