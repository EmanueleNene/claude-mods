import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeleteItem, DeleteRequest } from '../types'

const PANE = 'delete-guard'
const requests = atom({ plugin: 'delete-guard', key: 'requests' } as const, [])
// The guard holds new deletions only while this skill's turn runs.
const SKILL = 'clean-generated-artifacts'
const armed = atom({ plugin: 'delete-guard', key: 'armed' } as const, false)

const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put'])
const COMPOUND = /[;&|<>`\n]|\$\(/
const DELETE_WORDS = /(^|[\s;&|(])(rm|rmdir|unlink|shred|trash|trash-put)\s|\s-delete(\s|$)|(^|[\s;&|(])git\s+(clean|rm)\s/

type Token = { value: string; raw: string }
type Found = { head: Token[]; targets: Token[]; items: DeleteItem[]; isSplittable: boolean }

function tokenize(text: string): Token[] | undefined {
  const out: Token[] = []
  let value = ''
  let raw = ''
  let quote = ''
  let has = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote) {
      raw += c
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < text.length) {
        i++
        value += text[i]
        raw += text[i]
      } else value += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      raw += c
      has = true
    } else if (c === '\\' && i + 1 < text.length) {
      i++
      raw += c + text[i]
      value += text[i]
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push({ value, raw })
      value = ''
      raw = ''
      has = false
    } else {
      value += c
      raw += c
      has = true
    }
  }
  if (quote) return undefined
  if (has) out.push({ value, raw })
  return out
}

/** What a Bash command would delete, or undefined when it deletes nothing. */
function describe(command: string): Found | undefined {
  const tokens = COMPOUND.test(command) ? undefined : tokenize(command)
  if (tokens && tokens.length > 0) {
    const first = tokens[0]?.value ?? ''
    const verb = first === 'git' && tokens[1]?.value === 'rm' ? 2 : DELETERS.has(first) ? 1 : 0
    if (verb > 0) {
      let at = verb
      while (at < tokens.length) {
        const t = (tokens[at] as Token).value
        if (t === '--') {
          at++
          break
        }
        if (!t.startsWith('-') || t === '-') break
        at++
      }
      const targets = tokens.slice(at)
      if (targets.length === 0) return undefined
      const items = targets.map((t): DeleteItem => ({ label: t.value, isKept: false }))
      return { head: tokens.slice(0, at), targets, items, isSplittable: true }
    }
  }
  if (DELETE_WORDS.test(command)) {
    return {
      head: [],
      targets: [],
      items: [{ label: command, isKept: false }],
      isSplittable: false,
    }
  }
  return undefined
}

function rebuild(found: Found, items: DeleteItem[]): string {
  const kept = found.targets.filter((_, i) => !items[i]?.isKept)
  return [...found.head, ...kept].map(t => t.raw).join(' ')
}

/** A target split into its name and the folder it sits in, relative ones resolved against cwd. */
function place(label: string, cwd: string): { name: string; folder: string } {
  const path = label.length > 1 ? label.replace(/[/\\]+$/, '') : label
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = at < 0 ? '' : path.slice(0, at)
  const isAbsolute = /^([/\\~]|[a-zA-Z]:)/.test(path)
  return {
    name: at < 0 ? path : path.slice(at + 1) || path,
    folder: isAbsolute ? dir || path.slice(0, 1) : dir ? `${cwd}/${dir}` : cwd,
  }
}

const draw = async ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list = await read($, requests)
  const pending = list.filter(r => r.status === 'pending')
  const history = list.filter(r => r.status !== 'pending').slice(-3)

  const toggle = (id: string, index: number) =>
    update($, requests, l =>
      l.map(r =>
        r.id === id && r.status === 'pending'
          ? { ...r, items: r.items.map((it, i) => (i === index ? { ...it, isKept: !it.isKept } : it)) }
          : r,
      ),
    )

  // All selected for deletion flips to all kept; otherwise everything is selected.
  const toggleAll = (id: string) =>
    update($, requests, l =>
      l.map(r => {
        if (r.id !== id || r.status !== 'pending') return r
        const isKept = r.items.every(it => !it.isKept)
        return { ...r, items: r.items.map(it => ({ ...it, isKept })) }
      }),
    )

  const decide = async (id: string, verdict: 'approved' | 'refused', isAll = false) => {
    let settled: DeleteRequest | undefined
    await update($, requests, l =>
      l.map(r => {
        if (r.id !== id || r.status !== 'pending') return r
        if (isAll) r = { ...r, items: r.items.map(it => ({ ...it, isKept: false })) }
        const isAllKept = r.items.every(i => i.isKept)
        settled = { ...r, status: verdict === 'refused' || isAllKept ? 'refused' : 'approved' }
        return settled
      }),
    )
    if (!settled) return
    const names = (isKept: boolean) =>
      settled?.items.filter(i => i.isKept === isKept).map(i => i.label).join(', ') ?? ''
    const text =
      settled.status === 'refused'
        ? `delete-guard: the user refused the deletion (${settled.command}). Nothing was deleted. Do not retry.`
        : `delete-guard: the user confirmed the deletion. Delete: ${names(false)}.` +
          (names(true) ? ` Keep, do not delete: ${names(true)}.` : '') +
          ` Re-run the exact same command now: ${settled.command}`
    const stillPending = (await read($, requests)).some(r => r.status === 'pending')
    if (!stillPending) {
      $.ui.status(undefined)
      await $.ui.close({ id: PANE })
    }
    void $.prompt.submit({ text })
  }

  return (
    <Box flexDirection="column">
      {pending.length === 0 && <Text dimColor>No deletions waiting.</Text>}
      {pending.map(r => (
        <Box flexDirection="column" key={r.id}>
          <Text bold>Delete {r.items.length === 1 ? 'this' : `these ${r.items.length}`}?</Text>
          {r.items.map((item, i) => (
            <Button
              key={`t:${r.id}:${i}`}
              hotkey={i < 9 ? String(i + 1) : undefined}
              dimColor={item.isKept}
              onPress={() => toggle(r.id, i)}
            >
              {item.isKept ? '[ ] keep   ' : '[x] delete '}
              {r.isSplittable ? place(item.label, r.cwd).name : item.label}
              <Text dimColor>  in {r.isSplittable ? place(item.label, r.cwd).folder : r.cwd}</Text>
            </Button>
          ))}
          <Box>
            {r.items.length > 1 && (
              <Button key={`all:${r.id}`} hotkey="a" onPress={() => toggleAll(r.id)}>
                {r.items.every(it => !it.isKept) ? 'Select none' : 'Select all'}
              </Button>
            )}
            {r.items.length > 1 && <Text> </Text>}
            <Button key={`ok:${r.id}`} variant="primary" hotkey="c" onPress={() => decide(r.id, 'approved')}>
              Confirm
            </Button>
            <Text> </Text>
            {r.items.length > 1 && (
              <Button key={`del:${r.id}`} hotkey="d" onPress={() => decide(r.id, 'approved', true)}>
                Delete all
              </Button>
            )}
            {r.items.length > 1 && <Text> </Text>}
            <Button key={`no:${r.id}`} hotkey="r" onPress={() => decide(r.id, 'refused')}>
              Refuse all
            </Button>
          </Box>
          <Text dimColor>1-9 toggle a file, a select all/none, c confirm, d delete all, r refuse all</Text>
        </Box>
      ))}
      {history.map(r => (
        <Text dimColor key={`h:${r.id}`}>
          {r.status}: {r.items.filter(i => !i.isKept).length} deleted, {r.items.filter(i => i.isKept).length} kept
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delete-guard',
      description: 'Open the delete confirmation pane',
    })

    return next(e)
  })

  on('command.run', { command: 'delete-guard' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Delete files?', focus: true })

    return { text: 'Delete pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = describe(e.command)
    if (!found) return next(e)

    const cwd = await $.session.cwd()
    const list = await read($, requests)
    const same = list.filter(r => r.command === e.command && r.cwd === cwd)

    const done = same.find(r => r.status !== 'pending' && !r.isUsed)
    if (done) {
      await update($, requests, l => l.map(r => (r.id === done.id ? { ...r, isUsed: true } : r)))
      if (done.status === 'refused') {
        return { deny: 'delete-guard: the user refused this deletion. Nothing was deleted. Do not retry.' }
      }
      if (done.isSplittable && done.items.some(i => i.isKept)) {
        return next({ ...e, command: rebuild(found, done.items) })
      }
      return next(e)
    }

    if (same.some(r => r.status === 'pending')) {
      return {
        deny: 'delete-guard: still waiting for the user to answer in the delete pane. Do not retry until you are told their decision.',
      }
    }

    if (!(await read($, armed))) return next(e)

    const request: DeleteRequest = {
      id: e.tool_use_id,
      command: e.command,
      cwd,
      isSplittable: found.isSplittable,
      items: found.items,
      status: 'pending',
      isUsed: false,
    }
    await update($, requests, l => [...l, request].slice(-30))
    const opened = await $.ui.open({ id: PANE, title: 'Delete files?', focus: true })
    if (!opened.isPlaced) $.ui.toast('delete-guard: a deletion awaits you. Run /delete-guard to answer.')
    $.ui.status('delete-guard: waiting for your answer')

    return {
      deny: 'delete-guard: this deletion needs the user to confirm in the delete pane, where they can keep individual files. Do not retry and do not ask in chat; you will be told their decision.',
    }
  }).catch(($, e, next) =>
    next.called || !DELETE_WORDS.test(e.tool === 'Bash' ? e.command : '')
      ? next(e)
      : { deny: 'delete-guard: its guard failed, so the deletion was not run.' },
  )

  on('skill.prompt', { skill: SKILL }, async ($, e, next) => {
    await update($, armed, () => true)
    return next(e)
  })

  // Disarm when the main turn ends; a decision already asked for is still honoured on the retry.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, armed, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => draw($, e))

  // A pane opened by a hook waits undrawn on a narrow terminal, so the same question shows
  // above the prompt at any width, until the pane itself is drawn.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hasPending = (await read($, requests)).some(r => r.status === 'pending')
    const isPaneUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    if (!hasPending || isPaneUp || e.props.hasSurvey) return next(e)

    return draw($, e)
  })
}
