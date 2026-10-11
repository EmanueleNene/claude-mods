export type Octopus = {
  /** Stable key: "advisor", "subagent-default", or "spawn:<type>:<model>". */
  id: string
  /** Who it stands for: "advisor", "subagents" or a subagent type. */
  role: string
  /** The model it runs, as configured or as the spawn named it. */
  model: string
  /** Its colour, fixed when it first appears. */
  color: string
}

declare module 'claude-code' {
  interface PluginState {
    'octopus-crew': { octopuses: Octopus[]; isHidden: boolean }
  }
}
