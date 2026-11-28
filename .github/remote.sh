#!/usr/bin/env bash
# A shell on a CI runner, reached through two branches of origin.
#   remote.sh serve CHANNEL   on the runner: run each command pushed to remote/CHANNEL/in,
#                             push its output and exit code to remote/CHANNEL/out
#   remote.sh wait CHANNEL    print what the runner reports once it serves
#   remote.sh run CHANNEL F   send F (.sh runs in bash, .ps1 in pwsh) as the next command,
#                             print its output and exit with its exit code
#   remote.sh close CHANNEL   end the serving job; it deletes both branches
# Commands run one at a time in the runner's checkout; files they write stay for the next.
# On the runner, RELAY_TOKEN is the token it pushes with, and REMOTE_IDLE (seconds, 1200 by default)
# ends it after that long without a command.
set -u
[ $# -ge 2 ] || { sed -n '2,11p' "$0" >&2; exit 2; }
mode=$1 channel=$2
in=refs/heads/remote/$channel/in out=refs/heads/remote/$channel/out
git config user.name >/dev/null || export GIT_AUTHOR_NAME=remote GIT_COMMITTER_NAME=remote
git config user.email >/dev/null || export GIT_AUTHOR_EMAIL=remote@localhost GIT_COMMITTER_EMAIL=remote@localhost

# git against origin, with RELAY_TOKEN when it is set (the runner); commands never see it.
remote_git() {
  if [ -n "${RELAY_TOKEN:-}" ]; then
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$RELAY_TOKEN" | base64 | tr -d '\n')" "$@"
  else
    git "$@"
  fi
}

head_of() { remote_git ls-remote origin "$1" | cut -f1; }

# put REF PARENT PATH FILE [PATH FILE...]: push a commit on PARENT (or none) adding the files; print it.
put() {
  local ref=$1 parent=$2 index tree commit blob
  shift 2
  index=$(mktemp -u)
  [ -z "$parent" ] || GIT_INDEX_FILE=$index git read-tree "$parent"
  while [ $# -ge 2 ]; do
    blob=$(git hash-object -w "$2") &&
      GIT_INDEX_FILE=$index git update-index --add --cacheinfo "100644,$blob,$1" || return 1
    shift 2
  done
  tree=$(GIT_INDEX_FILE=$index git write-tree) && rm -f "$index" &&
    commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "$ref") &&
    remote_git push -q origin "$commit:$ref" && echo "$commit"
}

# fetched REF: fetch REF from origin when it moved; true when it exists.
fetched() {
  local sha
  sha=$(head_of "$1")
  [ -n "$sha" ] || return 1
  git cat-file -e "$sha^{commit}" 2>/dev/null || remote_git fetch -q origin "$1" || return 1
  fetched_sha=$sha
}

serve() {
  local tmp n=1 head seen= last=$SECONDS idle=${REMOTE_IDLE:-1200} f status
  tmp=$(cygpath -u "${RUNNER_TEMP:-/tmp}" 2>/dev/null || echo "${RUNNER_TEMP:-/tmp}")/remote-$channel
  mkdir -p "$tmp"
  trap 'remote_git push -q origin --delete "$in" "$out" 2>/dev/null' EXIT
  { uname -a; echo "cwd $PWD"; echo "idle $idle s"; } > "$tmp/ready"
  head=$(put "$out" "" ready "$tmp/ready") || exit 1
  while [ $((SECONDS - last)) -lt "$idle" ]; do
    if ! fetched "$in" || [ "$fetched_sha" = "$seen" ]; then sleep 2; continue; fi
    seen=$fetched_sha
    while :; do
      f=
      for ext in sh ps1 exit; do
        git cat-file -e "$seen:cmd/$n.$ext" 2>/dev/null && f=cmd/$n.$ext
      done
      [ -n "$f" ] || break
      case $f in *.exit) exit 0 ;; esac
      git show "$seen:$f" > "$tmp/$n.${f##*.}"
      case $f in
        *.sh) env -u RELAY_TOKEN bash "$tmp/$n.sh" > "$tmp/$n.log" 2>&1 < /dev/null ;;
        *.ps1) env -u RELAY_TOKEN pwsh -NoProfile -File "$(cygpath -w "$tmp/$n.ps1" 2>/dev/null || echo "$tmp/$n.ps1")" > "$tmp/$n.log" 2>&1 < /dev/null ;;
      esac
      status=$?
      echo "$status" > "$tmp/$n.exit"
      head=$(put "$out" "$head" "out/$n.log" "$tmp/$n.log" "out/$n.exit" "$tmp/$n.exit") || exit 1
      n=$((n + 1)) last=$SECONDS
    done
  done
}

send() {
  local file=$1 ext parent= n
  ext=${file##*.}
  case $ext in sh | ps1 | exit) ;; *) echo "remote.sh: $file must end in .sh or .ps1" >&2; return 2 ;; esac
  ! fetched "$in" || parent=$fetched_sha
  n=$(( $( [ -z "$parent" ] || git ls-tree --name-only "$parent" cmd/ | wc -l) + 1 ))
  put "$in" "$parent" "cmd/$n.$ext" "$file" > /dev/null || return 1
  [ "$ext" != exit ] || return 0
  while ! fetched "$out" || ! git cat-file -e "$fetched_sha:out/$n.exit" 2>/dev/null; do sleep 2; done
  git show "$fetched_sha:out/$n.log"
  return "$(git show "$fetched_sha:out/$n.exit")"
}

case $mode in
  serve) serve ;;
  wait) until fetched "$out"; do sleep 2; done; git show "$fetched_sha:ready" ;;
  run) [ $# -ge 3 ] || exit 2; send "$3" ;;
  close) empty=$(mktemp); mv "$empty" "$empty.exit"; send "$empty.exit"; rm -f "$empty.exit" ;;
  *) sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
