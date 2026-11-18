import { DATA_DIR } from './config'
import type { Host } from './host'

// The mod's host work on Windows, in PowerShell 7 (`pwsh`).
//
// The server's stdin is a named pipe, `\\.\pipe\subcodex-<name>`, that only
// the person can open; `<name>` comes from the pipe path the mod keeps
// (`<run folder>/<name>.fifo`, which is no file on Windows). A helper process
// starts the server with its stdin redirected, and copies each connection to
// the pipe into it; the server's own output goes straight to the mod. Each
// message is one connection, made only to a pipe of the person's own account.
// The helper holds the server's pid file (`<name>.pid`) open, and the file is
// deleted when the helper ends, however it ends: a pid file held open is a
// server at work. Links are symbolic links (Developer Mode, or an
// administrator).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A script in UTF-16LE, base64-encoded: what `pwsh -EncodedCommand` takes. */
export function encoded(script: string): string {
  const bytes: number[] = []
  for (let at = 0; at < script.length; at++) {
    const unit = script.charCodeAt(at)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let text = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b, c] = [bytes[at], bytes[at + 1], bytes[at + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    text += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}${b === undefined ? '=' : ALPHABET[(n >> 6) & 63]}${c === undefined ? '=' : ALPHABET[n & 63]}`
  }
  return text
}

/** A PowerShell string literal of `text`. */
export const literal = (text: string): string => `'${text.replace(/['‘’‚‛]/g, quote => quote + quote)}'`

/** What a script starts with: `$a`, the array of `args`. */
const headOf = (args: readonly string[]): string =>
  [`$ProgressPreference = 'SilentlyContinue'`, `$a = @(${args.map(literal).join(', ')})`].join('\n')

/** PowerShell 7, running the script given to `-EncodedCommand`. */
const PWSH = ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']

/** The command that runs `script` in PowerShell 7, with `$a` the array of `args`. */
export function pwsh(script: string, args: readonly string[] = []): string[] {
  return [...PWSH, encoded(`${headOf(args)}\n${script}`)]
}

/** A script that reads a script from stdin, as UTF-8, and runs it. */
const READ_STDIN = encoded(
  '& ([scriptblock]::Create([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()))',
)

// Functions the scripts share.
const COMMON = String.raw`
function Full($path) { [IO.Path]::GetFullPath($path) }
function IsLink($entry) { $null -ne $entry.LinkTarget }
# Writes text to stdout as UTF-8.
function Say($text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$text)
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}
# Every entry under a folder; linked folders are listed, not walked into.
function Walk($dir) {
  $todo = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  if ([IO.Directory]::Exists($dir)) { $todo.Push([IO.DirectoryInfo]::new($dir)) }
  while ($todo.Count -gt 0) {
    $at = $todo.Pop()
    try { $entries = $at.GetFileSystemInfos() } catch { continue }
    foreach ($entry in $entries) {
      if (($entry -is [IO.DirectoryInfo]) -and -not (IsLink $entry)) { $todo.Push($entry) }
      $entry
    }
  }
}
# Whether a link leads to something that is there.
function Leads($link) {
  try { $target = $link.ResolveLinkTarget($true); $null -ne $target -and $target.Exists } catch { $false }
}
# Whether a pid file is held open: its server is at work.
function IsHeld($path) {
  try { [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None).Dispose(); $false }
  catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $false }
  catch [IO.IOException] { $true }
  catch { $false }
}
# Removes a link of the mod's in the person's Codex home, and the date folders this leaves empty.
function Unlink($path) {
  try { [IO.File]::Delete($path) } catch { return }
  if ($path -like '*\sessions\*\*\*\*') {
    $day = [IO.Path]::GetDirectoryName($path)
    $month = [IO.Path]::GetDirectoryName($day)
    try { [IO.Directory]::Delete($day); [IO.Directory]::Delete($month); [IO.Directory]::Delete([IO.Path]::GetDirectoryName($month)) } catch {}
  }
}
# The links of the mod's in the person's Codex home: $own the home, $mark the link mark.
function Links($own, $mark) {
  foreach ($dir in "$own\sessions", "$own\archived_sessions") {
    Walk $dir | Where-Object { (IsLink $_) -and -not ($_ -is [IO.DirectoryInfo]) -and $_.Name -like "rollout-*$mark.jsonl*" }
  }
}
# The session files in the mod's Codex home.
function Sessions($modHome) {
  foreach ($dir in "$modHome\sessions", "$modHome\archived_sessions") {
    Walk $dir | Where-Object { -not (IsLink $_) -and ($_ -is [IO.FileInfo]) -and $_.Name -like 'rollout-*.jsonl*' }
  }
}
`

/**
 * Prepares the mod's Codex home, then runs the server. $a: the pipe's path, the
 * mod's Codex home, the person's, the new config file; then entries to link,
 * and (prefixed `-`) old links to remove, up to `--`; the rest: Codex and its
 * arguments.
 *
 * Makes the pipe folder the person's alone, removes the pid files no helper
 * holds, and moves the new config into place. Then makes the pipe, starts the
 * server, writes and holds its pid file, and copies each connection into the
 * server's stdin until the server ends; once the process that started the
 * helper is gone, closes the server's stdin, and after 5 seconds ends the
 * server and what it started.
 */
const SERVE = String.raw`
$base = (Full $a[0]) -replace '\.fifo$', ''
$run = [IO.Path]::GetDirectoryName($base); $modHome = Full $a[1]; $own = Full $a[2]; $new = Full $a[3]
$at = [Array]::IndexOf($a, '--', 4)
if ($at -lt 0) { exit 1 }
[void][IO.Directory]::CreateDirectory($modHome)
$runFolder = [IO.Directory]::CreateDirectory($run)
try {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
  [IO.FileSystemAclExtensions]::SetAccessControl($runFolder, $acl)
} catch {}
foreach ($file in [IO.Directory]::GetFiles($run, '*.pid')) {
  if (-not (IsHeld $file)) { try { [IO.File]::Delete($file) } catch {} }
}
foreach ($name in @($a | Select-Object -Skip 4 -First ($at - 4))) {
  if ($name.StartsWith('-')) {
    $entry = Get-Item -LiteralPath (Join-Path $modHome $name.Substring(1)) -Force -ErrorAction SilentlyContinue
    if ($entry -and (IsLink $entry)) { try { $entry.Delete() } catch {} }
  } else {
    $from = Join-Path $own $name; $to = Join-Path $modHome $name
    if ((Test-Path -LiteralPath $from) -and -not (Test-Path -LiteralPath $to)) {
      try {
        if ([IO.Directory]::Exists($from)) { [void][IO.Directory]::CreateSymbolicLink($to, $from) }
        else { [void][IO.File]::CreateSymbolicLink($to, $from) }
      } catch {}
    }
  }
}
try { if ([IO.File]::Exists($new)) { [IO.File]::Move($new, (Join-Path $modHome 'config.toml'), $true) } } catch {}
$pipeName = 'subcodex-' + [IO.Path]::GetFileName($base)
try {
  $pipe = [IO.Pipes.NamedPipeServerStream]::new($pipeName, [IO.Pipes.PipeDirection]::In, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]'Asynchronous, CurrentUserOnly')
  $start = [Diagnostics.ProcessStartInfo]::new($a[$at + 1])
  foreach ($arg in @($a | Select-Object -Skip ($at + 2))) { $start.ArgumentList.Add($arg) }
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $server = [Diagnostics.Process]::Start($start)
  $pidFile = [IO.FileStream]::new("$base.pid", [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]'ReadWrite, Delete', 4096, [IO.FileOptions]::DeleteOnClose)
  $bytes = [Text.Encoding]::ASCII.GetBytes([string]$server.Id)
  $pidFile.Write($bytes, 0, $bytes.Length)
  $pidFile.Flush()
} catch {
  exit 1
}
$toServer = $server.StandardInput.BaseStream
$parent = $null
$waiting = $pipe.WaitForConnectionAsync()
while (-not $server.HasExited) {
  if ($null -eq $parent) { try { $parent = (Get-Process -Id $PID).Parent } catch {} }
  try { if ($parent -and $parent.HasExited) { break } } catch {}
  try { [void]$waiting.Wait(2000) } catch {}
  if (-not $waiting.IsCompleted) { continue }
  if ($waiting.IsCompletedSuccessfully) {
    try { $pipe.CopyTo($toServer); $toServer.Flush() } catch {}
  } else {
    Start-Sleep -Milliseconds 200
  }
  try { $pipe.Disconnect() } catch {}
  try { $waiting = $pipe.WaitForConnectionAsync() } catch { Start-Sleep -Milliseconds 200 }
}
if (-not $server.HasExited) {
  try { $toServer.Close() } catch {}
  if (-not $server.WaitForExit(5000)) { try { $server.Kill($true) } catch {} }
}
$pidFile.Dispose()
exit 0
`

/** Writes stdin to the pipe once it exists (up to 5 seconds). $a: the pipe's path. */
const SEND = String.raw`
$name = 'subcodex-' + [IO.Path]::GetFileNameWithoutExtension([IO.Path]::GetFullPath($a[0]))
$clock = [Diagnostics.Stopwatch]::StartNew()
$pipe = $null
while ($null -eq $pipe -and $clock.ElapsedMilliseconds -lt 5000) {
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::Out, [IO.Pipes.PipeOptions]::CurrentUserOnly)
  try { $client.Connect(100); $pipe = $client } catch { $client.Dispose(); Start-Sleep -Milliseconds 50 }
}
if ($null -eq $pipe) { exit 1 }
[Console]::OpenStandardInput().CopyTo($pipe)
$pipe.Dispose()
exit 0
`

/**
 * Makes and removes links. $a: pairs of a link's path and the file it leads
 * to; an empty file removes the link, and only a link. Fails when a link to
 * make is not there after.
 */
const LINKS = String.raw`
$failed = 0
for ($at = 0; $at + 1 -lt $a.Count; $at += 2) {
  $link = Full $a[$at]; $file = $a[$at + 1]
  $entry = [IO.FileInfo]::new($link)
  if ($file -eq '') {
    if (IsLink $entry) { try { $entry.Delete() } catch {} }
  } elseif (-not (IsLink $entry)) {
    try {
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($link))
      [void][IO.File]::CreateSymbolicLink($link, (Full $file))
    } catch {
      if (-not (IsLink ([IO.FileInfo]::new($link)))) { $failed = 1 }
    }
  }
}
exit $failed
`

// `/subcodex`. $a: the mod's folder, the person's Codex home, the link mark;
// `PRUNE` also an age in days.

/** Counts what is kept, one `name=value` per line; `servers` counts those at work. */
const LOOK = String.raw`
function Human([double]$size) {
  $units = 'B', 'K', 'M', 'G', 'T', 'P'; $at = 0
  while ($size -ge 1024 -and $at -lt 5) { $size /= 1024; $at++ }
  if ($at -eq 0) { return "$([int]$size)B" }
  if ($size -lt 10) { return ([Math]::Ceiling($size * 10) / 10).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture) + $units[$at] }
  "$([Math]::Ceiling($size))$($units[$at])"
}
$data = Full $a[0]; $own = Full $a[1]; $mark = $a[2]; $modHome = "$data\codex-home"
$isKept = [IO.Directory]::Exists($data)
$sessions = 0; $size = 0; $records = 0
$names = [Collections.Generic.List[string]]::new()
foreach ($entry in @(Walk $data)) {
  if (($entry -is [IO.DirectoryInfo]) -or (IsLink $entry)) { continue }
  $size += $entry.Length
  $path = $entry.FullName
  $isSession = $path.StartsWith("$modHome\sessions\", [StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith("$modHome\archived_sessions\", [StringComparison]::OrdinalIgnoreCase)
  if ($isSession -and $entry.Name -like 'rollout-*.jsonl*') { $sessions++; $names.Add($entry.Name.Substring(8)) }
  elseif ($path.StartsWith("$data\agents\", [StringComparison]::OrdinalIgnoreCase) -and $entry.Name -like '*.json') { $records++ }
}
$sorted = $names.ToArray(); [Array]::Sort($sorted, [StringComparer]::Ordinal)
$lines = [Collections.Generic.List[string]]::new()
if ($isKept) { $lines.Add('kept=yes') }
$lines.Add("sessions=$sessions")
$lines.Add('oldest=' + $(if ($sorted.Count -gt 0) { $sorted[0].Substring(0, [Math]::Min(10, $sorted[0].Length)) } else { '' }))
$lines.Add('size=' + $(if ($isKept) { Human $size } else { '' }))
$state = @(Get-ChildItem -LiteralPath $modHome -Filter '*.sqlite*' -File -Force -ErrorAction SilentlyContinue)
if (@($state | Where-Object { $_.Extension -eq '.sqlite' }).Count -gt 0) {
  $lines.Add("state=$(Human (($state | Measure-Object Length -Sum).Sum))")
}
$lines.Add("records=$records")
$lines.Add("links=$(@(Links $own $mark).Count)")
$servers = 0
foreach ($file in @(Get-ChildItem -LiteralPath "$data\run" -Filter '*.pid' -File -ErrorAction SilentlyContinue)) {
  if (IsHeld $file.FullName) { $servers++ }
}
$lines.Add("servers=$servers")
Say (($lines -join [char]10) + [char]10)
`

/** Removes session files older than the age in days and links whose file is gone; prints the count. */
const PRUNE = String.raw`
$data = Full $a[0]; $own = Full $a[1]; $mark = $a[2]; $modHome = "$data\codex-home"
$cut = (Get-Date).AddMinutes(-1440 * [int]$a[3])
$count = 0
foreach ($file in @(Sessions $modHome)) {
  if ($file.LastWriteTime -lt $cut) { try { $file.Delete(); $count++ } catch {} }
}
Say ("$count" + [char]10)
foreach ($link in @(Links $own $mark)) { if (-not (Leads $link)) { Unlink $link.FullName } }
$dirs = @(Walk "$modHome\sessions" | Where-Object { ($_ -is [IO.DirectoryInfo]) -and -not (IsLink $_) } | Sort-Object { $_.FullName.Length } -Descending)
foreach ($dir in $dirs) { try { [IO.Directory]::Delete($dir.FullName) } catch {} }
exit 0
`

/** Removes every link and the mod's folder (only a path ending in `DATA_DIR`); links in it are removed, not followed. */
const WIPE = String.raw`
$data = Full $a[0]; $own = Full $a[1]; $mark = $a[2]
if (-not $data.EndsWith(${literal(`\\${DATA_DIR.replace(/\//g, '\\')}`)}, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
foreach ($link in @(Links $own $mark)) { Unlink $link.FullName }
if ([IO.Directory]::Exists($data)) { [IO.Directory]::Delete($data, $true) }
exit 0
`

/** Lists the session files left, one per line. */
const LEFT = String.raw`
$files = @(Sessions ((Full $a[0]) + '\codex-home') | ForEach-Object { $_.FullName + [char]10 })
Say ($files -join '')
exit 0
`

/** Removes the files named on stdin, one per line. */
const REMOVE = String.raw`
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
foreach ($line in $reader.ReadToEnd().Split([char]10)) {
  $path = $line.Trim()
  if ($path -ne '') { try { [IO.File]::Delete($path) } catch {} }
}
exit 0
`

/**
 * Prints where `codex` is: on the PATH Windows gives a new process (the
 * system's, then the person's), else on this process's.
 */
const FIND = String.raw`
$env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
$found = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found) { Say $found.Source }
exit 0
`

/** Prints Codex's version. $a: Codex. */
const VERSION = String.raw`
$version = & $a[0] --version 2>$null
Say ((@($version) -join [char]10).Trim())
`

/** A script given on stdin, after the shared functions; the command line holds `READ_STDIN` alone. */
const piped = (script: string) => (args: readonly string[]) => ({
  argv: [...PWSH, READ_STDIN],
  stdin: `${headOf(args)}\n${COMMON}${script}`,
})

/** A short script on the command line, for an operation whose stdin is its data. */
const inline = (script: string) => (args: readonly string[]) => ({ argv: pwsh(script, args) })

export const WINDOWS: Host = {
  serve: piped(SERVE),
  send: inline(SEND),
  // A stopped server's pid file goes with its helper, and its pipe is no file.
  leave: () => ({ argv: [] }),
  links: piped(LINKS),
  look: piped(LOOK),
  prune: piped(PRUNE),
  wipe: piped(WIPE),
  left: piped(LEFT),
  remove: paths => ({ argv: pwsh(REMOVE), stdin: `${paths.join('\n')}\n` }),
  sleep: inline('Start-Sleep -Seconds ([int]$a[0])'),
  noop: inline('exit 0'),
  version: piped(VERSION),
  find: piped(FIND),
}
