# claude-mods

Two small mods for Claude Code.

| Mod | What it does |
| --- | --- |
| `delete-guard` | Holds any delete command (`rm`, `rmdir`, `unlink`, `shred`, `trash`, `git rm`, `git clean`, `find -delete`) and opens a pane listing every file. Toggle each file between delete and keep, then Confirm or Refuse all. Files marked keep are dropped from the command when it is retried. Open the pane by hand with `/delete-guard`. |
| `octopus-crew` | Draws Clawd, Claude Code's pixel mascot, above the prompt for the current model (Claude orange), advisor and subagent models, each live Claude Code subagent, and optionally each firstmate ship, scout, or secondmate. Firstmate octopuses show the task id and state colour. |

## Install

At a Claude Code prompt in a terminal:

```
/plugin install delete-guard --marketplace EmanueleNene/claude-mods
/plugin install octopus-crew --marketplace EmanueleNene/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads in every session).

## Notes

- `delete-guard` cannot wait open for a click, so the first delete attempt is held and Claude is told your decision afterwards, then re-runs the command. It only sees deletions run through the shell tool.
- `octopus-crew` reads the models when it loads, so a later `/model` or `/advisor` change shows after the next reload. Its `firstmateHome` plugin option is unset by default; set it to the captain's firstmate home (`/home/emanuele/firstmate`) to show crew. Leave it unset to disable crew octopuses.
- Crew state is read-only: the mod polls `<firstmateHome>/state` about every five seconds, reads `.meta` and `.status` files, and never changes or steers fleet tasks. It shows `kind=ship`, `kind=scout`, and `kind=secondmate` workers (including Pi-harness workers dispatched by firstmate); secondmates are labelled `secondmate · <task-id>`. `working`, decision-waiting, done and endpoint-gone states use distinct hues; completed tasks stay dimmed until their `.meta` file disappears. Nothing from the fleet is added to model-facing context.
- Claude Code subagents started in the session are shown individually from `agent.spawn` until their `turn.complete`. A Pi subagent that is not launched as a firstmate state-directory worker is not observable from this Claude Code mod; the mod does not invent a signal for it.
- Click **Hide octopuses** in the band to collapse it to a **Show octopuses (n)** button, where n counts the octopuses waiting. It stays hidden through new subagents and reloads until you press Show. Without a mouse, focus the band with ctrl+x tab and press Enter.

## Develop

```
claude plugin validate delete-guard
claude plugin test delete-guard
claude --plugin-dir ./octopus-crew
```
