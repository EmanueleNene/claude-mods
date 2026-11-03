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

const ART = [' ^   ^ ', '( o.o )', ' (___) ']
const MAX = 8
const FLEET_REFRESH_MS = 5000

// Six original pixel creatures, 10x6, facing right: a cinder puff, a fin newt, a leaf cyclops,
// a spark moth, a pebble bat and a lantern wisp. B body, A shadow, L highlight (all three from
// the agent's colour), E eye, W white, F flame, Y yellow, V leaf, R cheek, S cream.
export const CREATURES: readonly (readonly string[])[] = [
  ['....F.....', '...FYF.F..', '.LBFYYFBB.', 'BBEBBBBEBB', 'BRBBAABBRA', '.AA....AA.'],
  ['........W.', '..L.L.L...', '..BBBBBBB.', 'B.BBBBBBEB', '.BBSSSSSBA', '..A.A.A.A.'],
  ['..VV..VV..', '...VAAV...', '..BBBBBB..', '.BBWEEWBB.', '.BBBAABBB.', '..AA..AA..'],
  ['..Y....Y..', '...YBBY...', 'LLLEBBELLL', 'LYLBSSBLYL', '.LLBBBBLL.', '....AA....'],
  ['..A....A..', '..BBBBBB..', 'L.BEBBEB.L', 'LLBWBBWBLL', '.LLBBABLL.', '...A..A...'],
  ['..BBBB....', '.BBBBBB...', '.BEBBEB.A.', '.BBBBBBBF.', '..LBBBB.Y.', '....LLB...'],
]
const SPRITE_WIDTH = 10
const SPRITE_HEIGHT = 6
const SPRITE_ROWS = SPRITE_HEIGHT / 2
/** A creature and its two label rows: the room each walker keeps to itself. */
const SLOT = 18
const STRIP_ROWS = SPRITE_ROWS + 2
const WALK_MS = 150

const DEFAULT = 0x01000000
const FIXED: Record<string, number> = { E: 0x141414, W: 0xf5f5f5, F: 0xff7b1c, Y: 0xffd23f, V: 0x5fbf3a, R: 0xff8fa3, S: 0xf2e6c8 }

const rgb = (hex: string): number => parseInt(hex.slice(1), 16)
/** Moves a colour `by` of the way towards `toward`. */
const mix = (value: number, toward: number, by: number): number => {
  const part = (shift: number) => {
    const from = (value >> shift) & 255
    return Math.round(from + (((toward >> shift) & 255) - from) * by)
  }
  return (part(16) << 16) | (part(8) << 8) | part(0)
}
const colourOf = (ch: string | undefined, body: number): number | undefined => {
  if (ch === 'B') return body
  if (ch === 'A') return mix(body, 0, 0.35)
  if (ch === 'L') return mix(body, 0xffffff, 0.4)
  return ch === undefined ? undefined : FIXED[ch]
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

const hashOf = (key: string): number => {
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

/** Starts at the key's hash and takes the first entry not yet used, so a key keeps its pick. */
const pick = <T,>(list: readonly T[], key: string, used: Set<T>): T => {
  const start = hashOf(key) % list.length
  const chosen = list.map((_, offset) => list[(start + offset) % list.length]).find((c): c is T => c !== undefined && !used.has(c)) ?? (list[start] as T)
  used.add(chosen)
  return chosen
}

/** One creature on the band: what it draws, and where it is walking. */
export type Walker = { id: string; sprite: readonly string[]; color: string; label: string; detail: string; dim: boolean; x: number; dir: 1 | -1; pace: number }

/** One walking tick: a walker due to move steps a column, or turns round where a neighbour's slot or the edge stops it. */
export const step = (walkers: readonly Walker[], columns: number, tick: number): Walker[] => {
  const next = walkers.map(w => ({ ...w }))
  next.forEach((w, i) => {
    if (tick % w.pace !== 0) return
    const lo = (next[i - 1]?.x ?? -SLOT) + SLOT
    const hi = (next[i + 1]?.x ?? columns) - SLOT
    const fits = (x: number) => x >= lo && x <= hi
    if (fits(w.x + w.dir)) w.x += w.dir
    else if (fits(w.x - w.dir)) w.dir = w.dir === 1 ? -1 : 1
  })
  return next
}

/** Spaces a strip's walkers evenly, alternately facing each way. */
const spread = (walkers: readonly Walker[], columns: number): Walker[] =>
  walkers.map((w, i) => ({ ...w, x: Math.max(0, Math.floor(((i + 0.5) * columns) / walkers.length - SLOT / 2)), dir: i % 2 ? -1 : 1 }))

/** A strip as a Raster's packed cells: each creature in half blocks, its role and model beneath it. */
export const paintStrip = (walkers: readonly Walker[], columns: number, tick: number): string => {
  const words: number[] = []
  for (let i = 0; i < columns * STRIP_ROWS; i++) words.push(0x20, DEFAULT, DEFAULT)
  const put = (x: number, row: number, glyph: number, fg: number, bg: number) => {
    // Cells are row-major: one past the edge would land on the next row.
    if (x < 0 || x >= columns) return
    const at = (row * columns + x) * 3
    words[at] = glyph
    words[at + 1] = fg
    words[at + 2] = bg
  }
  for (const w of walkers) {
    const body = rgb(w.color)
    const rows = w.sprite.map((row, y) => {
      const facing = w.dir === 1 ? row : [...row].reverse().join('')
      // The bottom row shuffles a pixel every other tick: a two-frame walk.
      return y === SPRITE_HEIGHT - 1 && tick % 2 ? facing.slice(-1) + facing.slice(0, -1) : facing
    })
    const left = w.x + (SLOT - SPRITE_WIDTH) / 2
    for (let r = 0; r < SPRITE_ROWS; r++) {
      for (let x = 0; x < SPRITE_WIDTH; x++) {
        const top = colourOf(rows[r * 2]?.[x], body)
        const bottom = colourOf(rows[r * 2 + 1]?.[x], body)
        if (top !== undefined) put(left + x, r, 0x2580, top, bottom ?? DEFAULT)
        else if (bottom !== undefined) put(left + x, r, 0x2584, bottom, DEFAULT)
      }
    }
    const label = (text: string, row: number, fg: number, keepEnd: boolean) => {
      // A Raster cell holds one width-1 character; task ids come from file names.
      let shown = text.replace(/[^\x20-\x7e·]/g, '?')
      if (shown.length > SLOT) shown = keepEnd ? `~${shown.slice(1 - SLOT)}` : `${shown.slice(0, SLOT - 1)}~`
      const start = w.x + Math.floor((SLOT - shown.length) / 2)
      for (let i = 0; i < shown.length; i++) put(start + i, row, shown.charCodeAt(i), fg, DEFAULT)
    }
    // Names differ at the end (task ids, plugin:agent); models at the start.
    label(w.label, SPRITE_ROWS, w.dim ? mix(body, 0, 0.45) : body, true)
    label(w.detail, SPRITE_ROWS + 1, w.dim ? 0x5a5a5a : 0x9ca3af, false)
  }
  const bytes: number[] = []
  for (const n of words) bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255)
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
      return [{ id: `crew:${taskId}`, role, model: status.state, color: pick(CREW_STATE_COLORS[status.state], taskId, used[status.state]), state: status.state, finished: status.finished }]
    })
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
  let stopWalking: ReturnType<EngineInterface['clock']['every']> | undefined
  // The walking band as last drawn; unset while hidden or drawn without a Raster.
  let stage: { requestId: string; columns: number; strips: Walker[][] } | undefined
  let tick = 0

  // A reload runs session.start again: read the models afresh; the hidden choice is kept.
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
    // The band's buttons need a mouse or ctrl+x tab; the command works from any terminal.
    await $.command.register({ name: 'octopuses', description: 'Hide or show the octopuses', immediate: true })

    stopWalking?.cancel()
    stopWalking = $.clock.every(WALK_MS, async () => {
      const shown = stage
      if (!shown) return
      tick++
      for (const [i, strip] of shown.strips.entries()) {
        const moved = step(strip, shown.columns, tick)
        shown.strips[i] = moved
        // A deny (the band redrawn at another size, or gone) is fine: the next render resets the stage.
        await $.ui.blit({ requestId: shown.requestId, key: `strip:${i}`, cells: paintStrip(moved, shown.columns, tick) })
      }
    })

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

  on('command.run', { command: 'octopuses' }, async $ => {
    const hidden = await update($, isHidden, value => !value)
    return { text: hidden ? 'Octopuses hidden. Run /octopuses to show them.' : 'Octopuses shown.' }
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
    if (e.props.hasSurvey) {
      stage = undefined
      return next(e)
    }

    const displayed: Array<Octopus | CrewOctopus> = [...list, ...crew]

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Raster = e.surface === 'terminal' ? (ui as { Raster?: (props: RasterProps) => JSX.Element }).Raster : undefined
    const toggle = () => update($, isHidden, value => !value)

    if (hidden || !Raster) stage = undefined
    if (hidden) {
      return <Button key="show-octopuses" label={`Show octopuses (${displayed.length})`} onPress={toggle} />
    }

    if (Raster) {
      const columns = Math.min(512, Math.max(SLOT, e.props.bodyColumns || 80))
      const used = new Set<readonly string[]>()
      const walkers: Walker[] = displayed.map(o => ({
        id: o.id,
        sprite: pick(CREATURES, o.id, used),
        color: o.color,
        label: o.role,
        detail: 'state' in o ? o.state : o.model,
        dim: 'finished' in o && isCrewDimmed(o),
        x: 0,
        dir: 1,
        pace: 1 + (hashOf(o.id) % 3),
      }))
      // Each strip leaves its walkers about four columns apiece to wander in.
      const perStrip = Math.max(1, Math.floor(columns / (SLOT + 4)))
      const previous = stage?.columns === columns ? stage.strips : []
      const strips = Array.from({ length: Math.ceil(walkers.length / perStrip) }, (_, i) => {
        const members = walkers.slice(i * perStrip, (i + 1) * perStrip)
        const old = previous[i]
        // Same walkers in the same order keep their places; any change spaces the strip out afresh.
        return old && old.map(w => w.id).join('\n') === members.map(w => w.id).join('\n')
          ? members.map((w, j) => ({ ...w, x: old[j]?.x ?? 0, dir: old[j]?.dir ?? 1 }))
          : spread(members, columns)
      })
      stage = { requestId: e.requestId, columns, strips }
      return (
        <Box flexDirection="column">
          {strips.map((strip, i) => (
            <Raster key={`strip:${i}`} columns={columns} rows={STRIP_ROWS} cells={paintStrip(strip, columns, tick)} />
          ))}
          <Button key="hide" label="Hide octopuses" onPress={toggle} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap">
          {displayed.map(o => (
            <Box flexDirection="column" key={`o:${o.id}`} marginRight={3}>
              {ART.map((line, i) => (
                <Text color={o.color} key={`l:${i}`}>
                  {line}
                </Text>
              ))}
              <Text bold color={o.color} dimColor={'finished' in o && isCrewDimmed(o)}>
                {o.role}
              </Text>
              <Text dimColor={'finished' in o && isCrewDimmed(o)}>{'state' in o ? o.state : o.model}</Text>
            </Box>
          ))}
        </Box>
        <Button key="hide" label="Hide octopuses" onPress={toggle} />
      </Box>
    )
  })
}
