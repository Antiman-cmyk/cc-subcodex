# subcodex

A Claude Code mod that adds OpenAI Codex as a native subagent type, `subcodex:codex`. The main agent dispatches it like any other subagent: it appears in the task list, Codex's work shows in the agent's transcript, and it can be sent follow-up messages, steered while it works, stopped, and used in workflows. Codex does the task; its closing message is the agent's result.

## Requirements

- Claude Code, tested with the version in `.github/versions.json` (the Mod API is in early access).
- The Codex CLI, tested with the version in `.github/versions.json`, installed and logged in with a ChatGPT account (it uses experimental app-server APIs). An API key saved with `codex login --with-api-key` is not used. To use an API key, define a model provider in `~/.codex/config.toml` that reads the key from an environment variable (`env_key`), and set that variable for Claude Code.
- macOS, Linux or Windows. On Windows: PowerShell 7 (`pwsh`) installed and on the PATH, in which the mod's own work there runs; Developer Mode on (Settings > System > For developers): the mod makes symbolic links. Where it cannot make them, `/subcodex` and the agent's transcript say so, and the session makes no more usage links.

## Installation

In a Claude Code session in the terminal:

```
/plugin install subcodex --marketplace Antiman-cmyk/cc-subcodex
```

Or from a shell:

```bash
claude plugin install subcodex --marketplace Antiman-cmyk/cc-subcodex
```

In the desktop app: click + next to the input box, choose Plugins, add the marketplace `Antiman-cmyk/cc-subcodex`, then add the plugin. A plugin installed at user scope is also loaded by the desktop app's local sessions.

To load from source:

```bash
claude --plugin-dir /path/to/cc-subcodex
```

For the desktop app, set `CLAUDE_CODE_PLUGIN_DIRS` to this directory under `env` in `~/.claude/settings.json`.

## Usage

The main agent dispatches the agent with the Agent tool, `subagent_type: "subcodex:codex"`. The agent takes any task a general-purpose agent would, and its description tells Claude to use it only when you ask: name Codex, OpenAI or GPT, or ask for another model's view.

- **Effort**: the Agent tool's `effort` parameter (low / medium / high / xhigh / max).
- **Model**: make the first line of the prompt `@codex model=<Codex model id>`. The line is not passed to Codex. It also accepts `effort=<level>`, including `ultra`.
- **Defaults**: without either, the model and effort in `~/.codex/config.toml`: its active profile's (`profile`), else those at its top. The task title shows the model and effort in use.
- **Follow-ups**: send the agent a message after it finishes; Codex continues in the same thread.
- **Steering**: a message sent while the agent runs goes into Codex's current turn. One that Codex does not take in before its turn ends starts another Codex turn before the agent finishes.
- **Stopping**: stopping the agent interrupts Codex's current turn. A later message continues the same thread; messages Codex had not yet taken in are kept in the agent's record, across a restart too, and given to it with the new one.
- **Questions**: when Codex needs a decision from its caller, it ends its turn with the question; answer with a message to the agent.
- **Workflows**: `agent(prompt, { agentType: 'subcodex:codex' })`, with `schema` supported. The workflow `effort` and `model` options have no effect; use the prompt's first line.
- **Code review**: `@codex review` on the first line runs Codex's review mode and returns findings ranked P0–P3. The rest of the prompt says what to review; with nothing more, it reviews uncommitted changes. Review mode covers code changes only and starts without the conversation's context; for papers, data or other material, dispatch an ordinary task that states the criteria.

## How it works

The agent's loop is run by Claude Code, so the task list, background runs, transcripts and notifications behave as for any subagent. While Codex works, the mod answers each step of the agent from Codex's event stream instead of sending a Claude request:

- Codex's text becomes text rows; its commands become Bash rows (on Windows PowerShell rows, where the session has the PowerShell tool) carrying Codex's real output (nothing is run again), with the latest lines of output shown under the row while a command runs; its edits of files in place and its new files become native Edit and Write rows with the diff (the tools are not run); a delete, a move or a failed edit is a row with the diff.
- Codex's other actions each get a line: web searches and their results, its own MCP tools, plans, viewing or generating images, waiting, review mode, context compaction, its reviewer's decisions, warnings, and usage limits nearly used up.
- Codex's own sub-agents show in the same transcript, their text prefixed with `[Codex sub-agent <name>]`. Codex manages them; they end when the Codex agent is stopped.
- When a Codex turn ends, the message Codex marks as its final answer is the agent's result.

### Native delivery without Claude requests

In auto mode, the mod uses a local Messages API response for each `SendMessage`, `SubagentHandback` and workflow result; in other modes it writes those calls itself. The engine builds the normal request under the reserved model name `subcodex-local`; the mod's `http.fetch` hook answers it before it reaches the network. The native tool still executes, so delivery, background notifications, follow-ups and explicit deny rules stay with the engine.

The response includes a **simulated classifier acknowledgement** for that exact tool call. No Claude safety review takes place. This prevents the engine from attaching a classifier-unavailable warning to the report or Desktop notification. The report remains Codex's closing message, word for word, without generated hand-off notes. Records are marked `<synthetic>` with zero usage.

The mechanism is scoped to this mod's own agents and pending protocol calls. Unexpected requests are refused rather than sent to a Claude model. It depends on the early-access engine protocol, which CI tests with the Claude Code version in `.github/versions.json`; organization guards that restrict `http.fetch` can make it unavailable.

### Workflow schemas

Native Claude workflow agents receive a `StructuredOutput` tool and produce its arguments themselves; they do not require a separate small model to rewrite their answer. This mod follows the same contract: a local preparation step reads that tool's schema, Codex receives it as the `workflow_result` client tool, and its arguments are submitted to the native `StructuredOutput` tool for validation. Validation errors go back to Codex for correction. No Claude model reformats it. A Codex turn that ends without an accepted result is asked once to submit it; if it still has none, the agent ends with an error. With `@codex review` and a schema together, Codex performs the review in a normal turn with the result tool, since the dedicated review RPC cannot submit through that tool.

There are **no Claude model calls inside a Codex agent**, including auto-mode messages, end-of-turn delivery and workflow output. The main Claude agent still makes its own normal requests. Engine debug logs may show a request being constructed for `subcodex-local`; the local protocol log records that it was answered without a network call.

## Permissions

- **Sandbox**: as configured for Codex (`sandbox_mode`, network access). On Windows, where the Codex config sets neither `features.prefer_mxc` nor `windows.sandbox`, at its top or in its active profile, Codex prefers its MXC sandbox (`features.prefer_mxc=true`, with `suppress_unstable_features_warning=true`); on a device without MXC, Codex chooses its sandbox as it does by itself.
- **When Codex asks**: per `approval_policy` in the Codex config, at its top or in its active profile; if unset, when it needs more than the sandbox allows.
- **Who approves**: Codex's own automatic reviewer (`auto_review`, "Approve for me" in the Codex app). When it refuses, Codex takes a safer route or ends its turn asking for approval; once the caller explicitly approves, Codex goes on. Each decision is a line in the transcript.
- **Plan mode**: the sandbox is read-only, and every request for more is refused.
- Claude's Bash allow and deny rules do not apply to Codex's commands; Codex's reviewer and `~/.codex/rules` do.

## Capabilities given to Codex

- **Skills**: Claude's skill folders: the person's, the project's, those of plugins installed for the person or for this project that the settings (`enabledPlugins`) do not turn off, and those of plugin folders named in `CLAUDE_CODE_PLUGIN_DIRS`.
- **Tools**: the MCP servers, connectors and other plugins' tools connected to the Claude session when the agent's thread starts, as deferred tools in one namespace per connection (`claude_<connection>`), which Codex's own tool search finds and loads. Claude's built-in tools, the desktop app's own controls (`mcp__ccd_*`) and this mod's tools are not offered. Calls run on Claude's side as Codex asks, without approval; deny rules and organization policy still apply. In plan mode a call runs only where Claude Code's own check allows it there (a read). No input schemas are available, so Codex infers arguments from each tool's description. Results are text, cut at 30,000 characters, and the images a tool returns.
- **Messages**: `message_parent`, to message the caller while Codex works.
- **Project instructions**: the instruction files Claude Code loaded for the session (`CLAUDE.md`, `CLAUDE.local.md`, rules and their imports, the auto memory index `MEMORY.md`), as additional instructions.
- **Working directory**: the agent's own; its worktree when isolated in one.

## Data, login and usage

- **Session data**: kept in `~/.claude/subcodex/codex-home/`, apart from `~/.codex`. Full sessions are kept there so that follow-ups resume the same thread; they do not appear in the session lists or archives of Codex or the ChatGPT desktop app.
- **Agent records**: one small file per agent in `~/.claude/subcodex/agents/`, naming the Codex thread it goes on in, its model and effort, and messages Codex has not yet taken in. A later message resumes from it after a reload or in a resumed session. `/subcodex clean` removes the records whose session is gone.
- **Usage**: rows the mod writes into transcripts are stamped `<synthetic>` with zero usage and are not counted as Claude usage; Codex usage counts against your Codex account. As each Codex turn starts, and when a server stops, the session files that have no link yet are symlinked into `~/.codex/sessions/<year>/<month>/<day>/` (named with `.subcodex`), where usage tools such as codeburn count them. Only the mod's day folders changed since the last such pass are looked at (`~/.claude/subcodex/usage-links.json` holds when it began); there, links of the mod's that lead to no file are removed, and `/subcodex clean` removes them everywhere and has the next pass look at every day folder.
- **Configuration used**: default model and effort, sandbox and network access, approval policy, feature flags, personality, `rules`, `hooks.json`, and on Windows the sandbox that `codex sandbox setup` set up. `~/.codex/config.toml` is copied at each start, without the parts that add context.
- **Not used**: the global `AGENTS.md`, Codex's own skills and plugins, MCP servers from the config, memories, sub-agent roles and global instructions; memories and chronicle are disabled and the notify program is not run. A project's own `AGENTS.md` and project skills still apply.
- **Login**: the access token in `~/.codex/auth.json` is read at each server start and passed to the server in memory, through a pipe only you can read (`~/.claude/subcodex/run/`; on Windows a named pipe, `\\.\pipe\subcodex-<name>`, that only you can open). If the token has expired, open Codex once.
- **Context**: Codex manages and compacts its own context. When the context Claude Code keeps for the agent fills, the mod compacts it without a model (keeping the task and the latest rows), and the transcript shows "Conversation compacted"; the saved transcript is unaffected. Command output in transcript rows keeps the first 2,000 and last 6,000 characters.

## `/subcodex`

| Command | Effect |
|---|---|
| `/subcodex` | Shows the Codex binary and version, default model and effort, the links the session could not make, login, the usage limits last reported, and what is kept: session files, links, records, and Codex's own databases |
| `/subcodex clean <days>` | Removes session files older than the given number of days, with their links and records; Codex's own databases stay (Codex prunes its logs itself). Links the other session files are missing are made as the next Codex agent starts |
| `/subcodex clean all` | Removes every link and all of `~/.claude/subcodex/`; use before uninstalling |

Sessions are never removed automatically. Cleaning touches only the mod's own files, and `clean all` does nothing while a Codex agent is running. If the mod was uninstalled without cleaning:

```bash
find ~/.codex/sessions -type l -name '*.subcodex.jsonl*' -delete
rm -rf ~/.claude/subcodex
```

On Windows, in PowerShell 7 (`Directory.Delete` removes the links in the folder without following them):

```powershell
Get-ChildItem "$HOME\.codex\sessions" -Recurse -Filter '*.subcodex.jsonl*' -Attributes ReparsePoint | Remove-Item
[IO.Directory]::Delete("$HOME\.claude\subcodex", $true)
```

## Differences from native subagents

| Feature | Status |
|---|---|
| The Agent tool's `model` parameter | Not supported; use the prompt's first line |
| Thinking | Shown live, not kept in the transcript |
| Live command output | The latest lines, under the running row; the whole output when the command ends |
| Image input | As for native subagents: the task is text; Codex opens image files by path itself |
| The desktop app's Model field | Cannot show Codex models; the model and effort are in the task title |
| User hooks on commands | Not applicable: commands run in Codex's sandbox, and transcript rows mirror them |
| Code review mode, Codex usage accounting | Not available for native subagents |

## Known limitations

- If the mod is reloaded during a turn, the turn starts over in the same thread.
- A tool connected to the session after an agent's thread started is not offered to that agent.
- The tasks Codex passes to its own sub-agents are encrypted; the transcript shows only each sub-agent's name and what it did.
- Usage links rely on usage tools reading `rollout-*.jsonl` under `sessions/<year>/<month>/<day>/`, and on Codex skipping symbolic links when it lists sessions.
- Codex still reads `~/.agents/skills`.
- Tested on macOS and on Windows 11.

## Development

| File | Content |
|---|---|
| `hooks/register.ts` | Hook entry point |
| `hooks/steps.ts` | Writes Codex's events as steps of the agent |
| `hooks/turn.ts` | A Codex turn: open or resume the thread, a turn or a review, read events, answer server requests |
| `hooks/app-server.ts` | Start app-server, send and receive, log in, stop |
| `hooks/usage-links.ts` | Usage links: the session files linked into `~/.codex`; the links a session could not make |
| `hooks/events.ts` | Maps app-server notifications to events |
| `hooks/agents.ts` | Agent state, settings and persistence |
| `hooks/model-mock.ts` | Intercepts model requests and supplies local mock responses |
| `hooks/usage.ts` | Codex usage-limit formatting |
| `hooks/compact.ts` | Context compaction without a model |
| `hooks/bridge.ts` | The tools given to Codex |
| `hooks/codex-home.ts` | Finding Codex, login, the config copy and the sandbox options on Windows, skill folders, Claude's instruction files |
| `hooks/upkeep.ts` | The `/subcodex` command |
| `hooks/edits.ts` | Codex's edits as Edit and Write rows |
| `hooks/live.tsx` | Running commands' output under their rows |
| `hooks/config.ts` | Shared names, paths and limits |
| `hooks/types.ts` | Shared types |
| `hooks/log.ts` | Debug log lines (`claude --debug`) |
| `hooks/host.ts` | The host system: which one, and each host operation's command on it |
| `hooks/posix.ts` | The host operations on macOS and Linux: `/bin/sh` scripts and commands |
| `hooks/windows.ts` | The host operations on Windows: PowerShell 7 scripts |
| `types/index.d.ts` | The values the mod keeps in the session's state |

The mod registers two tools, both written only by the mod as rows of an agent's transcript: `mcp__subcodex__checkpoint` (separates local protocol steps) and `mcp__subcodex__claude_tool` (Codex using a session tool, sending a message or submitting a workflow result).

Validate, which also type-checks the code and tests against the Mod API types of the `claude` on `PATH` (`--strict` fails on any warning):

```bash
claude plugin validate --strict .
```

### Tests

Unit tests (`tests/unit/`, no usage):

```bash
claude plugin test .
```

End-to-end tests (`tests/e2e/`, no usage): each case starts a headless session (`claude -p`) with the mod loaded from this checkout, dispatches `subcodex:codex`, and checks the agent's transcript, the debug log, Codex's session files and the results on disk. Codex runs for real (`codex app-server`, with its sandbox); only the two model APIs are scripted, by local stand-ins (`tests/e2e/mocks.py`) that answer each request from the case's script. Each case has a folder and a home of its own (`HOME`, `CLAUDE_CONFIG_DIR`) in a temporary run folder: no request leaves the machine, and nothing of your own Claude Code or Codex is read or written. A run that passes removes its folder. Where `SUBCODEX_TESTS_CODEX_SANDBOX` names a Codex home in which `codex sandbox setup --elevated` has run (Windows without MXC; CI sets it), each case's Codex uses that sandbox.

```bash
python3 tests/e2e/run.py            # all cases
python3 tests/e2e/run.py leave      # cases whose name contains the word
python3 tests/e2e/run.py --keep     # every check shown, run folder kept
```

The tests need `claude` and `codex` on `PATH`, and a shell that may reach local ports. On Windows, run them with `python` in place of `python3`, with PowerShell 7 and Developer Mode as for the mod; Codex's commands in the cases are written for PowerShell there. A case's home there is also its `USERPROFILE`; its `LOCALAPPDATA` is yours, and the cache Claude Code writes in it for each case folder (`claude-cli-nodejs\Cache`) is removed when the run ends. Codex takes the home folder from Windows itself: it may read your `~/.agents/skills`, and its MXC sandbox setup keeps empty marker files (`.codex-provisioning-*.guard`) in your `~/.codex`.

Live cases (`cases/live.py`) run only when asked for. They run real Codex, on your own ChatGPT login, against your Codex usage limits; the main session stays scripted, so they use no Claude usage. Each case links your `~/.codex/auth.json` into its home (the file alone, never copied), runs `gpt-6-luna` at low effort, and prints the tokens Codex used. They check outcomes, since the model is not scripted: a fix on disk, a deferred session tool found and called, a decision of Codex's reviewer. Without a ChatGPT login they are skipped. Their Codex sessions stay in the run folder, so codeburn does not count them.

```bash
python3 tests/e2e/run.py --live     # the live cases only
```

| File | Content |
|---|---|
| `mocks.py` | The scripted model APIs, and helpers that write Codex's and the main session's steps |
| `harness.py` | A case's folder and home, a session run against the mocks, and what is read back from it |
| `host.py` | The host system: the processes running, waiting for one, and stopping a session, on Windows or elsewhere |
| `cases/engine.py` | Verbatim results, local hand-backs, follow-ups, Codex's own sub-agents, long runs, workflows, background agents |
| `cases/codex.py` | A fix, a review, action lines, context given to Codex, web search |
| `cases/leave.py` | Requests outside the sandbox: Codex's reviewer, refusal in plan mode |
| `cases/messages.py` | Messages between Codex and its caller, each way |
| `cases/lifecycle.py` | Resume, stop, kill, continue after either, worktree, parallel agents, parallel agents in a workflow |
| `cases/bridge.py` | Codex calling session tools (the test tools of the `tests/e2e/fixture/` plugin): a result, a picture, a deny rule, plan mode |
| `cases/upkeep.py` | `/subcodex` and its cleaning, pipes of servers no longer running, usage links and links that cannot be made, agent records |
| `cases/live.py` | Real Codex, with `--live` only: a fix, tool search for a session tool, Codex's reviewer |

### Following new releases

- `.github/versions.json` holds the Claude Code and Codex versions the code is tested against. `.github/actions/install` installs them with each CLI's own installer (`claude.ai/install.sh` or `install.ps1`, and `chatgpt.com/codex/install.sh` or `install.ps1`). The `CI` workflow runs, with them, strict validation (which type-checks the mod against the Mod API types of the installed Claude Code), the unit tests and the offline end-to-end tests on macOS and Windows, for each push to `main`, each pull request and each run started by hand or through the API (`workflow_dispatch`). On Windows, where the runner has no MXC, it first sets up Codex's own sandbox (`codex sandbox setup --elevated`) for the cases. When the end-to-end tests fail, it uploads their run folder as the artifact `e2e-macOS` or `e2e-Windows`.
- A Claude Code cloud scheduled task (claude.ai/code/routines) runs each day on Opus. When npm has a Claude Code or Codex newer than the versions in `main`'s `.github/versions.json`, it works on the branch `upstream`: it sets the new versions there and writes what the versions on `main` and the new ones each give the mod, the Mod API skill and Codex's app-server protocol (`python3 tests/upstream.py DIR`), and the diff between them. It fixes what fails and uses what the new versions make possible.
- `.github/upstream-checks.md` lists what each run checks first. When the new versions allow an item, the run does it and removes it from the list.
- After each push to the branch it runs CI there (`gh workflow run ci.yml --ref upstream`) and reads the result. When the branch changes the mod's code, it raises the version in `.claude-plugin/plugin.json`; otherwise the version stays. When CI passes on the branch's latest commit, it pushes the branch to `main` as a fast-forward and runs CI on `main`.
- It stops once CI has failed 5 times on the branch's commits that `main` lacks, failures in the install step aside, and opens an issue saying so. Fix the branch, or reset it to `main`, and the next run goes on.
