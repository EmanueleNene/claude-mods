import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Octopus } from '../types'

const octopuses = atom({ plugin: 'octopus-crew', key: 'octopuses' } as const, [])
const isHidden = atom({ plugin: 'octopus-crew', key: 'isHidden' } as const, false)

/** One colour per octopus, in the order they first appear. */
/** Claude's own orange, Clawd's body colour: kept for the session's current model alone. */
const CLAUDE_ORANGE = '#d77757'
const PALETTE = ['#e255d0', '#35c9d8', '#3b82f6', '#7ed957', '#ff6b6b', '#8f7bff', '#f2e94e', '#ff9ecb']

const ART = [' ,---. ', '( o o )', ' \\_-_/ ', '/|/|\\|\\']
const MAX = 8

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

export const register: Register = on => {
  // A reload runs session.start again: read the models afresh and show the band again.
  on('session.start', async ($, e, next) => {
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

    return next(e)
  })

  // Every subagent the session spawns gets an octopus of its own, once per type and model.
  on('agent.spawn', async ($, e, next) => {
    const settings = await $.settings.read()
    const settingsEnv = (settings.env ?? {}) as Record<string, unknown>
    const model =
      asText(e.model) ??
      (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ??
      asText(settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL) ??
      (await $.session.model())
    const role = asText(e.subagentType) ?? 'subagent'
    await update($, octopuses, list => upsert(list, { id: `spawn:${role}:${model}`, role, model }))
    await update($, isHidden, () => false)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, octopuses)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Raster = e.surface === 'terminal' ? (ui as { Raster?: typeof ui.Box }).Raster : undefined

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap">
          {list.map(o => (
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
              <Text bold color={o.color}>
                {o.role}
              </Text>
              <Text dimColor>{o.model}</Text>
            </Box>
          ))}
        </Box>
        <Button key="hide" label="Hide octopuses" dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
