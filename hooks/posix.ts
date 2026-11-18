import { DATA_DIR } from './config'
import type { Host } from './host'

// The mod's host work on macOS and Linux: `/bin/sh` scripts, and commands run
// by their argument vectors.
//
// A spawned child's stdin can be written only once, so the server's stdin is
// a named pipe (mode 600, in a folder of mode 700) that it holds open itself;
// each message is one `cat` into the pipe. A watcher process stops the server
// when the process that started it is gone. It holds the pipe open until the
// server has ended and the pipe is removed, so that a write after the server's
// end does not wait for a reader. A pid file beside the pipe, written first,
// names the server's process (`ALIVE`).

/**
 * A shell function: whether a pipe's server is running. $1: the pipe's path
 * without `.fifo`; the pid file there names a process that runs app-server.
 */
const ALIVE = `alive() { ps -p "$(cat "$1.pid" 2>/dev/null)" -o command= 2>/dev/null | grep -q app-server; }`

/**
 * Prepares the mod's Codex home, then runs the server. $0: the pipe; $1: the
 * mod's Codex home, $2: the person's, $3: the new config file; then entries to
 * link, and (prefixed `-`) old links to remove, up to `--`; the rest: Codex
 * and its arguments. Removes the pipes and pid files of servers no longer
 * running, and moves the new config into place, before the server starts.
 */
const SERVE = `${ALIVE}
run="\${0%/*}" && home="$1" && own="$2" && new="$3" && shift 3
mkdir -p "$home" "$run" && chmod 700 "$run"
for left in "$run"/*.fifo "$run"/*.pid; do
  [ -e "$left" ] || continue
  alive "\${left%.*}" || rm -f "\${left%.*}.fifo" "\${left%.*}.pid"
done
while [ $# -gt 0 ]; do
  name="$1" && shift
  case "$name" in
    --) break ;;
    -*) [ -L "$home/\${name#-}" ] && rm -f "$home/\${name#-}" ;;
    *) [ -e "$own/$name" ] && [ ! -e "$home/$name" ] && ln -s "$own/$name" "$home/$name" ;;
  esac
done
[ -f "$new" ] && mv -f "$new" "$home/config.toml"
echo $$ > "\${0%.fifo}.pid" && mkfifo -m 600 "$0" && exec 3<>"$0" || exit 1
(
  while kill -0 "$PPID" 2>/dev/null && kill -0 "$$" 2>/dev/null; do sleep 2; done
  kill "$$" 2>/dev/null
  rm -f "$0" "\${0%.fifo}.pid"
) </dev/null >/dev/null 2>&1 &
exec "$@" <&3`

/** Writes stdin to the pipe once it exists, and never to anything but a pipe. $0: the pipe. */
const SEND =
  'i=0; while [ ! -p "$0" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; [ -p "$0" ] && cat > "$0"'

/**
 * Makes and removes links, from stdin: pairs of lines, a link's path and the
 * file it leads to; an empty file removes the link, and only a link. Fails
 * when a link to make is not there after.
 */
const LINKS = `failed=0
while IFS= read -r link && IFS= read -r file; do
  if [ -z "$file" ]; then
    [ -L "$link" ] && rm -f "$link"
  elif [ ! -L "$link" ]; then
    { mkdir -p "\${link%/*}" && ln -s "$file" "$link"; } 2>/dev/null || [ -L "$link" ] || failed=1
  fi
done
exit $failed`

// `/subcodex`. Script arguments: $0 the mod's folder, $1 the person's Codex
// home, $2 the link mark; `PRUNE` also $3, an age in days.

/** Counts what is kept, one `name=value` per line; `servers` counts those running. */
const LOOK = `${ALIVE}
home="$0/codex-home"
[ -d "$0" ] && echo "kept=yes"
echo "sessions=$(find "$home/sessions" "$home/archived_sessions" -type f -name 'rollout-*.jsonl*' 2>/dev/null | wc -l | tr -d ' ')"
echo "oldest=$(find "$home/sessions" "$home/archived_sessions" -type f -name 'rollout-*.jsonl*' 2>/dev/null | sed 's|.*/rollout-||' | sort | head -1 | cut -c1-10)"
echo "size=$(du -sh "$0" 2>/dev/null | cut -f1 | tr -d ' ')"
ls "$home"/*.sqlite >/dev/null 2>&1 && echo "state=$(du -ch "$home"/*.sqlite* 2>/dev/null | tail -1 | cut -f1 | tr -d ' ')"
echo "records=$(find "$0/agents" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
echo "links=$(find "$1/sessions" "$1/archived_sessions" -type l -name "rollout-*$2.jsonl*" 2>/dev/null | wc -l | tr -d ' ')"
servers=0
for pipe in "$0"/run/*.fifo; do
  [ -p "$pipe" ] && alive "\${pipe%.fifo}" && servers=$((servers + 1))
done
echo "servers=$servers"`

// Removes the links given one per line, and the date folders this leaves empty.
const UNLINK = `unlink_each() {
  while IFS= read -r link; do
    rm -f "$link"
    case "$link" in
      */sessions/*/*/*/*)
        day=\${link%/*}; month=\${day%/*}; year=\${month%/*}
        rmdir "$day" 2>/dev/null && rmdir "$month" 2>/dev/null && rmdir "$year" 2>/dev/null
        ;;
    esac
  done
}`

/** Removes session files older than $3 days and links whose file is gone; prints the count. */
const PRUNE = `${UNLINK}
home="$0/codex-home"
find "$home/sessions" "$home/archived_sessions" -type f -name 'rollout-*.jsonl*' -mmin +"$(( $3 * 1440 ))" -print -delete 2>/dev/null | wc -l | tr -d ' '
find "$1/sessions" "$1/archived_sessions" -type l -name "rollout-*$2.jsonl*" 2>/dev/null | while IFS= read -r link; do
  [ -e "$link" ] || echo "$link"
done | unlink_each
find "$home/sessions" -mindepth 1 -type d -empty -delete 2>/dev/null
exit 0`

/** Removes every link and the mod's folder (only a path ending in `DATA_DIR`). */
const WIPE = `${UNLINK}
case "$0" in */${DATA_DIR}) ;; *) exit 1 ;; esac
find "$1/sessions" "$1/archived_sessions" -type l -name "rollout-*$2.jsonl*" 2>/dev/null | unlink_each
rm -rf "$0"`

/** Lists the session files left, one per line. */
const LEFT = `find "$0/codex-home/sessions" "$0/codex-home/archived_sessions" -type f -name 'rollout-*.jsonl*' 2>/dev/null; exit 0`

/** A script run by `/bin/sh`, its arguments `$0` onward. */
const sh = (script: string) => (args: readonly string[]) => ({ argv: ['/bin/sh', '-c', script, ...args] })

export const POSIX: Host = {
  serve: sh(SERVE),
  send: sh(SEND),
  // A stopped server's pipe and pid file.
  leave: ([fifo = '']) => ({ argv: ['/bin/rm', '-f', fifo, fifo.replace(/\.fifo$/, '.pid')] }),
  links: pairs => ({ argv: ['/bin/sh', '-c', LINKS], stdin: `${pairs.join('\n')}\n` }),
  look: sh(LOOK),
  prune: sh(PRUNE),
  wipe: sh(WIPE),
  left: sh(LEFT),
  remove: paths => ({ argv: ['/bin/rm', '-f', ...paths] }),
  sleep: ([seconds = '1']) => ({ argv: ['/bin/sleep', seconds] }),
  noop: () => ({ argv: ['/usr/bin/true'] }),
  version: ([bin = 'codex']) => ({ argv: [bin, '--version'] }),
  // The login shell's PATH.
  find: ([shell = '/bin/sh']) => ({ argv: [shell, '-lc', 'command -v codex'] }),
}
