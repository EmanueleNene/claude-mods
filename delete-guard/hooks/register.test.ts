import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

/** The engine's bottom: a cwd, and a Bash that records what actually runs. */
const engine = (on: On, ran: string[]) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: {} as never }
  })
}

const PANE = { plugin: 'delete-guard', surface: 'terminal', component: 'Pane', requestId: 'delete-guard', props: {} } as const

test('a command that deletes nothing passes through', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(ran).toEqual(['ls -la'])
})

test('rm is held until the user answers, and a kept file is dropped from the retry', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)

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
  await $.tool.call({ tool: 'Bash', command: 'cd /tmp && rm -rf cache' })

  const ui = await $.ui.mount(PANE)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  expect(keys.filter(k => k.startsWith('t:'))).toHaveLength(1)
  await ui.press({ key: keys.find(k => k.startsWith('ok:')) as string })

  await $.tool.call({ tool: 'Bash', command: 'cd /tmp && rm -rf cache' })
  expect(ran).toEqual(['cd /tmp && rm -rf cache'])
})
