# Upstream checks

Each run of the scheduled task that follows new Claude Code and Codex versions checks these first. When the new versions allow one, the run does it fully and removes it from this list in the commit that does it. Add an item for anything each update should look for.

- **Model choice.** The Agent tool's `model` parameter takes Claude models only, so a Codex model is chosen on the prompt's first line (`@codex model=<id>`). Wanted: a native way to choose it.
