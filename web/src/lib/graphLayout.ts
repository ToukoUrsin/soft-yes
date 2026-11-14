// Deterministic three-column layout: soft yes -> rounds they followed -> who led.
// No simulation. Rounds sit in rows under their soft yes; leads sit beside the rounds they led.
// On a phone the first column folds away: each soft yes heads its own rounds, tied to them by a rail.

import type { GraphModel, GRound } from './walk'

export type Density = 'full' | 'mid' | 'compact'

export interface Dims {
  width: number
  density: Density
  /** phone: a soft yes is a heading row above its rounds, not a column beside them */
  stacked: boolean
  /** height of that heading row */
  headH: number
  rowH: number
  softLabelX: number
  softLabelW: number
  softX: number
  /** where the edge from a soft yes lands on a round row */
  r1: number
  roundLabelX: number
  roundLabelW: number
  /** where the edge to a lead leaves a round row */
  r2: number
  leadX: number
  leadLabelX: number
  leadLabelW: number
  padY: number
  groupGap: number
}

const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** The shortest row that still reads: 12px type with a little air. */
const MIN_ROW = 16

/**
 * `fit`: the height the rows may take so the whole walk shows without scrolling, and how many soft yeses share it.
 * Rows shrink to fit, down to a floor; a walk too long for that keeps its usual rows and scrolls.
 */
export function dims(width: number, rows: number, fit?: { height: number; groups: number }): Dims {
  const w = Math.max(300, width)
  if (w < 560) {
    const softX = 6
    const softLabelX = softX + 12
    const r1 = softX + 14
    const roundLabelX = r1 + 7
    const roundLabelW = clamp(96, w * 0.34, 150)
    const r2 = roundLabelX + roundLabelW + 5
    const leadX = r2 + clamp(40, w * 0.15, 64)
    const leadLabelX = leadX + 13
    return {
      width: w, density: 'compact', stacked: true, headH: 28, rowH: rows > 26 ? 21 : 24, softLabelX, softLabelW: r2 - softLabelX,
      softX, r1, roundLabelX, roundLabelW, r2, leadX, leadLabelX, leadLabelW: w - leadLabelX, padY: 4, groupGap: 12,
    }
  }
  const full = w >= 900
  const softLabelW = full ? 150 : 108
  const softX = softLabelW + 14
  const roundLabelW = full ? clamp(340, w * 0.36, 420) : clamp(196, w * 0.34, 300)
  const leadLabelW = full ? clamp(236, w * 0.25, 300) : clamp(150, w * 0.26, 230)
  const gap = Math.max(36, (w - softX - 10 - roundLabelW - 8 - 14 - leadLabelW) / 2)
  const r1 = softX + gap
  const roundLabelX = r1 + 10
  const r2 = roundLabelX + roundLabelW + 8
  const leadX = r2 + gap
  const leadLabelX = leadX + 14
  const usual = rows > 34 ? 20 : rows > 20 ? 24 : 28
  const room = fit && fit.height > 0 ? Math.floor((fit.height - 16 - 14 * Math.max(0, fit.groups - 1)) / Math.max(rows, 1)) : usual
  const rowH = room >= MIN_ROW ? Math.min(usual, room) : usual
  return {
    width: w, density: full ? 'full' : 'mid', stacked: false, headH: 0, softLabelX: 0, rowH, softLabelW, softX, r1, roundLabelX,
    roundLabelW, r2, leadX, leadLabelX, leadLabelW: Math.min(leadLabelW, w - leadLabelX), padY: 8, groupGap: 14,
  }
}

export interface Layout {
  /** y centre by node id: "s:<soft key>", "r:<round id>", "l:<lead key>" */
  y: Record<string, number>
  height: number
}

export function rowCount(model: GraphModel): number {
  let rows = 0
  for (const s of model.softs) {
    const own = model.rounds.filter((r) => r.softs[0] === s.key).length
    rows += Math.max(1, own, model.settled ? 0 : (s.walking ?? 0))
  }
  return Math.max(rows, model.leads.length, 1)
}

export function layout(model: GraphModel, d: Dims): Layout {
  const y: Record<string, number> = {}
  const rank = new Map(model.leads.map((l) => [l.key, l.rank ?? l.seq + 1]))
  const bestLead = (r: GRound) => (r.leads.length ? Math.min(...r.leads.map((k) => rank.get(k) ?? 999)) : 9999)

  let cursor = d.padY
  model.softs.forEach((s, gi) => {
    const own = model.rounds.filter((r) => r.softs[0] === s.key)
    if (model.settled) {
      // Rounds a lead led sit together, strongest lead first; rounds with no outside lead sink to the bottom.
      own.sort((a, b) => bestLead(a) - bestLead(b) || (b.brief.date ?? '').localeCompare(a.brief.date ?? '') || a.seq - b.seq)
    } else {
      own.sort((a, b) => a.seq - b.seq)
    }
    const slots = Math.max(d.stacked ? 0 : 1, own.length, model.settled ? 0 : (s.walking ?? 0))
    if (gi > 0) cursor += d.groupGap
    own.forEach((r, i) => {
      y[`r:${r.id}`] = cursor + d.headH + i * d.rowH + d.rowH / 2
    })
    y[`s:${s.key}`] = d.stacked ? cursor + d.headH / 2 : cursor + (slots * d.rowH) / 2
    cursor += d.headH + slots * d.rowH
  })
  const roundsBottom = cursor

  // Leads: in ranked order beside the rounds they led once settled, in order of appearance while the walk runs.
  const leads = [...model.leads]
  // On a phone a soft yes's name runs across the lead column, so a lead steps below that row. The graph grows by
  // the step when the column has no slack left.
  const heads = d.stacked ? model.softs.map((s) => y[`s:${s.key}`]) : []
  const band = (d.headH + d.rowH) / 2
  const below = (at: number) => {
    const head = heads.find((h) => Math.abs(at - h) < band)
    return head == null ? at : head + band
  }
  const pos: number[] = []
  if (model.settled) {
    const centre = (rounds: string[]) => {
      const ys = rounds.map((id) => y[`r:${id}`]).filter((v) => v != null)
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : roundsBottom
    }
    const want = new Map(leads.map((l) => [l.key, centre(l.rounds)]))
    // The column reads top to bottom as the ranking does; each lead still sits as near its rounds as that order allows.
    leads.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || want.get(a.key)! - want.get(b.key)!)
    leads.forEach((l, i) => {
      pos[i] = Math.max(want.get(l.key)!, i ? pos[i - 1] + d.rowH : d.padY + d.headH + d.rowH / 2)
    })
    const floor = Math.max(roundsBottom, d.padY + d.headH + leads.length * d.rowH) - d.rowH / 2
    for (let i = leads.length - 1; i >= 0; i--) {
      pos[i] = Math.min(pos[i], i === leads.length - 1 ? floor : pos[i + 1] - d.rowH)
    }
    // On a phone the column is the ranking, read as a list: no gaps, one lead a row.
    if (heads.length) {
      leads.forEach((_, i) => {
        pos[i] = below(i ? pos[i - 1] + d.rowH : d.padY + d.headH + d.rowH / 2)
      })
    }
  } else {
    leads.sort((a, b) => a.seq - b.seq)
    leads.forEach((_, i) => {
      pos[i] = below(i ? pos[i - 1] + d.rowH : d.padY + d.headH + d.rowH / 2)
    })
  }
  leads.forEach((l, i) => {
    y[`l:${l.key}`] = pos[i]
  })
  const leadsBottom = leads.length ? pos[leads.length - 1] + d.rowH / 2 : 0
  const height = Math.max(roundsBottom, leadsBottom) + d.padY
  return { y, height }
}

const f = (n: number) => Math.round(n * 10) / 10

/** A rail: straight down (or up) from a soft yes, then a short turn into the round's row. */
export function rail(x: number, y1: number, x2: number, y2: number): string {
  const dir = y2 >= y1 ? 1 : -1
  const k = Math.max(0, Math.min(5, Math.abs(y2 - y1), x2 - x))
  return `M${f(x)} ${f(y1)}V${f(y2 - dir * k)}Q${f(x)} ${f(y2)} ${f(x + k)} ${f(y2)}H${f(x2)}`
}

/** A horizontal S-curve between two points. */
export function link(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2
  return `M${f(x1)} ${f(y1)}C${f(mx)} ${f(y1)} ${f(mx)} ${f(y2)} ${f(x2)} ${f(y2)}`
}
