import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, RasterProps, Register } from 'claude-code'

import type { CrewOctopus, Octopus } from '../types'

const octopuses = atom({ plugin: 'octopus-crew', key: 'octopuses' } as const, [])
const crewOctopuses = atom({ plugin: 'octopus-crew', key: 'crewOctopuses' } as const, [])
const isHidden = atom({ plugin: 'octopus-crew', key: 'isHidden' } as const, false)

/** One colour per octopus, in the order they first appear. */
/** Claude's own orange, Clawd's body colour: kept for the session's current model alone. */
const CLAUDE_ORANGE = '#d77757'
const PALETTE = ['#e255d0', '#35c9d8', '#3b82f6', '#7ed957', '#ff6b6b', '#8f7bff', '#f2e94e', '#ff9ecb']
const CREW_PALETTES = {
  working: ['#00a6a6', '#008f83', '#007f9e', '#2563eb', '#0e7490', '#a21caf', '#059669', '#0f766e', '#0891b2', '#0284c7', '#0d9488', '#16a34a', '#4f46e5', '#7c3aed', '#9333ea', '#c026d3'],
  waiting: ['#b77900', '#a16207', '#c2410c', '#9a6700', '#d97706', '#b45309', '#854d0e', '#ca8a04'],
  done: ['#15803d', '#16803c', '#047857', '#2f855a', '#166534', '#0f766e', '#3f7d20', '#4d7c0f'],
  gone: ['#6b7280', '#737373', '#64748b', '#71717a', '#78716c', '#475569', '#52525b', '#57534e'],
} as const
const CREW_STATE_COLORS: Record<FleetStatus, readonly string[]> = CREW_PALETTES

const ART = [' ,---. ', '( o o )', ' \\_-_/ ', '/|/|\\|\\']
const MAX = 8
const FLEET_REFRESH_MS = 5000

// The creature is Claude Code's own mascot, Clawd, copied from the pixel grid the CLI draws
// (an 8px-cell SVG): a body, two arms, two eyes and four legs. B body, A arm or leg, E eye.
const SPRITE_WIDTH = 11
const SPRITE_HEIGHT = 8
const sprite = (): string[] => {
  const rows: string[] = []
  for (let y = 0; y < SPRITE_HEIGHT; y++) {
    const row = Array.from({ length: SPRITE_WIDTH }, () => '.')
    const fill = (from: number, to: number, ch: string) => {
      for (let x = from; x <= to; x++) row[x] = ch
    }
    if (y <= 5) fill(2, 8, 'B')
    if (y === 4 || y === 5) {
      fill(0, 1, 'A')
      fill(9, 10, 'A')
    }
    if (y === 2 || y === 3) {
      row[3] = 'E'
      row[7] = 'E'
    }
    if (y >= 6) for (const x of [2, 4, 6, 8]) row[x] = 'A'
    rows.push(row.join(''))
  }
  return rows
}
const SPRITE = sprite()

const DEFAULT = 0x01000000
const EYE = 0x141414

const rgb = (hex: string): number => parseInt(hex.slice(1), 16)
const darker = (value: number, by: number): number => {
  const part = (shift: number) => Math.round(((value >> shift) & 255) * by)
  return (part(16) << 16) | (part(8) << 8) | part(0)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64 = (bytes: number[]): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

/** The sprite in half blocks, one terminal row per two pixel rows, as a Raster's packed cells. */
const cellsFor = (hex: string): string => {
  const body = rgb(hex)
  const paint = (ch: string | undefined): number | undefined =>
    ch === 'B' ? body : ch === 'A' ? darker(body, 0.72) : ch === 'E' ? EYE : undefined
  const bytes: number[] = []
  const word = (n: number) => bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255)
  for (let r = 0; r < SPRITE_HEIGHT / 2; r++) {
    for (let x = 0; x < SPRITE_WIDTH; x++) {
      const top = paint(SPRITE[r * 2]?.[x])
      const bottom = paint(SPRITE[r * 2 + 1]?.[x])
      if (top === undefined && bottom === undefined) word(0x20), word(DEFAULT), word(DEFAULT)
      else if (bottom === undefined) word(0x2580), word(top ?? DEFAULT), word(DEFAULT)
      else if (top === undefined) word(0x2584), word(bottom), word(DEFAULT)
      else word(0x2580), word(top), word(bottom)
    }
  }
  return base64(bytes)
}

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** Adds or retunes one octopus; a colour once given stays. */
const upsert = (list: Octopus[], next: Omit<Octopus, 'color'>, fixed?: string): Octopus[] => {
  const at = list.findIndex(o => o.id === next.id)
  if (at >= 0) return list.map((o, i) => (i === at ? { ...o, ...next, color: fixed ?? o.color } : o))
  const used = new Set(list.map(o => o.color))
  const color = fixed ?? PALETTE.find(c => !used.has(c)) ?? PALETTE[list.length % PALETTE.length] ?? '#ffffff'
  return [...list, { ...next, color }].slice(-MAX)
}

const HEAD = ['main', 'advisor', 'subagent-default']

type FleetStatus = CrewOctopus['state']

/** Status files are append-only; ignore wake/event lines and use the latest state record. */
export const parseCrewStatus = (text: string): { state: FleetStatus; finished: boolean } => {
  const recognized = text.split(/\r?\n/).map(line => /^(working|waiting|blocked|needs-decision|done|failed|cancelled|endpoint-gone|endpoint gone):/i.exec(line.trim())?.[1]?.toLowerCase()).filter((s): s is string => Boolean(s))
  const last = recognized.at(-1) ?? 'working'
  if (last === 'done') return { state: 'done', finished: true }
  if (last === 'failed' || last === 'cancelled') return { state: 'gone', finished: true }
  if (last === 'endpoint-gone' || last === 'endpoint gone') return { state: 'gone', finished: true }
  if (last === 'blocked' || last === 'waiting' || last === 'needs-decision') return { state: 'waiting', finished: false }
  return { state: 'working', finished: false }
}

const parseMeta = (text: string): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const cut = line.indexOf('=')
    if (cut > 0) values[line.slice(0, cut).trim()] = line.slice(cut + 1).trim()
  }
  return values
}

export const isCrewDimmed = (octopus: CrewOctopus): boolean => octopus.finished

export const parseFleetFiles = (files: Readonly<Record<string, string>>): CrewOctopus[] => {
  const used: Record<FleetStatus, Set<string>> = { working: new Set(), waiting: new Set(), done: new Set(), gone: new Set() }
  return Object.entries(files)
    .filter(([name]) => name.endsWith('.meta'))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, metaText]) => {
      const taskId = name.slice(0, -'.meta'.length)
      const kind = parseMeta(metaText).kind
      if (kind !== 'ship' && kind !== 'scout' && kind !== 'secondmate') return []
      const status = parseCrewStatus(files[`${taskId}.status`] ?? '')
      const role = kind === 'secondmate' ? `secondmate · ${taskId}` : taskId
      return [{ id: `crew:${taskId}`, role, model: status.state, color: crewColor(status.state, taskId, used[status.state]), state: status.state, finished: status.finished }]
    })
}

const crewColor = (state: FleetStatus, taskId: string, used: Set<string>): string => {
  const colors = CREW_STATE_COLORS[state]
  let hash = 0
  for (const char of taskId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const start = hash % colors.length
  const color = colors.map((_, offset) => colors[(start + offset) % colors.length]).find(candidate => candidate !== undefined && !used.has(candidate)) ?? colors[start] ?? '#ffffff'
  used.add(color)
  return color
}

const loadCrew = async ($: EngineInterface, home: string): Promise<CrewOctopus[]> => {
  try {
    const entries = await $.fs.list(`${home.replace(/\/$/, '')}/state`)
    const metas = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.meta'))
    const files: Record<string, string> = {}
    for (const entry of metas) {
      try {
        files[entry.name] = await $.fs.read(`${home.replace(/\/$/, '')}/state/${entry.name}`)
        const statusName = `${entry.name.slice(0, -'.meta'.length)}.status`
        files[statusName] = await $.fs.read(`${home.replace(/\/$/, '')}/state/${statusName}`).catch(() => '')
      } catch {
        // A task may disappear while being read; the next poll will reconcile it.
      }
    }
    return parseFleetFiles(files)
  } catch {
    // An unset, missing, or inaccessible fleet folder is deliberately silent.
    return []
  }
}

export const register: Register = (on, options: PluginOptions) => {
  let stopFleetPolling: ReturnType<EngineInterface['clock']['every']> | undefined

  // A reload runs session.start again: read the models afresh and show the band again.
  on('session.start', async ($, e, next) => {
    stopFleetPolling?.cancel()
    stopFleetPolling = undefined
    const settings = await $.settings.read()
    const settingsEnv = (settings.env ?? {}) as Record<string, unknown>
    const advisor = asText(settings.advisorModel)
    const subagents =
      (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ?? asText(settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL)
    const main = await $.session.model()

    await update($, octopuses, list => {
      // The three fixed octopuses lead, in order; spawned ones follow, colours kept.
      const spawned = list.filter(o => !HEAD.includes(o.id))
      const fresh = upsert(upsert(upsert(spawned, { id: 'main', role: 'current', model: main }, CLAUDE_ORANGE), { id: 'advisor', role: 'advisor', model: advisor ?? 'not set' }), {
        id: 'subagent-default',
        role: 'subagents',
        model: subagents ?? `${main} (inherits)`,
      })
      return [...HEAD.map(id => fresh.find(o => o.id === id)).filter((o): o is Octopus => o !== undefined), ...fresh.filter(o => !HEAD.includes(o.id))]
    })
    await update($, isHidden, () => false)

    const home = asText(options.firstmateHome)
    if (home) {
      await update($, crewOctopuses, () => [])
      const initialCrew = await loadCrew($, home)
      await update($, crewOctopuses, () => initialCrew)
      stopFleetPolling = $.clock.every(FLEET_REFRESH_MS, async () => {
        const refreshed = await loadCrew($, home)
        await update($, crewOctopuses, () => refreshed)
      })
    } else {
      await update($, crewOctopuses, () => [])
    }

    return next(e)
  })

  // Each Claude subagent gets its own octopus, keyed by the runtime's agent id.
  on('agent.spawn', async ($, e, next) => {
    const settings = await $.settings.read()
    const settingsEnv = (settings.env ?? {}) as Record<string, unknown>
    const model =
      asText(e.model) ??
      (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ??
      asText(settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL) ??
      (await $.session.model())
    const role = asText(e.subagentType) ?? 'subagent'
    const result = await next(e)
    if (result.agentId) {
      await update($, octopuses, list => upsert(list, { id: `spawn:${result.agentId}`, role, model: asText(result.model) ?? model }))
      await update($, isHidden, () => false)
    }
    return result
  })

  // turn.complete is the documented end of an agent loop; remove its live octopus.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) await update($, octopuses, list => list.filter(o => o.id !== `spawn:${e.agentId}`))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, octopuses)
    const crew = await read($, crewOctopuses)
    const hidden = await read($, isHidden)
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Raster = e.surface === 'terminal' ? (ui as { Raster?: (props: RasterProps) => JSX.Element }).Raster : undefined
    const displayed: Array<Octopus | CrewOctopus> = [...list, ...crew]
    const toggle = () => update($, isHidden, value => !value)

    if (hidden) {
      return <Button key="show-octopuses" label="Show octopuses" onPress={toggle} />
    }

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap">
          {displayed.map(o => (
            <Box flexDirection="column" key={`o:${o.id}`} marginRight={3}>
              {Raster ? (
                <Raster key={`r:${o.id}`} columns={SPRITE_WIDTH} rows={SPRITE_HEIGHT / 2} cells={cellsFor(o.color)} />
              ) : (
                ART.map((line, i) => (
                  <Text color={o.color} key={`l:${i}`}>
                    {line}
                  </Text>
                ))
              )}
              <Text bold color={o.color} dimColor={'finished' in o && isCrewDimmed(o)}>
                {o.role}
              </Text>
              <Text dimColor={'finished' in o && isCrewDimmed(o)}>{'state' in o ? o.state : o.model}</Text>
            </Box>
          ))}
        </Box>
        <Button key="hide" label="Hide octopuses" dimColor onPress={toggle} />
      </Box>
    )
  })
}
