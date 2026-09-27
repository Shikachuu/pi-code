import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80
const MAX_ROWS = 8
const RECENT = 3

type Paint = Pick<Theme, 'fg' | 'bold'>

export interface ProgressState {
  label: string
  phase: string
  running: Map<string, string>
  finished: { label: string; failed: boolean }[]
  done: number
  failed: number
  tokens: number
}

export function formatTokens(n: number): string {
  if (Math.round(n / 1_000) >= 1_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function frameLine(left: string, fill: string, right: string, title: string, width: number, paint: Paint): string {
  const inner = Math.max(0, width - 2)
  const text = title ? truncateToWidth(` ${title} `, Math.max(0, inner - 1), '…') : ''
  const rest = Math.max(0, inner - 1 - visibleWidth(text))
  return paint.fg('border', `${left}${fill}`) + text + paint.fg('border', `${fill.repeat(rest)}${right}`)
}

function row(content: string, width: number, paint: Paint): string {
  const inner = Math.max(0, width - 4)
  const cut = truncateToWidth(content, inner, '…')
  const pad = ' '.repeat(Math.max(0, inner - visibleWidth(cut)))
  return `${paint.fg('border', '│')} ${cut}${pad} ${paint.fg('border', '│')}`
}

export function renderProgress(state: ProgressState, paint: Paint, width: number, frame: number): string[] {
  const spin = paint.fg('accent', SPINNER[frame % SPINNER.length] ?? '⠋')
  const title = `${paint.fg('accent', paint.bold(state.label))}${state.phase ? paint.fg('muted', ` · ${state.phase}`) : ''}`
  const rows: string[] = []
  for (const item of state.finished.slice(-RECENT)) {
    rows.push(
      item.failed
        ? `${paint.fg('error', '✗')} ${paint.fg('muted', item.label)}`
        : `${paint.fg('success', '✓')} ${paint.fg('dim', item.label)}`,
    )
  }
  const running = [...state.running.values()]
  const room = MAX_ROWS - rows.length
  for (const label of running.slice(0, running.length > room ? room - 1 : room)) rows.push(`${spin} ${label}`)
  if (running.length > room) rows.push(paint.fg('dim', `  +${running.length - room + 1} more running`))
  if (rows.length === 0) rows.push(`${spin} ${paint.fg('muted', 'starting…')}`)
  const stats = [
    paint.fg('success', `${state.done} done`),
    ...(state.failed ? [paint.fg('error', `${state.failed} failed`)] : []),
    paint.fg('accent', `${state.running.size} running`),
    paint.fg('muted', `${formatTokens(state.tokens)} tokens`),
    paint.fg('dim', 'esc to stop'),
  ].join(paint.fg('dim', ' · '))
  return [
    frameLine('╭', '─', '╮', title, width, paint),
    ...rows.map((r) => row(r, width, paint)),
    frameLine('╰', '─', '╯', stats, width, paint),
  ]
}

export function progressWidget(ctx: ExtensionContext, label: string) {
  const state: ProgressState = { label, phase: '', running: new Map(), finished: [], done: 0, failed: 0, tokens: 0 }
  let redraw = () => {}
  if (ctx.mode === 'tui') {
    ctx.ui.setWidget('sdd', (tui, theme) => {
      let frame = 0
      redraw = () => tui.requestRender()
      const timer = setInterval(() => {
        frame++
        tui.requestRender()
      }, FRAME_MS)
      return {
        render: (width: number) => renderProgress(state, theme, width, frame),
        invalidate() {},
        dispose: () => clearInterval(timer),
      }
    })
  } else if (ctx.hasUI) {
    const plain: Paint = { fg: (_c, s) => s, bold: (s) => s }
    redraw = () => ctx.ui.setWidget('sdd', renderProgress(state, plain, 80, 0))
    redraw()
  }
  return {
    state,
    options: {
      onPhase: (title: string) => {
        state.phase = title
        redraw()
      },
      onAgentStart: (e: { id: string; label: string }) => {
        state.running.set(e.id, e.label)
        redraw()
      },
      onAgentEnd: (e: { id: string; label: string; tokens?: number; error?: string }) => {
        state.running.delete(e.id)
        state.finished = [...state.finished, { label: e.label, failed: !!e.error }].slice(-RECENT)
        if (e.error) state.failed++
        else state.done++
        state.tokens += e.tokens ?? 0
        redraw()
      },
    },
    clear: () => ctx.hasUI && ctx.ui.setWidget('sdd', undefined),
  }
}
