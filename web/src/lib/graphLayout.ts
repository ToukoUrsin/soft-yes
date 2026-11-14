// Deterministic three-column layout: soft yes -> rounds they followed -> who led.
// No simulation. Rounds sit in rows under their soft yes; leads sit beside the rounds they led.

import type { GraphModel, GRound } from './walk'

export type Density = 'full' | 'mid' | 'compact'

export interface Dims {
  width: number
  density: Density
  rowH: number
  /** right edge of the soft-yes label */
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

export function dims(width: number, rows: number): Dims {
  const w = Math.max(300, width)
  if (w < 560) {
    const softLabelW = 68
    const softX = softLabelW + 12
    const gap = 20
    const r1 = softX + gap
    const roundLabelX = r1 + 7
    const roundLabelW = clamp(84, w * 0.27, 120)
    const r2 = roundLabelX + roundLabelW + 5
    const leadX = r2 + gap + 2
    const leadLabelX = leadX + 13
    return {
      width: w, density: 'compact', rowH: rows > 26 ? 20 : 24, softLabelW, softX, r1, roundLabelX, roundLabelW, r2, leadX,
      leadLabelX, leadLabelW: w - leadLabelX, padY: 6, groupGap: 10,
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
  return {
    width: w, density: full ? 'full' : 'mid', rowH: rows > 34 ? 20 : rows > 20 ? 24 : 28, softLabelW, softX, r1, roundLabelX,
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
    const slots = Math.max(1, own.length, model.settled ? 0 : (s.walking ?? 0))
    if (gi > 0) cursor += d.groupGap
    own.forEach((r, i) => {
      y[`r:${r.id}`] = cursor + i * d.rowH + d.rowH / 2
    })
    y[`s:${s.key}`] = cursor + (slots * d.rowH) / 2
    cursor += slots * d.rowH
  })
  const roundsBottom = cursor

  // Leads: beside the rounds they led once settled, in order of appearance while the walk runs.
  const leads = [...model.leads]
  if (model.settled) {
    const centre = (rounds: string[]) => {
      const ys = rounds.map((id) => y[`r:${id}`]).filter((v) => v != null)
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : roundsBottom
    }
    const want = new Map(leads.map((l) => [l.key, centre(l.rounds)]))
    leads.sort((a, b) => want.get(a.key)! - want.get(b.key)! || (a.rank ?? 999) - (b.rank ?? 999))
    const pos: number[] = []
    leads.forEach((l, i) => {
      pos[i] = Math.max(want.get(l.key)!, i ? pos[i - 1] + d.rowH : d.padY + d.rowH / 2)
    })
    const floor = Math.max(roundsBottom, d.padY + leads.length * d.rowH) - d.rowH / 2
    for (let i = leads.length - 1; i >= 0; i--) {
      pos[i] = Math.min(pos[i], i === leads.length - 1 ? floor : pos[i + 1] - d.rowH)
    }
    leads.forEach((l, i) => {
      y[`l:${l.key}`] = pos[i]
    })
  } else {
    leads.sort((a, b) => a.seq - b.seq)
    leads.forEach((l, i) => {
      y[`l:${l.key}`] = d.padY + i * d.rowH + d.rowH / 2
    })
  }
  const height = Math.max(roundsBottom, d.padY + leads.length * d.rowH) + d.padY
  return { y, height }
}

/** A horizontal S-curve between two points. */
export function link(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2
  const f = (n: number) => Math.round(n * 10) / 10
  return `M${f(x1)} ${f(y1)}C${f(mx)} ${f(y1)} ${f(mx)} ${f(y2)} ${f(x2)} ${f(y2)}`
}
