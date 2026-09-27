import { stripVTControlCharacters as stripAnsi } from 'node:util'

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { initTheme } from '@earendil-works/pi-coding-agent'
import type { TUI, TuiMouseEvent } from '@earendil-works/pi-tui'
import { visibleWidth } from '@earendil-works/pi-tui'
import { expect, test } from 'vitest'

import register from '../agent/extensions/ask-user/index.ts'
import {
  type Action,
  type Answers,
  createInterview,
  formatAnswers,
  frameLines,
  initialState,
  layoutTabs,
  padLine,
  type Question,
  reduce,
  scrollbarColumn,
  type State,
  validateQuestions,
} from '../agent/extensions/ask-user/interview.ts'
import { reviewDocument, reviewQuestion, toReviewResult } from '../agent/extensions/ask-user/review.ts'
import { asMock, must } from './helpers.ts'

interface AskToolDetails {
  questions: { id: string }[]
  answers?: Answers
}

interface AskToolResult {
  content: { type: string; text: string }[]
  details: AskToolDetails
}

interface AskToolSchema {
  properties: { questions: { items: { required: string[] } } }
}

interface AskTool {
  name: string
  parameters: AskToolSchema
  promptGuidelines?: string[]
  execute(
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AskToolResult>
}

const resultText = (result: AskToolResult): string => must(result.content[0], 'tool result content').text

const pick = (id: string, header: string, multiSelect = false): Question => ({
  id,
  header,
  question: `${header}?`,
  options: [{ label: 'A' }, { label: 'B' }],
  multiSelect,
})

function run(questions: Question[], actions: Action[]): State {
  return actions.reduce(reduce, initialState(questions))
}

test('registers only ask_user and the doc entry renderer', () => {
  const tools: string[] = []
  const renderers: string[] = []
  register(
    asMock<ExtensionAPI>({
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerEntryRenderer: (type: string) => renderers.push(type),
    }),
  )
  expect(tools).toEqual(['ask_user'])
  expect(renderers).toEqual(['ask-doc'])
})

test('a single plain question submits on select', () => {
  const state = run([pick('a', 'A')], [{ type: 'down' }, { type: 'select' }])
  expect(state.outcome).toBe('submit')
  expect(state.answers.a).toEqual({ selected: ['B'] })
})

test('tab cycles through questions and the submit tab with wraparound', () => {
  const qs = [pick('a', 'A'), pick('b', 'B')]
  expect(run(qs, [{ type: 'next' }]).tab).toBe(1)
  expect(run(qs, [{ type: 'next' }, { type: 'next' }]).tab).toBe(2)
  expect(run(qs, [{ type: 'next' }, { type: 'next' }, { type: 'next' }]).tab).toBe(0)
  expect(run(qs, [{ type: 'prev' }]).tab).toBe(2)
})

test('select advances to the next tab and submit waits for every answer', () => {
  const qs = [pick('a', 'A'), pick('b', 'B')]
  let state = run(qs, [{ type: 'select' }])
  expect(state.tab).toBe(1)
  state = run(qs, [{ type: 'select' }, { type: 'next' }, { type: 'select' }])
  expect(state.tab).toBe(2)
  expect(state.outcome, 'b is unanswered').toBeUndefined()
  state = run(qs, [{ type: 'select' }, { type: 'select' }, { type: 'select' }])
  expect(state.outcome).toBe('submit')
  expect(state.answers).toEqual({ a: { selected: ['A'] }, b: { selected: ['A'] } })
})

test('multiselect toggles options and needs the submit tab', () => {
  const qs = [pick('m', 'M', true)]
  let state = run(qs, [{ type: 'select' }, { type: 'down' }, { type: 'toggle' }])
  expect(state.answers.m?.selected).toEqual(['A', 'B'])
  state = reduce(state, { type: 'toggle' })
  expect(state.answers.m?.selected).toEqual(['A'])
  expect(state.outcome).toBeUndefined()
  state = run(qs, [{ type: 'select' }, { type: 'next' }, { type: 'select' }])
  expect(state.outcome).toBe('submit')
})

test('the free-form row opens the editor and its text replaces a single choice', () => {
  const qs = [pick('a', 'A'), pick('b', 'B')]
  let state = run(qs, [{ type: 'select' }, { type: 'prev' }, { type: 'down' }, { type: 'down' }, { type: 'select' }])
  expect(state.editing).toBe(true)
  expect(reduce(state, { type: 'next' }).tab, 'tab keys go to the editor').toBe(state.tab)
  state = reduce(state, { type: 'freeform', text: '  my own  ' })
  expect(state.editing).toBe(false)
  expect(state.answers.a).toEqual({ selected: [], freeform: 'my own' })
  expect(state.tab).toBe(1)
})

test('empty free-form text leaves the question unanswered', () => {
  const state = run(
    [pick('a', 'A')],
    [{ type: 'down' }, { type: 'down' }, { type: 'select' }, { type: 'freeform', text: ' ' }],
  )
  expect(state.outcome).toBeUndefined()
  expect(state.answers.a).toEqual({ selected: [], freeform: undefined })
})

test('escape leaves the editor first, then cancels', () => {
  const qs = [pick('a', 'A')]
  let state = run(qs, [{ type: 'down' }, { type: 'down' }, { type: 'select' }, { type: 'cancel' }])
  expect(state.editing).toBe(false)
  expect(state.outcome).toBeUndefined()
  state = reduce(state, { type: 'cancel' })
  expect(state.outcome).toBe('cancel')
  expect(reduce(state, { type: 'select' }), 'finished state ignores input').toEqual(state)
})

test('validateQuestions rejects empty lists, duplicate ids and single options', () => {
  expect(validateQuestions([]) ?? '').toMatch(/No questions/)
  expect(validateQuestions([pick('a', 'A'), pick('a', 'B')]) ?? '').toMatch(/Duplicate/)
  expect(validateQuestions([{ ...pick('a', 'A'), options: [{ label: 'x' }] }]) ?? '').toMatch(/at least 2/)
  expect(validateQuestions([pick('a', 'A')])).toBeUndefined()
  expect(validateQuestions([{ ...pick('a', 'A'), options: [{ label: 'x' }, { label: 'x' }] }]) ?? '').toMatch(
    /duplicate option labels/,
  )
  expect(validateQuestions([{ ...pick('a', 'A'), options: [{ label: 'x' }, { label: 'Done' }] }]) ?? '').toMatch(
    /reserved option label "Done"/,
  )
  expect(
    validateQuestions([{ ...pick('a', 'A'), options: [{ label: 'x' }, { label: 'Type something.' }] }]) ?? '',
  ).toMatch(/reserved/)
})

test('formatAnswers lists choices and free text by header', () => {
  const qs = [pick('a', 'Auth'), pick('b', 'Store')]
  expect(formatAnswers(qs, { a: { selected: ['A'] }, b: { selected: [], freeform: 'sqlite' } })).toBe(
    'Auth: A\nStore: user wrote: sqlite',
  )
})

test('review answers map to accept, revise and cancel', () => {
  const q = reviewQuestion('Spec')
  expect(q.otherLabel).toBe('Suggest changes')
  expect(toReviewResult({ review: { selected: ['Accept'] } })).toEqual({ action: 'accept' })
  expect(toReviewResult({ review: { selected: [], freeform: 'add limits' } })).toEqual({
    action: 'revise',
    feedback: 'add limits',
  })
  expect(toReviewResult({ review: { selected: ['Cancel'] } })).toEqual({ action: 'cancel' })
  expect(toReviewResult(undefined)).toEqual({ action: 'cancel' })
})

const plainTheme = asMock<Theme>({
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
})
const fakeTui = () => asMock<TUI>({ requestRender: () => {}, terminal: { rows: 30, columns: 80 } })

const wheelEvent = (wheelDelta: number): TuiMouseEvent => ({
  type: 'wheel',
  button: 'none',
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 40,
  height: 30,
  shift: false,
  alt: false,
  ctrl: false,
  wheelDelta,
})

const inset = (line: string): string => line.slice(1, -1)

interface Renderable {
  render(width: number): string[]
  handleInput(data: string): void
  handleMouse?(event: TuiMouseEvent): unknown
  invalidate?(): void
}

test('interview component renders tabs, options and the editor, and returns answers', () => {
  let result: unknown = 'pending'
  const ui = createInterview(fakeTui(), plainTheme, [pick('a', 'Auth'), pick('b', 'Store', true)], (answers) => {
    result = answers
  })
  const first = ui.render(60).join('\n')
  expect(first).toMatch(/□ Auth .* □ Store .* Submit/)
  expect(first).toMatch(/> 1\. A\b/)
  expect(first).toMatch(/3\. Type something\./)
  ui.handleInput('\r')
  expect(ui.state.tab).toBe(1)
  expect(ui.render(60).join('\n')).toMatch(/\[ \] A/)
  ui.handleInput(' ')
  expect(ui.render(60).join('\n')).toMatch(/\[x\] A/)
  ui.handleInput('\u001b[B')
  ui.handleInput('\u001b[B')
  ui.handleInput('\r')
  expect(ui.state.editing).toBe(true)
  for (const ch of 'pg') ui.handleInput(ch)
  ui.handleInput('\r')
  expect(ui.state.answers.b).toEqual({ selected: ['A'], freeform: 'pg' })
  ui.handleInput('\t')
  expect(ui.render(60).join('\n')).toMatch(/Store: A, "pg"[\s\S]*Press Enter to submit/)
  ui.handleInput('\r')
  expect(result).toEqual({ a: { selected: ['A'] }, b: { selected: ['A'], freeform: 'pg' } })
})

test('interview component reports cancel on escape', () => {
  let result: unknown = 'pending'
  const ui = createInterview(fakeTui(), plainTheme, [pick('a', 'A')], (answers) => {
    result = answers
  })
  ui.handleInput('\u001b')
  expect(result).toBeUndefined()
})

test('digit keys pick an option directly', () => {
  const state = run([pick('a', 'A')], [{ type: 'pick', index: 1 }])
  expect(state.answers.a).toEqual({ selected: ['B'] })
  expect(run([pick('a', 'A')], [{ type: 'pick', index: 2 }]).editing, 'the last number opens free text').toBe(true)
  expect(run([pick('a', 'A')], [{ type: 'pick', index: 5 }]).cursor).toBe(0)
})

function askUser(): AskTool {
  let tool: AskTool | undefined
  register(
    asMock<ExtensionAPI>({
      registerTool: (t: unknown) => {
        tool = asMock<AskTool>(t)
      },
      registerEntryRenderer: () => {},
    }),
  )
  return must(tool, 'ask_user tool')
}

test('ask_user returns answers with default ids and handles headless, dismissal and bad input', async () => {
  const tool = askUser()
  const params = { questions: [{ header: 'Auth', question: 'Auth?', options: [{ label: 'A' }, { label: 'B' }] }] }
  const picks = ['B']
  const ctx = asMock<ExtensionContext>({
    mode: 'rpc',
    hasUI: true,
    ui: { select: async () => picks.shift(), input: async () => undefined },
  })
  const answered = await tool.execute('id', params, undefined, undefined, ctx)
  expect(resultText(answered)).toBe('Auth: B')
  expect(answered.details.questions[0]?.id).toBe('q1')
  expect(resultText(await tool.execute('id', params, undefined, undefined, ctx))).toMatch(/dismissed/)
  expect(
    resultText(
      await tool.execute('id', params, undefined, undefined, asMock<ExtensionContext>({ ...ctx, hasUI: false })),
    ),
  ).toMatch(/no interactive UI/)
  const bad = { questions: [{ header: 'X', question: 'X?', options: [{ label: 'only' }] }] }
  expect(resultText(await tool.execute('id', bad, undefined, undefined, ctx))).toMatch(/Error: .*at least 2 options/)
})

test('ask_user makes explicit and default ids unique', async () => {
  const tool = askUser()
  const options = [{ label: 'A' }, { label: 'B' }]
  const ctx = asMock<ExtensionContext>({
    mode: 'rpc',
    hasUI: true,
    ui: { select: async () => 'A', input: async () => undefined },
  })
  const result = await tool.execute(
    'id',
    {
      questions: [
        { id: 'q2', header: 'X', question: 'X?', options },
        { header: 'Y', question: 'Y?', options },
      ],
    },
    undefined,
    undefined,
    ctx,
  )
  expect(result.details.questions.map((q) => q.id)).toEqual(['q2', 'q2-2'])
  expect(resultText(result)).toBe('X: A\nY: A')
})

test('long headers are cut to 12 characters and tabs never split across lines', async () => {
  const qs = [1, 2, 3, 4].map((i) => ({
    ...pick(`q${i}`, `Storage layer choice ${i}`),
    question: 'Which persistence layer should store the phone number?',
  }))
  const ui = createInterview(fakeTui(), plainTheme, qs, () => {})
  const lines = ui.render(40)
  expect(lines.filter((l) => visibleWidth(l) > 40)).toEqual([])
  const tabLines = lines.map(stripAnsi).filter((l) => /[□■]|Submit/.test(l))
  const labels = tabLines.join(' ').match(/□ [^□■]+?(?= {2}| ?│| Submit)/g) ?? []
  expect(labels).toHaveLength(4)
  for (const label of labels) expect(label.trim()).toBe('□ Storage lay…')
})

test('layoutTabs wraps whole tabs and cuts a tab wider than the line', () => {
  expect(layoutTabs(['aaaa', 'bbbb', 'cccc'], 11)).toEqual([' aaaa bbbb', ' cccc'])
  expect(layoutTabs(['x'.repeat(20)], 8).map(stripAnsi)).toEqual([` ${'x'.repeat(6)}…`])
})

test('review overlay wraps a long title to the screen width', async () => {
  let component: Renderable | undefined
  const ctx = asMock<ExtensionContext>({
    mode: 'tui',
    ui: {
      custom: (
        factory: (tui: TUI, theme: Theme, kb: unknown, done: (result: Answers | undefined) => void) => Renderable,
      ) =>
        new Promise((resolve) => {
          component = factory(fakeTui(), plainTheme, undefined, resolve)
          must(component, 'review component').handleInput('\r')
        }),
    },
  })
  initTheme('dark')
  const pi = asMock<ExtensionAPI>({ appendEntry: () => {} })
  const title = `Spec: ${'very long feature title '.repeat(4)}`
  const result = await reviewDocument(pi, ctx, { title, markdown: `# Doc\n\n${'word '.repeat(60)}` })
  expect(result).toEqual({ action: 'accept' })
  const lines: string[] = must(component, 'review component').render(40)
  expect(lines.filter((l) => visibleWidth(l) > 40)).toEqual([])
  expect(lines.slice(1, 4).join(' ')).toContain('very long feature title very')
})

async function mountReview(markdown: string, width = 40, rows = 30) {
  let component: Renderable | undefined
  const terminal = { rows, columns: width }
  const tui = asMock<TUI>({ requestRender: () => {}, terminal })
  const ctx = asMock<ExtensionContext>({
    mode: 'tui',
    ui: {
      custom: (
        factory: (tui: TUI, theme: Theme, kb: unknown, done: (result: Answers | undefined) => void) => Renderable,
      ) =>
        new Promise((resolve) => {
          component = factory(tui, plainTheme, undefined, resolve)
          must(component, 'review component').handleInput('\r')
        }),
    },
  })
  initTheme('dark')
  const pi = asMock<ExtensionAPI>({ appendEntry: () => {} })
  await reviewDocument(pi, ctx, { title: 'Spec', markdown })
  return { component: must(component, 'review component'), terminal }
}

const longMarkdown = (n: number) => `# Doc\n\n${Array.from({ length: n }, (_, i) => `paragraph ${i}`).join('\n\n')}`
const thumbLine = (lines: string[]) => lines.findIndex((l) => l.includes('█'))

test('review overlay frames the body and wheel scrolls with a moving scrollbar', async () => {
  const { component } = await mountReview(longMarkdown(40), 40, 20)
  let lines = component.render(40)
  expect(stripAnsi(must(lines[0], 'top border'))).toMatch(/^╭─+╮$/)
  expect(stripAnsi(must(lines[lines.length - 1], 'bottom border'))).toMatch(/^╰─+╯$/)
  expect(lines.filter((l) => visibleWidth(l) > 40)).toEqual([])
  const topIndexes = lines.flatMap((l, i) => (stripAnsi(l).startsWith('╭') ? [i] : []))
  expect(topIndexes.length).toBe(2)
  const inner = lines.slice(must(topIndexes[0], 'review top') + 1, must(topIndexes[1], 'picker top') - 1)
  expect(inner.length).toBeGreaterThan(0)
  for (const line of inner) {
    expect(stripAnsi(line).startsWith('│')).toBe(true)
    expect(stripAnsi(line).endsWith('│')).toBe(true)
  }
  expect(inset(stripAnsi(must(inner[0], 'title line'))).startsWith(' ')).toBe(true)
  expect(lines.join('\n')).not.toContain('PgUp/PgDn scroll')
  expect(thumbLine(lines)).toBeGreaterThan(0)

  const before = lines.join('\n')
  expect(component.handleMouse?.(wheelEvent(3))).toEqual({ handled: true })
  lines = component.render(40)
  expect(lines.join('\n')).not.toBe(before)
  component.handleMouse?.(wheelEvent(-3))
  expect(component.render(40).join('\n')).toBe(before)
  component.handleMouse?.(wheelEvent(3))
  lines = component.render(40)

  component.handleMouse?.(wheelEvent(9999))
  const scrolled = component.render(40)
  expect(scrolled.filter((l) => visibleWidth(l) > 40)).toEqual([])
  expect(thumbLine(scrolled)).not.toBe(thumbLine(lines))
})

test('review overlay keeps every line within width across page and wheel scrolling', async () => {
  const { component } = await mountReview(longMarkdown(60), 32, 18)
  const check = (ls: string[]) => expect(ls.filter((l) => visibleWidth(l) > 32)).toEqual([])
  check(component.render(32))
  for (let i = 0; i < 4; i++) {
    component.handleInput('\u001b[6~')
    check(component.render(32))
  }
  component.handleMouse?.(wheelEvent(9999))
  check(component.render(32))
  component.handleInput('\u001b[5~')
  check(component.render(32))
})

test('review overlay clamps wheel scrolling at both body edges', async () => {
  const { component } = await mountReview(longMarkdown(40), 40, 20)
  component.handleMouse?.(wheelEvent(9999))
  const bottom = component.render(40).join('\n')
  component.handleMouse?.(wheelEvent(9999))
  expect(component.render(40).join('\n')).toBe(bottom)
  component.handleMouse?.(wheelEvent(-9999))
  const top = component.render(40).join('\n')
  component.handleMouse?.(wheelEvent(-9999))
  expect(component.render(40).join('\n')).toBe(top)
  expect(top).not.toBe(bottom)
})

test('pageDown and pageUp still move the review body window', async () => {
  const { component } = await mountReview(longMarkdown(60), 40, 20)
  const initial = component.render(40).join('\n')
  component.handleInput('\u001b[6~')
  const down = component.render(40).join('\n')
  expect(down).not.toBe(initial)
  component.handleInput('\u001b[5~')
  expect(component.render(40).join('\n')).toBe(initial)
})

test('review overlay keeps the frame and scroll bounds after a resize', async () => {
  const { component, terminal } = await mountReview(longMarkdown(60), 40, 24)
  component.handleMouse?.(wheelEvent(9999))
  component.render(40)
  terminal.rows = 12
  component.invalidate?.()
  const resized = component.render(40)
  expect(resized.filter((l) => visibleWidth(l) > 40)).toEqual([])
  expect(stripAnsi(must(resized[0], 'top border'))).toMatch(/^╭─+╮$/)
  component.handleMouse?.(wheelEvent(9999))
  const bottom = component.render(40).join('\n')
  component.handleMouse?.(wheelEvent(9999))
  expect(component.render(40).join('\n')).toBe(bottom)
})

test('scrollbarColumn is blank when content fits and marks a proportional thumb otherwise', () => {
  expect(scrollbarColumn(plainTheme, 0, 5, 5)).toEqual([' ', ' ', ' ', ' ', ' '])
  const top = scrollbarColumn(plainTheme, 0, 5, 50)
  const bottom = scrollbarColumn(plainTheme, 45, 5, 50)
  expect(top.filter((c) => c === '█')).toHaveLength(1)
  expect(top[0]).toBe('█')
  expect(bottom[4]).toBe('█')
})

test('frameLines pads content to the given width', () => {
  const framed = frameLines(plainTheme, ['hi', ''], 10)
  expect(framed).toEqual(['╭────────╮', '│hi      │', '│        │', '╰────────╯'])
  for (const line of framed) expect(visibleWidth(line)).toBe(10)
  expect(padLine('x', 3)).toBe('x  ')
})

test('interview option list scrolls on wheel only when it overflows', () => {
  const many: Question = {
    id: 'q',
    header: 'Many',
    question: 'Pick one?',
    options: Array.from({ length: 40 }, (_, i) => ({ label: `Option ${i + 1}` })),
  }
  const ui = createInterview(fakeTui(), plainTheme, [many], () => {})
  let lines = ui.render(60)
  expect(lines.filter((l) => visibleWidth(l) > 60)).toEqual([])
  expect(lines.some((l) => l.includes('█'))).toBe(true)
  expect(lines.join('\n')).not.toContain('Type something.')
  expect(ui.handleMouse?.(wheelEvent(9999))).toEqual({ handled: true })
  lines = ui.render(60)
  expect(lines.join('\n')).toContain('Type something.')
  expect(lines.filter((l) => visibleWidth(l) > 60)).toEqual([])

  const short = createInterview(fakeTui(), plainTheme, [pick('a', 'A')], () => {})
  const shortLines = short.render(60)
  expect(shortLines.some((l) => l.includes('█'))).toBe(false)
  expect(short.handleMouse?.(wheelEvent(3))).toEqual({ handled: true })
  expect(short.render(60).join('\n')).toBe(shortLines.join('\n'))
})

test('ask_user requires multiSelect and the fallback collects several picks', async () => {
  const tool = askUser()
  expect(tool.parameters.properties.questions.items.required).toContain('multiSelect')
  expect(must(tool.promptGuidelines, 'prompt guidelines').some((g) => g.includes('multiSelect true'))).toBe(true)
  const picks = ['A', 'B', 'Done']
  const ctx = asMock<ExtensionContext>({
    mode: 'rpc',
    hasUI: true,
    ui: { select: async () => picks.shift(), input: async () => undefined },
  })
  const options = [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
  const result = await tool.execute(
    'id',
    { questions: [{ header: 'X', question: 'X?', options, multiSelect: true }] },
    undefined,
    undefined,
    ctx,
  )
  expect(resultText(result)).toBe('X: A; B')
  const done = ['C', 'Done']
  const ctx2 = asMock<ExtensionContext>({ ...ctx, ui: { ...ctx.ui, select: async () => done.shift() } })
  const one = await tool.execute(
    'id',
    { questions: [{ header: 'X', question: 'X?', options, multiSelect: true }] },
    undefined,
    undefined,
    ctx2,
  )
  expect(resultText(one)).toBe('X: C')
})

test('fallback multi-select: free text keeps picks, exhausting options ends, cancel dismisses, single-select never offers Done', async () => {
  const tool = askUser()
  const options = [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
  const ask = async (multiSelect: boolean, picks: (string | undefined)[], typed?: string) => {
    const seen: { title: string; choices: string[] }[] = []
    const ctx = asMock<ExtensionContext>({
      mode: 'rpc',
      hasUI: true,
      ui: {
        select: async (title: string, choices: string[]) => {
          seen.push({ title, choices })
          return picks.shift()
        },
        input: async () => typed,
      },
    })
    const result = await tool.execute(
      'id',
      { questions: [{ header: 'X', question: 'X?', options, multiSelect }] },
      undefined,
      undefined,
      ctx,
    )
    return { text: resultText(result), seen }
  }
  const freeform = await ask(true, ['A', 'Type something.'], 'custom')
  expect(freeform.text).toBe('X: A; user wrote: custom')
  expect(freeform.seen[0]?.choices, 'Done appears only after a pick').toEqual(['A', 'B', 'C', 'Type something.'])
  expect(freeform.seen[1]).toEqual({ title: 'X? (picked: A)', choices: ['B', 'C', 'Type something.', 'Done'] })
  expect((await ask(true, ['A', 'B', 'C'])).text).toBe('X: A; B; C')
  expect((await ask(true, ['A', undefined])).text).toMatch(/dismissed/)
  const single = await ask(false, ['B'])
  expect(single.text).toBe('X: B')
  expect(single.seen.length).toBe(1)
  expect(!(single.seen[0]?.choices ?? []).includes('Done')).toBe(true)
})
