import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import {
  Key,
  Markdown,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

import {
  type Answers,
  createInterview,
  frameLines,
  interview,
  padLine,
  type Question,
  scrollbarColumn,
} from './interview.ts'

export const DOC_ENTRY = 'ask-doc'

export interface ReviewDoc {
  title: string
  markdown: string
}

export type ReviewResult = { action: 'accept' } | { action: 'revise'; feedback: string } | { action: 'cancel' }

export interface DocEntry extends ReviewDoc {
  status: string
}

const STATUS: Record<ReviewResult['action'], string> = {
  accept: 'accepted',
  revise: 'changes requested',
  cancel: 'cancelled',
}

export function showDocument(pi: ExtensionAPI, doc: ReviewDoc, status: string): void {
  pi.appendEntry<DocEntry>(DOC_ENTRY, { ...doc, status })
}

const ACCEPT = 'Accept'
const CANCEL = 'Cancel'

export function reviewQuestion(title: string): Question {
  return {
    id: 'review',
    header: 'Review',
    question: `Accept "${title}"?`,
    options: [
      { label: ACCEPT, description: 'Save it and continue' },
      { label: CANCEL, description: 'Discard it and stop' },
    ],
    otherLabel: 'Suggest changes',
  }
}

export function toReviewResult(answers: Answers | undefined): ReviewResult {
  const answer = answers?.review
  if (answer?.freeform) return { action: 'revise', feedback: answer.freeform }
  if (answer?.selected.includes(ACCEPT)) return { action: 'accept' }
  return { action: 'cancel' }
}

export async function reviewDocument(pi: ExtensionAPI, ctx: ExtensionContext, doc: ReviewDoc): Promise<ReviewResult> {
  const question = reviewQuestion(doc.title)
  let answers: Answers | undefined
  if (ctx.mode === 'tui') {
    answers = await ctx.ui.custom<Answers | undefined>((tui, theme, _kb, done) => {
      const markdown = new Markdown(doc.markdown, 1, 0, getMarkdownTheme())
      const picker = createInterview(tui, theme, [question], done)
      let scroll = 0
      let bodyLength = 0
      let bodyHeight = 5
      let lastWidth = 80
      let measured = false
      function render(width: number): string[] {
        const w = Math.max(1, width)
        lastWidth = w
        measured = true
        const bodyWidth = Math.max(1, w - 3)
        const body = markdown.render(bodyWidth)
        const pickerLines = picker.render(w)
        const title = wrapTextWithAnsi(theme.fg('accent', theme.bold(doc.title)), Math.max(1, w - 3)).map(
          (l) => ` ${l}`,
        )
        bodyLength = body.length
        bodyHeight = Math.max(5, tui.terminal.rows - pickerLines.length - title.length - 5)
        scroll = Math.min(scroll, Math.max(0, body.length - bodyHeight))
        const end = Math.min(body.length, scroll + bodyHeight)
        const cells = scrollbarColumn(theme, scroll, bodyHeight, body.length)
        const bodyLines = body.slice(scroll, end).map((line, i) => padLine(line, bodyWidth) + (cells[i] ?? ' '))
        return [...frameLines(theme, [...title, '', ...bodyLines], w), ...pickerLines]
      }
      return {
        render,
        invalidate() {
          markdown.invalidate()
          picker.invalidate()
        },
        handleInput(data: string) {
          const page = Math.max(1, tui.terminal.rows - 12)
          if (matchesKey(data, Key.pageDown)) scroll += page
          else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page)
          else return picker.handleInput(data)
          scroll = Math.min(scroll, Math.max(0, bodyLength - bodyHeight))
          tui.requestRender()
        },
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
          if (event.type !== 'wheel') return undefined
          if (!measured) render(lastWidth)
          scroll = Math.max(0, Math.min(scroll + (event.wheelDelta ?? 0), Math.max(0, bodyLength - bodyHeight)))
          tui.requestRender()
          return { handled: true }
        },
      }
    })
  } else {
    answers = await interview(ctx, [question])
  }
  const result = toReviewResult(answers)
  showDocument(pi, doc, STATUS[result.action])
  return result
}
