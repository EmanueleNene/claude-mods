import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { CREATURES, isCrewDimmed, paintStrip, parseCrewStatus, parseFleetFiles, step } from './register'
import type { Walker } from './register'

const PANE = { plugin: 'octopus-crew', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } } as never
// The desktop surface has no Raster: it draws the static cards, whose labels are Text.
const DESKTOP = { plugin: 'octopus-crew', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as never

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** A Raster's packed cells back to its characters, one string per row. */
const rowsOf = (cells: string, columns: number): string[] => {
  const bytes: number[] = []
  for (let i = 0; i < cells.length; i += 4) {
    const n = [...cells.slice(i, i + 4)].reduce((acc, ch) => acc * 64 + Math.max(0, B64.indexOf(ch)), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  let text = ''
  for (let at = 0; at + 12 <= bytes.length; at += 12) text += String.fromCharCode((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8))
  return Array.from({ length: text.length / columns }, (_, r) => text.slice(r * columns, (r + 1) * columns))
}

const walker = (i: number, x: number): Walker => ({ id: `w${i}`, sprite: CREATURES[i % 6] ?? [], color: '#d77757', label: 'ship', detail: 'working', dim: false, x, dir: i % 2 ? -1 : 1, pace: 1 + (i % 3) })

const engine = (on: On, settings: Record<string, unknown>) => {
  on('settings.read', () => ({ value: settings }))
  on('env.get', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // The engine's own empty band, drawn when the mod hands the band on.
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}))
}


test('a load draws the current model, the advisor and the subagents, in different colours', async ($, on) => {
  engine(on, { advisorModel: 'opus', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)

  const ui = await $.ui.mount(DESKTOP)
  const text = await ui.findAll({ type: 'Text' })
  const shown = text.map(t => t.text).join('\n')
  expect(shown).toContain('current')
  expect(shown).toContain('advisor')
  expect(shown).toContain('opus')
  expect(shown).toContain('subagents')
  expect(shown).toContain('haiku')

  const hues = new Set(text.map(t => String(t.props.color ?? '')).filter(Boolean))
  expect(hues.size).toBe(3)
  expect(hues.has('#d77757')).toBe(true)
})

test('each live spawned subagent gets its own octopus, removed on turn.complete', async ($, on) => {
  engine(on, { advisorModel: 'opus' })
  let nextAgent = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'sonnet', agentId: `agent-${++nextAgent}` }))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore', model: 'haiku' } as never)
  await $.agent.spawn({ prompt: 'y', subagentType: 'Explore', model: 'haiku' } as never)

  const ui = await $.ui.mount(DESKTOP)
  const text = await ui.findAll({ type: 'Text' })
  expect(text.filter(t => t.text === 'Explore')).toHaveLength(2)
  expect(text.filter(t => t.text === 'haiku')).toHaveLength(2)
  const hues = new Set(text.map(t => String(t.props.color ?? '')).filter(Boolean))
  expect(hues.size).toBe(5)

  await $.turn.complete({ agentId: 'agent-1', answer: 'finished' } as never)
  const afterEnd = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(afterEnd.filter(text => text === 'Explore')).toHaveLength(1)
})

test('crew task files map state, dim finished tasks, and use a distinct expanded palette', { options: { firstmateHome: '/fake-firstmate' } }, async ($, on) => {
  engine(on, {})
  mock.clock(on)
  const files: Record<string, string> = {
    '/fake-firstmate/state/build-17.meta': 'kind=ship\nharness=pi\nmodel=sonnet\n',
    '/fake-firstmate/state/review-22.meta': 'kind=scout\nharness=claude\n',
    '/fake-firstmate/state/old-3.meta': 'kind=secondmate\nharness=pi\n',
    '/fake-firstmate/state/other.meta': 'kind=task\nharness=pi\n',
    '/fake-firstmate/state/build-17.status': 'working: implementing\nwake: ping\n',
    '/fake-firstmate/state/review-22.status': 'working: review\nblocked: needs approval\nwake: ping\n',
    '/fake-firstmate/state/old-3.status': 'working: started\ndone: complete\nwake: ping\n',
  }
  // Parsing is exercised against a fake state directory; the live plugin only uses $.fs reads.
  const fakeFolder: Record<string, string> = Object.fromEntries(Object.entries(files).map(([path, content]) => [path.split('/').at(-1)!, content]))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const crew = parseFleetFiles(fakeFolder)
  expect(crew.map(o => o.role)).toEqual(['build-17', 'secondmate · old-3', 'review-22'])
  expect(crew.map(o => o.state)).toEqual(['working', 'done', 'waiting'])
  const finished = crew.find(o => o.role === 'secondmate · old-3')!
  const active = crew.find(o => o.role === 'build-17')!
  expect(finished.finished).toBe(true)
  expect(isCrewDimmed(finished)).toBe(true)
  expect(active.finished).toBe(false)
  expect(isCrewDimmed(active)).toBe(false)
  expect(parseCrewStatus('failed: endpoint exited\\nwake: ping\\n')).toEqual({ state: 'gone', finished: true })
  expect(parseCrewStatus('endpoint gone: unavailable\\nwake: ping\\n')).toEqual({ state: 'gone', finished: true })
  expect(crew.some(o => o.role === 'other')).toBe(false)

  const manyCrew = parseFleetFiles(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`worker-${i}.meta`, 'kind=ship\nharness=pi\n'])))
  expect(new Set(manyCrew.map(o => o.color)).size).toBe(16)
  expect(manyCrew.some(o => ['#d77757', '#e255d0', '#35c9d8', '#3b82f6', '#7ed957', '#ff6b6b', '#8f7bff', '#f2e94e', '#ff9ecb'].includes(o.color))).toBe(false)
})

test('the real firstmate state-directory path renders one octopus per ship, scout, and secondmate', { options: { firstmateHome: '/fake-firstmate' } }, async ($, on) => {
  engine(on, {})
  const files: Record<string, string> = {
    '/fake-firstmate/state/ship-1.meta': 'kind=ship\nharness=pi\nmodel=sonnet\n',
    '/fake-firstmate/state/scout-2.meta': 'kind=scout\nharness=claude\n',
    '/fake-firstmate/state/secondmate-3.meta': 'kind=secondmate\nharness=pi\n',
    '/fake-firstmate/state/not-a-worker.meta': 'kind=task\nharness=pi\n',
    '/fake-firstmate/state/ship-1.status': 'working: implementing\nwake: ping\n',
  }
  on('fs.list', () => ({ value: Object.keys(files).filter(path => path.endsWith('.meta')).map(path => ({ name: path.split('/').at(-1)!, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  mock.clock(on)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(DESKTOP)
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown.filter(text => ['ship-1', 'scout-2', 'secondmate · secondmate-3'].includes(text))).toHaveLength(3)
  expect(shown).not.toContain('not-a-worker')
  expect(shown).toContain('working')
})

test('an unset firstmate home adds no crew octopuses', async ($, on) => {
  engine(on, {})
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(DESKTOP)
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).not.toContain('build-17')
})

test('the band hide and show buttons toggle every octopus, and hidden stays hidden', async ($, on) => {
  engine(on, {})
  let nextAgent = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'sonnet', agentId: `agent-${++nextAgent}` }))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()

  await $.agent.spawn({ prompt: 'y', subagentType: 'Explore' } as never)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect((await ui.find({ key: 'show-octopuses' }))?.props.label).toBe('Show octopuses (5)')
  await ui.press({ key: 'show-octopuses' })
  // Five creatures fit one 120-column strip.
  expect(await ui.findAll({ type: 'Raster' })).toHaveLength(1)
})

test('/octopuses hides and shows the band without a click', async ($, on) => {
  engine(on, {})
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore' } as never)
  const ui = await $.ui.mount(PANE)

  expect((await $.command.run({ command: 'octopuses', args: '' } as never)).text).toContain('hidden')
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await $.command.run({ command: 'octopuses', args: '' } as never)
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('six original creatures in the painter letters; the fixed three get three different ones', async ($, on) => {
  expect(CREATURES).toHaveLength(6)
  for (const rows of CREATURES) {
    expect(rows).toHaveLength(6)
    for (const row of rows) expect(row).toMatch(/^[.BALEWFYVRS]{10}$/)
  }

  engine(on, {})
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(PANE)
  const strip = await ui.find({ type: 'Raster' })
  expect(strip?.props.columns).toBe(120)
  expect(strip?.props.rows).toBe(5)
  const rows = rowsOf(String(strip?.props.cells), 120)
  expect(rows[3]).toContain('current')
  expect(rows[3]).toContain('advisor')
  expect(rows[3]).toContain('subagents')
  // Three walkers spread across 120 columns stand at 11, 51 and 91.
  const shapes = [11, 51, 91].map(x => rows.slice(0, 3).map(r => r.slice(x, x + 18)).join('|'))
  expect(new Set(shapes).size).toBe(3)
})

test('the creatures walk: the clock repaints the strip, names travelling with them', async ($, on) => {
  engine(on, {})
  const clock = mock.clock(on)
  const blits: string[] = []
  on('ui.blit', (_$, e) => {
    if ('cells' in e) blits.push(e.cells)
    return { value: {} }
  })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(PANE)
  const first = String((await ui.find({ type: 'Raster' }))?.props.cells)
  await clock.advance(1500)
  expect(blits.length).toBeGreaterThan(5)
  const last = blits.at(-1) ?? ''
  expect(last).not.toBe(first)
  expect(rowsOf(last, 120)[3]).toContain('current')
})

test('hidden, the band stops repainting', async ($, on) => {
  engine(on, {})
  const clock = mock.clock(on)
  let blits = 0
  on('ui.blit', () => {
    blits++
    return { value: {} }
  })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'hide' })
  blits = 0
  await clock.advance(1500)
  expect(blits).toBe(0)
})

test('walkers keep their order and their slots inside the strip, however long they walk', () => {
  let walkers = [0, 20, 40, 60].map((x, i) => walker(i, x))
  const start = walkers.map(w => w.x)
  for (let t = 1; t <= 500; t++) {
    walkers = step(walkers, 80, t)
    walkers.forEach((w, i) => {
      expect(w.x).toBeGreaterThanOrEqual(i > 0 ? (walkers[i - 1]?.x ?? 0) + 18 : 0)
      expect(w.x + 18).toBeLessThanOrEqual(80)
    })
  }
  expect(walkers.map(w => w.x)).not.toEqual(start)
  // Boxed in on both sides, a walker stands still rather than spinning.
  const stuck = step([walker(0, 0)], 18, 1)
  expect(stuck[0]?.x).toBe(0)
  expect(stuck[0]?.dir).toBe(1)
})

test('painting clips at the right edge and swaps characters a cell cannot hold', () => {
  // A creature past the edge is cut off, not wrapped onto the start of the next row.
  // The sprite starts at column 30: six columns show, four would spill.
  const edge = rowsOf(paintStrip([walker(0, 26)], 36, 0), 36)
  expect(edge).toHaveLength(5)
  for (const row of edge.slice(1)) expect(row.slice(0, 5)).toBe('     ')
  expect(edge[0]?.slice(30).trim()).not.toBe('')

  const named = rowsOf(paintStrip([{ ...walker(0, 0), label: 'ship-漢字', detail: 'sonnet (inherits)' }], 24, 0), 24)
  expect(named[3]).toContain('ship-??')
  expect(named[4]).toContain('sonnet (inherits)')

  // Too long for the slot: a name keeps its end, where task ids differ; a model keeps its start.
  const long = rowsOf(paintStrip([{ ...walker(0, 0), label: 'secondmate · build-17-hotfix', detail: 'claude-sonnet-5-5 (inherits)' }], 24, 0), 24)
  expect(long[3]).toContain('~· build-17-hotfix')
  expect(long[4]).toContain('claude-sonnet-5-5~')
})

test('a middle dot in a name is a cell the band accepts', async ($, on) => {
  engine(on, {})
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'x', subagentType: 'mate · ship-1' } as never)
  const ui = await $.ui.mount(PANE)
  const strip = await ui.find({ type: 'Raster' })
  expect(strip).toBeDefined()
  expect(rowsOf(String(strip?.props.cells), 120)[3]).toContain('mate · ship-1')
})
