import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import {
  type Component,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  id: string
  header: string
  question: string
  options: QuestionOption[]
  multiSelect?: boolean
  otherLabel?: string
}

export interface Answer {
  selected: string[]
  freeform?: string | undefined
}

export type Answers = Record<string, Answer>

export type Action =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'select' }
  | { type: 'toggle' }
  | { type: 'cancel' }
  | { type: 'pick'; index: number }
  | { type: 'freeform'; text: string }

export interface State {
  questions: Question[]
  tab: number
  cursor: number
  answers: Answers
  editing: boolean
  outcome?: 'submit' | 'cancel'
}

export const DEFAULT_OTHER_LABEL = 'Type something.'
export const MAX_HEADER = 12
const DONE = 'Done'

export function tabLabel(header: string): string {
  return truncateToWidth(header, MAX_HEADER, '…')
}

export function layoutTabs(tabs: string[], width: number, indent = ' '): string[] {
  const room = Math.max(1, width - visibleWidth(indent))
  const lines: string[] = []
  let line = ''
  for (const raw of tabs) {
    const tab = visibleWidth(raw) > room ? truncateToWidth(raw, room, '…') : raw
    const next = line ? `${line} ${tab}` : tab
    if (line && visibleWidth(next) > room) {
      lines.push(indent + line)
      line = tab
    } else line = next
  }
  if (line) lines.push(indent + line)
  return lines
}

export function initialState(questions: Question[]): State {
  return { questions, tab: 0, cursor: 0, answers: {}, editing: false }
}

/** Pad a possibly-styled line to exactly `width` visible cells. */
export function padLine(line: string, width: number): string {
  const room = Math.max(0, width)
  const clipped = truncateToWidth(line, room)
  return clipped + ' '.repeat(Math.max(0, room - visibleWidth(clipped)))
}

/** Wrap content lines in a one-column border using the theme's border token. */
export function frameLines(theme: Theme, lines: string[], width: number): string[] {
  const w = Math.max(1, width)
  if (w < 3) return lines.map((line) => padLine(line, w))
  const inner = w - 2
  const edge = (s: string) => theme.fg('border', s)
  return [
    edge(`╭${'─'.repeat(inner)}╮`),
    ...lines.map((line) => `${edge('│')}${padLine(line, inner)}${edge('│')}`),
    edge(`╰${'─'.repeat(inner)}╯`),
  ]
}

/** One-cell scrollbar glyphs (dim track, accent thumb) for a window of `pageSize` rows. */
export function scrollbarColumn(theme: Theme, offset: number, pageSize: number, total: number): string[] {
  const rows = Math.max(1, Math.floor(pageSize))
  if (total <= rows) return Array.from({ length: rows }, () => ' ')
  const thumbSize = Math.max(1, Math.min(rows, Math.round((rows / total) * rows)))
  const maxThumbTop = Math.max(0, rows - thumbSize)
  const maxScroll = Math.max(1, total - rows)
  const top = Math.min(maxThumbTop, Math.max(0, Math.round((offset / maxScroll) * maxThumbTop)))
  const thumb = theme.fg('accent', '█')
  const track = theme.fg('dim', '│')
  return Array.from({ length: rows }, (_, i) => (i >= top && i < top + thumbSize ? thumb : track))
}

export function hasSubmitTab(questions: Question[]): boolean {
  return questions.length > 1 || questions.some((q) => q.multiSelect)
}

export function isAnswered(answer: Answer | undefined): boolean {
  return !!answer && (answer.selected.length > 0 || !!answer.freeform)
}

export function allAnswered(state: State): boolean {
  return state.questions.every((q) => isAnswered(state.answers[q.id]))
}

export function isSubmitTab(state: State): boolean {
  return state.tab === state.questions.length
}

function advance(state: State): State {
  if (!hasSubmitTab(state.questions)) return { ...state, outcome: 'submit' }
  return { ...state, tab: state.tab + 1, cursor: 0 }
}

function withAnswer(state: State, id: string, answer: Answer): State {
  return { ...state, answers: { ...state.answers, [id]: answer } }
}

export function reduce(state: State, action: Action): State {
  if (state.outcome) return state
  const tabCount = state.questions.length + (hasSubmitTab(state.questions) ? 1 : 0)
  const question = state.questions[state.tab]

  if (state.editing) {
    if (action.type === 'cancel') return { ...state, editing: false }
    if (action.type !== 'freeform' || !question) return state
    const text = action.text.trim() || undefined
    const previous = state.answers[question.id] ?? { selected: [] }
    if (question.multiSelect) {
      return { ...withAnswer(state, question.id, { selected: previous.selected, freeform: text }), editing: false }
    }
    const next = { ...withAnswer(state, question.id, { selected: [], freeform: text }), editing: false }
    return text ? advance(next) : next
  }

  switch (action.type) {
    case 'next':
    case 'prev': {
      if (tabCount <= 1) return state
      const step = action.type === 'next' ? 1 : -1
      return { ...state, tab: (state.tab + step + tabCount) % tabCount, cursor: 0 }
    }
    case 'cancel':
      return { ...state, outcome: 'cancel' }
    case 'freeform':
      return state
  }

  if (!question) {
    if (action.type === 'select' && allAnswered(state)) return { ...state, outcome: 'submit' }
    return state
  }

  const otherIndex = question.options.length
  switch (action.type) {
    case 'pick':
      if (action.index > otherIndex) return state
      return reduce({ ...state, cursor: action.index }, { type: 'select' })
    case 'up':
      return { ...state, cursor: Math.max(0, state.cursor - 1) }
    case 'down':
      return { ...state, cursor: Math.min(otherIndex, state.cursor + 1) }
    case 'toggle':
    case 'select': {
      if (state.cursor === otherIndex) return { ...state, editing: true }
      const option = question.options[state.cursor]
      if (!option) return state
      const label = option.label
      const previous = state.answers[question.id] ?? { selected: [] }
      if (question.multiSelect) {
        const selected = previous.selected.includes(label)
          ? previous.selected.filter((l) => l !== label)
          : [...previous.selected, label]
        return withAnswer(state, question.id, { ...previous, selected })
      }
      if (action.type === 'toggle') return state
      return advance(withAnswer(state, question.id, { selected: [label] }))
    }
  }
}

export function keyToAction(data: string): Action | undefined {
  if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return { type: 'next' }
  if (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left)) return { type: 'prev' }
  if (matchesKey(data, Key.up)) return { type: 'up' }
  if (matchesKey(data, Key.down)) return { type: 'down' }
  if (matchesKey(data, Key.enter)) return { type: 'select' }
  if (matchesKey(data, Key.space)) return { type: 'toggle' }
  if (matchesKey(data, Key.escape)) return { type: 'cancel' }
  if (/^[1-9]$/.test(data)) return { type: 'pick', index: Number(data) - 1 }
  return undefined
}

export function formatAnswers(questions: Question[], answers: Answers): string {
  return questions
    .map((q) => {
      const answer = answers[q.id] ?? { selected: [] }
      const parts = [...answer.selected]
      if (answer.freeform) parts.push(`user wrote: ${answer.freeform}`)
      return `${q.header}: ${parts.join('; ') || '(no answer)'}`
    })
    .join('\n')
}

export function validateQuestions(questions: Question[]): string | undefined {
  if (questions.length === 0) return 'No questions provided'
  const ids = new Set<string>()
  for (const q of questions) {
    if (ids.has(q.id)) return `Duplicate question id "${q.id}"`
    ids.add(q.id)
    if (q.options.length < 2) return `Question "${q.header}" needs at least 2 options`
    const labels = q.options.map((o) => o.label)
    const reserved = [q.otherLabel ?? DEFAULT_OTHER_LABEL, DONE]
    if (new Set(labels).size !== labels.length) return `Question "${q.header}" has duplicate option labels`
    const clash = labels.find((l) => reserved.includes(l))
    if (clash) return `Question "${q.header}" uses the reserved option label "${clash}"`
  }
  return undefined
}

export interface InterviewComponent extends Component {
  handleInput(data: string): void
  readonly state: State
}

export function createInterview(
  tui: TUI,
  theme: Theme,
  questions: Question[],
  onDone: (answers: Answers | undefined) => void,
): InterviewComponent {
  let state = initialState(questions)
  let cached: string[] | undefined
  let listScroll = 0
  let listMax = 0
  let lastWidth = 80
  let measured = false
  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg('accent', s),
    selectList: {
      selectedPrefix: (t) => theme.fg('accent', t),
      selectedText: (t) => theme.fg('accent', t),
      description: (t) => theme.fg('muted', t),
      scrollInfo: (t) => theme.fg('dim', t),
      noMatch: (t) => theme.fg('warning', t),
    },
  }
  const editor = new Editor(tui, editorTheme)

  function dispatch(action: Action) {
    const wasEditing = state.editing
    state = reduce(state, action)
    listScroll = 0
    if (state.editing && !wasEditing) {
      const q = state.questions[state.tab]
      editor.setText((q && state.answers[q.id]?.freeform) ?? '')
    }
    cached = undefined
    tui.requestRender()
    if (state.outcome === 'submit') onDone(state.answers)
    if (state.outcome === 'cancel') onDone(undefined)
  }

  editor.onSubmit = (text) => dispatch({ type: 'freeform', text })

  function render(width: number): string[] {
    if (cached) return cached
    const w = Math.max(1, width)
    const inner = Math.max(1, w - 2)
    lastWidth = w
    measured = true
    const head: string[] = []
    const options: string[] = []
    const after: string[] = []
    const add = (target: string[], prefix: string, text: string) => {
      const pw = visibleWidth(prefix)
      const wrapped = wrapTextWithAnsi(text, Math.max(1, inner - pw))
      wrapped.forEach((line, i) => target.push(`${i === 0 ? prefix : ' '.repeat(pw)}${line}`))
    }

    if (hasSubmitTab(questions)) {
      const tabs = questions.map((q, i) => {
        const done = isAnswered(state.answers[q.id])
        const text = ` ${done ? '■' : '□'} ${tabLabel(q.header)} `
        return i === state.tab
          ? theme.bg('selectedBg', theme.fg('text', text))
          : theme.fg(done ? 'success' : 'muted', text)
      })
      const submit = ' Submit '
      tabs.push(
        isSubmitTab(state)
          ? theme.bg('selectedBg', theme.fg('text', submit))
          : theme.fg(allAnswered(state) ? 'success' : 'dim', submit),
      )
      head.push(...layoutTabs(tabs, inner), '')
    }

    const q = questions[state.tab]
    if (!q) {
      add(head, ' ', theme.fg('accent', theme.bold('Review your answers')))
      head.push('')
      for (const question of questions) {
        const answer = state.answers[question.id]
        const parts = answer ? [...answer.selected, ...(answer.freeform ? [`"${answer.freeform}"`] : [])] : []
        add(options, ' ', `${theme.fg('muted', `${question.header}: `)}${theme.fg('text', parts.join(', ') || '-')}`)
      }
      after.push('')
      if (allAnswered(state)) add(after, ' ', theme.fg('success', 'Press Enter to submit'))
      else {
        const missing = questions.filter((x) => !isAnswered(state.answers[x.id])).map((x) => x.header)
        add(after, ' ', theme.fg('warning', `Unanswered: ${missing.join(', ')}`))
      }
    } else {
      add(head, ' ', theme.fg('text', theme.bold(q.question)))
      head.push('')
      const answer = state.answers[q.id]
      const rows = [...q.options, { label: q.otherLabel ?? DEFAULT_OTHER_LABEL, description: answer?.freeform }]
      rows.forEach((opt, i) => {
        const isOther = i === q.options.length
        const active = i === state.cursor
        const chosen = isOther ? !!answer?.freeform : !!answer?.selected.includes(opt.label)
        const mark = q.multiSelect && !isOther ? (chosen ? '[x] ' : '[ ] ') : chosen ? '* ' : ''
        const prefix = active ? theme.fg('accent', '> ') : '  '
        add(options, prefix, theme.fg(active ? 'accent' : 'text', `${i + 1}. ${mark}${opt.label}`))
        if (opt.description) add(options, '     ', theme.fg('muted', opt.description))
      })
      if (state.editing) {
        after.push('')
        for (const line of editor.render(Math.max(1, inner - 2))) after.push(` ${line}`)
      }
    }

    after.push('')
    const help = state.editing
      ? 'Enter save - Esc back'
      : `${hasSubmitTab(questions) ? 'Tab/Shift+Tab switch - ' : ''}Up/Down or 1-9 pick - Enter select${q?.multiSelect ? ' - Space toggle' : ''} - Esc cancel`
    add(after, ' ', theme.fg('dim', help))

    const budget = Math.max(1, tui.terminal.rows - head.length - after.length - 2)
    listMax = Math.max(0, options.length - budget)
    listScroll = Math.min(listScroll, listMax)
    const visible = options.slice(listScroll, listScroll + budget)
    const cells = scrollbarColumn(theme, listScroll, budget, options.length)
    const block = visible.map((line, i) => padLine(line, inner - 1) + (cells[i] ?? ' '))

    cached = frameLines(theme, [...head, ...block, ...after], w)
    return cached
  }

  return {
    get state() {
      return state
    },
    render,
    invalidate() {
      cached = undefined
    },
    handleInput(data: string) {
      if (state.editing && !matchesKey(data, Key.escape)) {
        editor.handleInput(data)
        cached = undefined
        tui.requestRender()
        return
      }
      const action = keyToAction(data)
      if (action) dispatch(action)
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type !== 'wheel') return undefined
      if (!measured) render(lastWidth)
      if (listMax > 0) {
        listScroll = Math.max(0, Math.min(listMax, listScroll + (event.wheelDelta ?? 0)))
        cached = undefined
        tui.requestRender()
      }
      return { handled: true }
    },
  }
}

async function fallbackInterview(ctx: ExtensionContext, questions: Question[]): Promise<Answers | undefined> {
  const answers: Answers = {}
  for (const q of questions) {
    const other = q.otherLabel ?? DEFAULT_OTHER_LABEL
    const selected: string[] = []
    for (;;) {
      const remaining = q.options.map((o) => o.label).filter((l) => !selected.includes(l))
      const choices = [...remaining, other, ...(q.multiSelect && selected.length ? [DONE] : [])]
      const title = q.multiSelect && selected.length ? `${q.question} (picked: ${selected.join(', ')})` : q.question
      const choice = await ctx.ui.select(title, choices)
      if (choice === undefined) return undefined
      if (choice === other) {
        const text = await ctx.ui.input(q.question)
        if (text === undefined) return undefined
        answers[q.id] = { selected: q.multiSelect ? selected : [], freeform: text.trim() || undefined }
        break
      }
      if (choice !== DONE) selected.push(choice)
      if (!q.multiSelect || choice === DONE || remaining.length === 1) {
        answers[q.id] = { selected }
        break
      }
    }
  }
  return answers
}

export async function interview(ctx: ExtensionContext, questions: Question[]): Promise<Answers | undefined> {
  const error = validateQuestions(questions)
  if (error) throw new Error(error)
  if (ctx.mode === 'tui') {
    return ctx.ui.custom<Answers | undefined>((tui, theme, _kb, done) => createInterview(tui, theme, questions, done))
  }
  if (ctx.hasUI) return fallbackInterview(ctx, questions)
  throw new Error('Interactive UI is not available in this mode')
}
