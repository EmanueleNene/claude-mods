import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { isCrewDimmed, parseCrewStatus, parseFleetFiles } from './register'

const PANE = { plugin: 'octopus-crew', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never

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

  const ui = await $.ui.mount(PANE)
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

  const ui = await $.ui.mount(PANE)
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
  const ui = await $.ui.mount(PANE)
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown.filter(text => ['ship-1', 'scout-2', 'secondmate · secondmate-3'].includes(text))).toHaveLength(3)
  expect(shown).not.toContain('not-a-worker')
  expect(shown).toContain('working')
})

test('an unset firstmate home adds no crew octopuses', async ($, on) => {
  engine(on, {})
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const ui = await $.ui.mount(PANE)
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
  expect(await ui.findAll({ type: 'Raster' })).toHaveLength(5)
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

test('each octopus is a picture of its own: one Raster apiece, no two alike', async ($, on) => {
  engine(on, {})
  let nextAgent = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'sonnet', agentId: `agent-${++nextAgent}` }))
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  for (const prompt of ['a', 'b', 'c']) await $.agent.spawn({ prompt, subagentType: 'Explore' } as never)

  const ui = await $.ui.mount(PANE)
  const pictures = await ui.findAll({ type: 'Raster' })
  expect(pictures).toHaveLength(6)
  const cells = pictures.map(p => String(p.props.cells))
  expect(new Set(cells).size).toBe(6)
  expect(pictures[0]?.props.columns).toBe(11)
  expect(pictures[0]?.props.rows).toBe(4)
})
