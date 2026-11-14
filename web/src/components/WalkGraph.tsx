import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dims, layout, link, rail, rowCount } from '../lib/graphLayout'
import { capped, fmtMoney, fmtMonth, plural } from '../lib/format'
import type { GraphModel, GLead } from '../lib/walk'

type Focus = { type: 'soft' | 'round' | 'lead'; id: string } | null

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Glide nodes to a new layout. Nodes that are new simply appear in place. */
function useTweenedY(target: Record<string, number>, frame: unknown): Record<string, number> {
  const [ys, setYs] = useState(target)
  const cur = useRef(target)
  const lastFrame = useRef(frame)
  useEffect(() => {
    const from = cur.current
    // A new width is a new drawing, not a move: the first measure and a rotated phone snap into place.
    const resized = lastFrame.current !== frame
    lastFrame.current = frame
    let moves = false
    for (const k in target) {
      if (from[k] != null && Math.abs(from[k] - target[k]) > 0.5) {
        moves = true
        break
      }
    }
    if (!moves || resized || reduceMotion()) {
      cur.current = target
      setYs(target)
      return
    }
    const t0 = performance.now()
    const dur = 760
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - p, 4)
      const next: Record<string, number> = {}
      for (const k in target) next[k] = from[k] == null ? target[k] : from[k] + (target[k] - from[k]) * e
      cur.current = next
      setYs(next)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])
  return ys
}

function leadRadius(l: GLead, compact: boolean, rowH: number): number {
  const n = Math.min(l.rounds.length, 5)
  // never taller than its row, so two busy leads on neighbouring rows do not touch
  return Math.min((compact ? 3 : 3.75) + n * (compact ? 0.75 : 1.1), (rowH - 3) / 2)
}

export function WalkGraph({
  model, live, selected, onSelect,
}: {
  model: GraphModel
  /** the walk is being played: nodes and edges draw in */
  live: boolean
  selected: string | null
  onSelect?: (leadKey: string) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [focus, setFocus] = useState<Focus>(null)
  const legend = useRef<HTMLParagraphElement>(null)
  /** how tall the rows may be for the whole walk to show without scrolling */
  const [room, setRoom] = useState(0)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      setWidth(el.clientWidth)
      const top = el.getBoundingClientRect().top + window.scrollY
      const below = legend.current ? legend.current.offsetHeight + 12 : 38
      const h = Math.round(window.innerHeight - top - 33 - below - 12)
      setRoom((was) => (Math.abs(was - h) > 2 ? h : was))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(document.body)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const rows = rowCount(model)
  const groups = model.softs.length
  const d = useMemo(() => dims(width || 1136, rows, { height: room, groups }), [width, rows, room, groups])
  const target = useMemo(() => layout(model, d), [model, d])
  const tween = useTweenedY(target.y, d.width)
  const y = (id: string) => tween[id] ?? target.y[id] ?? 0

  const roundById = useMemo(() => new Map(model.rounds.map((r) => [r.id, r])), [model.rounds])

  // What a hover (or the selected lead) lights up.
  const lit = useMemo(() => {
    const at: Focus = focus ?? (selected && model.settled ? { type: 'lead', id: selected } : null)
    if (!at) return null
    const softs = new Set<string>()
    const rounds = new Set<string>()
    const leads = new Set<string>()
    if (at.type === 'lead') {
      const l = model.leads.find((x) => x.key === at.id)
      if (!l) return null
      leads.add(l.key)
      for (const id of l.rounds) {
        rounds.add(id)
        roundById.get(id)?.softs.forEach((s) => softs.add(s))
      }
    } else if (at.type === 'round') {
      const r = roundById.get(at.id)
      if (!r) return null
      rounds.add(r.id)
      r.softs.forEach((s) => softs.add(s))
      r.leads.forEach((k) => leads.add(k))
    } else {
      softs.add(at.id)
      for (const r of model.rounds) {
        if (r.softs.includes(at.id)) {
          rounds.add(r.id)
          r.leads.forEach((k) => leads.add(k))
        }
      }
    }
    return { softs, rounds, leads, hover: !!focus, lead: at.type === 'lead' ? at.id : null }
  }, [focus, selected, model, roundById])

  const dimmed = (on: boolean) => (lit?.hover && !on ? ' is-dim' : '')
  const hot = (on: boolean) => (lit && on ? ' is-hot' : '')
  const compact = d.density === 'compact'
  const softR = compact ? 4.5 : 5.5

  // On a phone a round sits under one soft yes and hangs from its rail alone; a second soft yes is told by the port.
  const softEdges = model.rounds.flatMap((r) =>
    (d.stacked ? r.softs.slice(0, 1) : r.softs).map((s) => {
      const on = !!lit && lit.softs.has(s) && lit.rounds.has(r.id)
      const sy = y(`s:${s}`)
      const ry = y(`r:${r.id}`)
      const path = d.stacked
        ? rail(d.softX, sy + (ry >= sy ? 1 : -1) * (softR + 2), d.r1 - 3, ry)
        : link(d.softX + softR + 2, sy, d.r1 - 3, ry)
      return { key: `${s}:${r.id}`, d: path, on }
    }),
  )
  const leadEdges = model.rounds.flatMap((r) =>
    r.leads.map((k) => {
      const l = model.leads.find((x) => x.key === k)
      const on = !!lit && lit.rounds.has(r.id) && lit.leads.has(k) && (lit.lead ? lit.lead === k : true)
      return { key: `${r.id}:${k}`, d: link(d.r2 + 3, y(`r:${r.id}`), d.leadX - (l ? leadRadius(l, compact, d.rowH) : 4) - 3, y(`l:${k}`)), on }
    }),
  )
  // Lit edges paint last so they sit on top.
  softEdges.sort((a, b) => Number(a.on) - Number(b.on))
  leadEdges.sort((a, b) => Number(a.on) - Number(b.on))

  const leadCount = model.leads.length
  const roundCount = model.rounds.length
  const heads = compact
    ? ['Said yes', 'Rounds they followed', 'Led by']
    : ['Said yes', 'Rounds they joined without leading', 'Who led them']

  return (
    <div
      ref={wrap}
      className={`graph graph--${d.density}${d.rowH < 22 && !d.stacked ? ' graph--tight' : ''}${live ? ' graph--live' : ''}${model.settled ? ' graph--settled' : ''}`}
      onMouseLeave={() => setFocus(null)}
    >
      <div className="graph__heads" aria-hidden="true">
        {!d.stacked && <span style={{ left: 0, width: d.softX + softR, textAlign: 'right' }}>{heads[0]}</span>}
        <span style={{ left: d.stacked ? 0 : d.roundLabelX }}>
          {heads[1]}
          {roundCount > 0 && <b className="num">{roundCount}</b>}
        </span>
        <span style={{ left: d.leadLabelX }}>
          {heads[2]}
          {leadCount > 0 && <b className="num">{leadCount}</b>}
        </span>
      </div>

      <div className="graph__body" style={{ height: target.height }}>
        <svg className="graph__svg" width={d.width} height={target.height} aria-hidden="true">
          <g>
            {softEdges.map((e) => (
              <path key={e.key} className={`edge edge--soft${hot(e.on)}${dimmed(e.on)}`} d={e.d} pathLength={1} />
            ))}
          </g>
          <g>
            {leadEdges.map((e) => (
              <path key={e.key} className={`edge edge--lead${hot(e.on)}${dimmed(e.on)}`} d={e.d} pathLength={1} />
            ))}
          </g>
          <g>
            {model.rounds.map((r) => {
              const on = !!lit && lit.rounds.has(r.id)
              const cy = y(`r:${r.id}`)
              return (
                <g key={r.id} className={`gport${r.leads.length ? '' : ' is-none'}${dimmed(on)}`}>
                  <circle cx={d.r1} cy={cy} r={1.75} className="gport__in" />
                  {d.stacked && r.softs.length > 1 && <circle cx={d.r1} cy={cy} r={4} className="gport__also" />}
                  {r.leads.length > 0 && <circle cx={d.r2} cy={cy} r={1.75} className="gport__out" />}
                </g>
              )
            })}
          </g>
          <g>
            {model.softs.map((s) => {
              const on = !!lit && lit.softs.has(s.key)
              return (
                <circle
                  key={s.key}
                  cx={d.softX}
                  cy={y(`s:${s.key}`)}
                  r={softR}
                  className={`gsoft${s.read ? ' is-read' : ''}${hot(on)}${dimmed(on)}`}
                />
              )
            })}
          </g>
          <g>
            {model.leads.map((l) => {
              const on = !!lit && lit.leads.has(l.key)
              const cy = y(`l:${l.key}`)
              const r = leadRadius(l, compact, d.rowH)
              return (
                <g key={l.key} className={`glead${l.pulse && l.pulse.rounds > 0 ? ' is-read' : ''}${dimmed(on)}`}>
                  {selected === l.key && model.settled && <circle cx={d.leadX} cy={cy} r={r + 3.5} className="glead__sel" />}
                  {l.pulse && l.pulse.rounds > 0 && <circle cx={d.leadX} cy={cy} r={r} className="glead__burst" />}
                  <circle cx={d.leadX} cy={cy} r={r} className="glead__dot" />
                </g>
              )
            })}
          </g>
        </svg>

        {model.softs.map((s) => {
          const on = !!lit && lit.softs.has(s.key)
          // Nothing in Cala's graph, yet rounds hang under it: the second pass found them in reports. Say that, not "no rounds".
          const drawn = model.rounds.filter((r) => r.softs.includes(s.key))
          const own = s.rounds ? [] : drawn
          // Rounds the reports added sit under it too, so the count on the node says where the extra ones came from.
          const extra = s.rounds ? drawn.filter((r) => r.via === 'knowledge').length : 0
          const sub = !s.read
            ? 'reading'
            : s.rounds
              ? `${capped(s.rounds, s.capped)} rounds in Cala, led ${s.led ?? 0}`
              : own.length && own.every((r) => r.via === 'knowledge')
                ? `${plural(own.length, 'round')} from reports`
                : 'no rounds in Cala'
          // A phone heading may run across the lead column when no lead sits on its row.
          const sy = target.y[`s:${s.key}`] ?? 0
          const clear = d.stacked && !model.leads.some((l) => Math.abs((target.y[`l:${l.key}`] ?? -99) - sy) < (d.headH + d.rowH) / 2)
          return (
            <div
              key={s.key}
              className={`gl gl--soft${dimmed(on)}`}
              style={{ width: clear ? d.width - d.softLabelX : d.softLabelW, transform: `translate(${d.softLabelX}px, ${y(`s:${s.key}`)}px) translateY(-50%)` }}
              onMouseEnter={() => setFocus({ type: 'soft', id: s.key })}
            >
              <span className="gl__name truncate" title={s.name}>{s.name}</span>
              <span className="gl__sub num truncate">{sub}</span>
              {extra > 0 && <span className="gl__sub num truncate">{extra} more from reports</span>}
            </div>
          )
        })}

        {model.rounds.map((r) => {
          const on = !!lit && lit.rounds.has(r.id)
          const b = r.brief
          const name = b.issuer?.name ?? 'Unnamed company'
          const stage = b.stage && b.stage_name ? b.stage_name : ''
          const money = fmtMoney(b.amount, b.currency)
          const when = fmtMonth(b.date)
          const none = r.leads.length === 0
          const mark = r.via === 'knowledge' ? 'report' : r.relation === 'cap_table' ? 'backs it' : ''
          const also = r.softs.slice(1).map((k) => model.softs.find((x) => x.key === k)?.name).filter(Boolean)
          const title = [name, stage, money, when].filter(Boolean).join(', ') + (none ? '. No outside lead in Cala.' : '') +
            (also.length ? ` Also joined by ${also.join(' and ')}.` : '') +
            (r.via === 'knowledge' ? ' Found in a report by Cala’s knowledge search.' : r.relation === 'cap_table' ? ' The investor backs this company; Cala does not list it in this round.' : '')
          return (
            <div
              key={r.id}
              className={`gl gl--round${none ? ' is-none' : ''}${hot(on)}${dimmed(on)}`}
              style={{ width: d.roundLabelW, height: d.rowH, transform: `translate(${d.roundLabelX}px, ${y(`r:${r.id}`) - d.rowH / 2}px)` }}
              title={title}
              onMouseEnter={() => setFocus({ type: 'round', id: r.id })}
            >
              <span className="gl__co truncate">{name}</span>
              {d.stacked && also.length > 0 && <span className="sr-only">, also joined by {also.join(' and ')}</span>}
              {!compact && <span className={`gl__stage truncate${!stage && mark ? ' gl__stage--via' : ''}`}>{stage || mark}</span>}
              {!compact && <span className="gl__amt num">{money}</span>}
              {d.density === 'full' && <span className="gl__when num">{when}</span>}
            </div>
          )
        })}

        {model.leads.map((l) => {
          const on = !!lit && lit.leads.has(l.key)
          // Read, and Cala's graph held nothing under this name: the lead is known from a report alone.
          const bare = !!l.pulse && l.pulse.rounds === 0
          const sub = bare
            ? 'known from a report'
            : l.pulse
              ? `led ${l.pulse.led} of ${capped(l.pulse.rounds, l.pulse.capped)}${d.density === 'full' && l.lastLed ? `, last ${fmtMonth(l.lastLed)}` : ''}`
              : model.settled
                ? 'record not read'
                : ''
          const title = `${l.name}: led ${plural(l.rounds.length, 'round')} here${bare ? '; no rounds under this name in Cala’s graph' : l.pulse ? `; led ${l.pulse.led} of its ${capped(l.pulse.rounds, l.pulse.capped)} rounds in Cala` : ''}`
          return (
            <button
              key={l.key}
              type="button"
              className={`gl gl--lead${selected === l.key && model.settled ? ' is-selected' : ''}${l.pulse && !bare ? ' is-read' : ''}${dimmed(on)}`}
              style={{
                width: d.leadLabelW + 6, height: d.rowH - 4,
                transform: `translate(${d.leadLabelX - 6}px, ${y(`l:${l.key}`) - (d.rowH - 4) / 2}px)`,
              }}
              title={title}
              onMouseEnter={() => setFocus({ type: 'lead', id: l.key })}
              onFocus={() => setFocus({ type: 'lead', id: l.key })}
              onBlur={() => setFocus(null)}
              onClick={() => onSelect?.(l.key)}
              disabled={!model.settled}
            >
              {model.settled && l.rank != null && (
                <span className="gl__rank num" style={{ animationDelay: `${Math.min(l.rank, 20) * 28}ms` }}>{l.rank}</span>
              )}
              <span className="gl__name truncate">{l.name}</span>
              {!compact && sub && <span className="gl__sub num">{sub}</span>}
            </button>
          )
        })}
      </div>

      {model.softs.length > 0 && <p className="graph__legend" ref={legend}>
        <span><i className="lg lg--soft" />{compact ? 'said yes' : 'said yes, wants a lead'}</span>
        <span><i className="lg lg--lead" />{compact ? 'led, record read' : 'led a round they joined, own record read'}</span>
        <span><i className="lg lg--unread" />{compact ? 'led, not read' : 'led a round, own record not read'}</span>
        {d.stacked && model.rounds.some((r) => r.softs.length > 1) && <span><i className="lg lg--also" />joined by two of them</span>}
        {model.rounds.some((r) => !r.leads.length) && <span className="graph__legend-dim">Dimmed rounds have no outside lead in Cala</span>}
        {model.rounds.some((r) => r.via === 'knowledge') && <span className="graph__legend-dim">“report”: found by Cala’s knowledge search in the page cited</span>}
      </p>}
    </div>
  )
}
