export type DeleteItem = {
  /** The target as written in the command (a path, or the whole command when it cannot be split). */
  label: string
  /** True when the person toggled it to be kept (refused). */
  isKept: boolean
}

export type DeleteRequest = {
  id: string
  command: string
  cwd: string
  /** True when the command is a plain `rm`-style call whose targets can be dropped one by one. */
  isSplittable: boolean
  items: DeleteItem[]
  status: 'pending' | 'approved' | 'refused'
  /** Set once the retried command has used the decision. */
  isUsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'delete-guard': {
      requests: DeleteRequest[]
      /** True while the clean-generated-artifacts skill's turn runs. */
      armed: boolean
    }
  }
}
