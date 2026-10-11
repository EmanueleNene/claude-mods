# claude-mods

Two small mods for Claude Code.

| Mod | What it does |
| --- | --- |
| `delete-guard` | Holds any delete command (`rm`, `rmdir`, `unlink`, `shred`, `trash`, `git rm`, `git clean`, `find -delete`) and opens a pane listing every file. Toggle each file between delete and keep, then Confirm or Refuse all. Files marked keep are dropped from the command when it is retried. Open the pane by hand with `/delete-guard`. |
| `octopus-crew` | Draws Clawd, Claude Code's pixel mascot, above the prompt for the current model (Claude orange), the advisor model and the subagent model, plus one for each subagent type that gets spawned. Each one has its own colour. |

## Install

At a Claude Code prompt in a terminal:

```
/plugin install delete-guard --marketplace EmanueleNene/claude-mods
/plugin install octopus-crew --marketplace EmanueleNene/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads in every session).

## Notes

- `delete-guard` cannot wait open for a click, so the first delete attempt is held and Claude is told your decision afterwards, then re-runs the command. It only sees deletions run through the shell tool.
- `octopus-crew` reads the models when it loads, so a later `/model` or `/advisor` change shows after the next reload.

## Develop

```
claude plugin validate delete-guard
claude plugin test delete-guard
claude --plugin-dir ./octopus-crew
```
