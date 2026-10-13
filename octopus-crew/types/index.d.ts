export type Octopus = {
  /** Stable key: "spawn:<agent-id>". */
  id: string
  /** Who it stands for: the subagent type. */
  role: string
  /** The model it runs, as configured or as the spawn named it. */
  model: string
  /** Its colour, fixed when it first appears. */
  color: string
}

export type CrewOctopus = {
  id: string
  /** The firstmate task id. */
  role: string
  /** The current fleet state, shown below the task id. */
  model: string
  color: string
  state: 'working' | 'waiting' | 'done' | 'gone'
  finished: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'octopus-crew': { octopuses: Octopus[]; crewOctopuses: CrewOctopus[]; isHidden: boolean }
  }
}
