import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Key, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { type Answers, createInterview, interview, type Question } from './interview.ts'

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
      return {
        render(width: number) {
          const body = markdown.render(width)
          const pickerLines = picker.render(width)
          const title = wrapTextWithAnsi(theme.fg('accent', theme.bold(doc.title)), Math.max(1, width - 1)).map(
            (l) => ` ${l}`,
          )
          const height = Math.max(5, tui.terminal.rows - pickerLines.length - title.length - 5)
          scroll = Math.min(scroll, Math.max(0, body.length - height))
          const end = Math.min(body.length, scroll + height)
          const rule = theme.fg('accent', '─'.repeat(Math.max(1, width)))
          const position =
            body.length > height
              ? truncateToWidth(
                  theme.fg('dim', ` lines ${scroll + 1}-${end} of ${body.length} - PgUp/PgDn scroll`),
                  width,
                )
              : ''
          return [rule, ...title, '', ...body.slice(scroll, end), position, rule, ...pickerLines]
        },
        invalidate() {
          markdown.invalidate()
          picker.invalidate()
        },
        handleInput(data: string) {
          const page = Math.max(1, tui.terminal.rows - 12)
          if (matchesKey(data, Key.pageDown)) scroll += page
          else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page)
          else return picker.handleInput(data)
          tui.requestRender()
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
