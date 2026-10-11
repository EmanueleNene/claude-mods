import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { isCrewDimmed, parseCrewStatus, parseFleetFiles } from './register'

const PANE = { plugin: 'octopus-crew', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never

const engine = (on: On, settings: Record<string, unknown>) => {
  on('settings.read', () => ({ value: settings }))
  on('env.get', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
}


test('a load draws one octopus for the advisor and one for the subagents, in different colours', async ($, on) => {
  engine(on, { advisorModel: 'opus', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)

  const ui = await $.ui.mount(PANE)
  const text = await ui.findAll({ type: 'Text' })
  const shown = text.map(t => t.text).join('\n')
  expect(shown).toContain('advisor')
  expect(shown).toContain('opus')
  expect(shown).toContain('subagents')
  expect(shown).toContain('haiku')

  const hues = new Set(text.map(t => String(t.props.color ?? '')).filter(Boolean))
  expect(hues.size).toBe(3)
  expect(hues.has('#d77757')).toBe(true)
})

test('a spawned subagent gets an octopus of its own colour, once per type and model', async ($, on) => {
  engine(on, { advisorModel: 'opus' })
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'sonnet' }))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore', model: 'haiku' } as never)
  await $.agent.spawn({ prompt: 'y', subagentType: 'Explore', model: 'haiku' } as never)

  const ui = await $.ui.mount(PANE)
  const text = await ui.findAll({ type: 'Text' })
  expect(text.filter(t => t.text === 'Explore')).toHaveLength(1)
  const hues = new Set(text.map(t => String(t.props.color ?? '')).filter(Boolean))
  expect(hues.size).toBe(4)
})

test('crew task files map state, dim finished tasks, and use a distinct expanded palette', { options: { firstmateHome: '/fake-firstmate' } }, async ($, on) => {
  engine(on, {})
  mock.clock(on)
  const files: Record<string, string> = {
    '/fake-firstmate/state/build-17.meta': 'kind=crewmate\nharness=claude\nmodel=sonnet\n',
    '/fake-firstmate/state/review-22.meta': 'kind=crewmate\nharness=claude\n',
    '/fake-firstmate/state/old-3.meta': 'kind=crewmate\n',
    '/fake-firstmate/state/other.meta': 'kind=task\n',
    '/fake-firstmate/state/build-17.status': 'working: implementing\nwake: ping\n',
    '/fake-firstmate/state/review-22.status': 'working: review\nblocked: needs approval\nwake: ping\n',
    '/fake-firstmate/state/old-3.status': 'working: started\ndone: complete\nwake: ping\n',
  }
  // Parsing is exercised against a fake state directory; the live plugin only uses $.fs reads.
  const fakeFolder: Record<string, string> = Object.fromEntries(Object.entries(files).map(([path, content]) => [path.split('/').at(-1)!, content]))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const crew = parseFleetFiles(fakeFolder)
  expect(crew.map(o => o.role)).toEqual(['build-17', 'old-3', 'review-22'])
  expect(crew.map(o => o.state)).toEqual(['working', 'done', 'waiting'])
  const finished = crew.find(o => o.role === 'old-3')!
  const active = crew.find(o => o.role === 'build-17')!
  expect(finished.finished).toBe(true)
  expect(isCrewDimmed(finished)).toBe(true)
  expect(active.finished).toBe(false)
  expect(isCrewDimmed(active)).toBe(false)
  expect(parseCrewStatus('failed: endpoint exited\\nwake: ping\\n')).toEqual({ state: 'gone', finished: true })
  expect(parseCrewStatus('endpoint gone: unavailable\\nwake: ping\\n')).toEqual({ state: 'gone', finished: true })
  expect(crew.some(o => o.role === 'other')).toBe(false)

  const manyCrew = parseFleetFiles(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`worker-${i}.meta`, 'kind=crewmate\n'])))
  expect(new Set(manyCrew.map(o => o.color)).size).toBe(16)
  expect(manyCrew.some(o => ['#d77757', '#e255d0', '#35c9d8', '#3b82f6', '#7ed957', '#ff6b6b', '#8f7bff', '#f2e94e', '#ff9ecb'].includes(o.color))).toBe(false)
})

test('an unset firstmate home adds no crew octopuses', async ($, on) => {
  engine(on, {})
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).not.toContain('build-17')
})

test('the band hide and show buttons toggle every octopus', async ($, on) => {
  engine(on, {})
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ key: 'show-octopuses' })).toBeDefined()
  await ui.press({ key: 'show-octopuses' })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('each octopus is a picture of its own: one Raster apiece, no two alike', async ($, on) => {
  engine(on, { advisorModel: 'opus', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } })
  await $.session.start({ source: 'startup', cwd: '/work' } as never)

  const ui = await $.ui.mount(PANE)
  const pictures = await ui.findAll({ type: 'Raster' })
  expect(pictures).toHaveLength(3)
  const cells = pictures.map(p => String(p.props.cells))
  expect(new Set(cells).size).toBe(3)
  expect(pictures[0]?.props.columns).toBe(11)
  expect(pictures[0]?.props.rows).toBe(4)
})
