import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = { plugin: 'octopus-crew', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as const

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
  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore', model: 'haiku' })
  await $.agent.spawn({ prompt: 'y', subagentType: 'Explore', model: 'haiku' })

  const ui = await $.ui.mount(PANE)
  const text = await ui.findAll({ type: 'Text' })
  expect(text.filter(t => t.text === 'Explore')).toHaveLength(1)
  const hues = new Set(text.map(t => String(t.props.color ?? '')).filter(Boolean))
  expect(hues.size).toBe(4)
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
