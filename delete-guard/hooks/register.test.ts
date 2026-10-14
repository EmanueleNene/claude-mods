import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

/** The engine's bottom: a cwd, and a Bash that records what actually runs. */
const engine = (on: On, ran: string[]) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: {} as never }
  })
}

/** The guard holds deletions only once the cleanup skill has loaded. */
const arm = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.skill.prompt({ skill: 'clean-generated-artifacts', text: '' })

const PANE = { plugin: 'delete-guard', surface: 'terminal', component: 'Pane', requestId: 'delete-guard', props: {} } as const

test('a command that deletes nothing passes through', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(ran).toEqual(['ls -la'])
})

test('rm is held until the user answers, and a kept file is dropped from the retry', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)

  const held = await $.tool.call({ tool: 'Bash', command: 'rm -f a.txt "b c.txt" *.log' })
  expect(ran).toEqual([])
  expect(JSON.stringify(held)).toContain('needs the user to confirm')

  const ui = await $.ui.mount(PANE)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  const toggles = keys.filter(k => k.startsWith('t:'))
  expect(toggles).toHaveLength(3)
  await ui.press({ key: toggles[1] as string }) // keep "b c.txt"
  await ui.press({ key: keys.find(k => k.startsWith('ok:')) as string })

  await $.tool.call({ tool: 'Bash', command: 'rm -f a.txt "b c.txt" *.log' })
  expect(ran).toEqual(['rm -f a.txt *.log'])
})

test('Refuse all denies the retry and runs nothing', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  const ui = await $.ui.mount(PANE)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  await ui.press({ key: keys.find(k => k.startsWith('no:')) as string })

  const retry = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(ran).toEqual([])
  expect(JSON.stringify(retry)).toContain('refused')
})

test('a compound delete command is one all-or-nothing item', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'cd /tmp && rm -rf cache' })

  const ui = await $.ui.mount(PANE)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  expect(keys.filter(k => k.startsWith('t:'))).toHaveLength(1)
  await ui.press({ key: keys.find(k => k.startsWith('ok:')) as string })

  await $.tool.call({ tool: 'Bash', command: 'cd /tmp && rm -rf cache' })
  expect(ran).toEqual(['cd /tmp && rm -rf cache'])
})

test('with no pane drawn, the same question shows above the prompt', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  const band = await $.ui.mount({ plugin: 'delete-guard', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } })
  const keys = (await band.findAll({ type: 'Button' })).map(b => b.key ?? '')
  expect(keys.some(k => k.startsWith('ok:'))).toBe(true)
  expect(keys.some(k => k.startsWith('no:'))).toBe(true)
})

test('without the cleanup skill, a delete runs unguarded', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await $.skill.prompt({ skill: 'commit', text: '' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(ran).toEqual(['rm -rf build'])
})

test('Select all toggles every file, and Select none keeps them all', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'rm a.txt b.txt' })

  const ui = await $.ui.mount(PANE)
  const keyOf = async (prefix: string) =>
    ((await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').find(k => k.startsWith(prefix))) as string
  await ui.press({ key: await keyOf('all:') }) // all selected, so this keeps both
  await ui.press({ key: await keyOf('t:') }) // reselect a.txt
  await ui.press({ key: await keyOf('ok:') })

  await $.tool.call({ tool: 'Bash', command: 'rm a.txt b.txt' })
  expect(ran).toEqual(['rm a.txt'])
})

test('Delete all deletes every file, even ones toggled to keep', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'rm a.txt b.txt' })

  const ui = await $.ui.mount(PANE)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  await ui.press({ key: keys.find(k => k.startsWith('t:')) as string })
  await ui.press({ key: keys.find(k => k.startsWith('del:')) as string })

  await $.tool.call({ tool: 'Bash', command: 'rm a.txt b.txt' })
  expect(ran).toEqual(['rm a.txt b.txt'])
})

test('each file shows its name and the folder it is in', async ($, on) => {
  engine(on, [])
  await arm($)
  await $.tool.call({ tool: 'Bash', command: 'rm build/a.txt /tmp/b.txt c.txt out/' })

  const ui = await $.ui.mount(PANE)
  for (const folder of ['/work/build', '/tmp', '/work']) {
    expect(await ui.findAll({ type: 'Text', text: new RegExp(`in ${folder}$`) })).not.toHaveLength(0)
  }
  expect(await ui.findAll({ type: 'Text', text: /build\/a\.txt/ })).toHaveLength(0)
})
