// The walk, drawn: your investors, the rounds they joined, who led them, and each "led" read against the page
// Cala cites. A confirmed claim gets its tick, a claim the page does not bear out is struck through.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { say, tell } from './bridge'
import { type Fix, type Lead, type Round, type Soft, type WalkData, listAnd, month, num, ok, plural, reduced, roundName, wrong } from './lib'
import { Btn, Count, Head, Icon, Ledger, Link, Quote, Src, useWidth } from './ui'

interface LeadRow { key: string; name: string; state: 'ok' | 'wrong' | 'open'; page?: string[]; rank?: number; quote?: string; publisher?: string; struckFor?: string }
interface Plan { softs: Soft[]; rounds: Round[]; leads: LeadRow[]; hiddenRounds: number }

/** Which rounds and leads the drawing shows: the first leads on the list, and never without a struck claim when there is one. */
function plan(d: WalkData, maxRounds: number, maxLeads: number): Plan {
  const rank = new Map(d.leads.map((l) => [l.key, l.rank ?? 99]))
  const best = (r: Round) => Math.min(99, ...r.leads.filter((l) => !wrong(l.status)).map((l) => rank.get(l.key) ?? 99))
  const fixed = (r: Round) => r.leads.some((l) => wrong(l.status))
  const score = (r: Round) => (100 - best(r)) * 6 + r.soft.length * 3 + r.leads.filter((l) => ok(l.status)).length * 2
  const order = [...d.rounds].sort((a, b) => score(b) - score(a))
  const withFix = order.filter(fixed).slice(0, 2)
  const rounds: Round[] = []
  const keys: string[] = []
  const take = (r: Round) => {
    if (rounds.includes(r) || rounds.length >= maxRounds) return
    const add = r.leads.map((l) => l.key).filter((k) => !keys.includes(k))
    if (keys.length + add.length > maxLeads) return
    rounds.push(r)
    keys.push(...add)
  }
  order.slice(0, 2).forEach(take)   // the first lead's rounds always
  withFix.forEach(take)
  order.forEach(take)

  const quoteOf = new Map<string, { quote?: string; publisher?: string }>()
  for (const l of d.leads) for (const e of l.evidence) if (e.quote) quoteOf.set(`${e.id}:${l.key}`, { quote: e.quote, publisher: e.publisher ?? undefined })
  for (const f of d.fixes) if (f.quote && f.round) quoteOf.set(`${f.round}:fix`, { quote: f.quote, publisher: f.publisher })

  const rows = new Map<string, LeadRow>()
  for (const r of rounds) {
    for (const l of r.leads) {
      const row = rows.get(l.key) ?? { key: l.key, name: l.name, state: 'open' as const, rank: rank.get(l.key) }
      if (ok(l.status)) row.state = 'ok'
      else if (wrong(l.status) && row.state !== 'ok') { row.state = 'wrong'; row.page = l.page }
      const q = quoteOf.get(`${r.id}:${l.key}`) ?? (wrong(l.status) ? quoteOf.get(`${r.id}:fix`) : undefined)
      if (q?.quote && !row.quote) { row.quote = q.quote; row.publisher = q.publisher }
      rows.set(l.key, row)
    }
  }
  const leads = [...rows.values()].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.name.localeCompare(b.name))
  // a struck name sits right under the lead the page gives in its place, when that lead is drawn
  for (const row of leads.filter((x) => x.state === 'wrong')) {
    const pageKey = (row.page ?? []).map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''))
    const at = leads.findIndex((x) => x !== row && pageKey.some((k) => x.key === k || x.key.startsWith(k) || k.startsWith(x.key)))
    if (at >= 0) {
      leads.splice(leads.indexOf(row), 1)
      leads.splice(leads.findIndex((x) => pageKey.some((k) => x.key === k || x.key.startsWith(k) || k.startsWith(x.key))) + 1, 0, row)
    }
  }
  const at = new Map(leads.map((l, i) => [l.key, i]))
  rounds.sort((a, b) => Math.min(...a.leads.map((l) => at.get(l.key) ?? 99)) - Math.min(...b.leads.map((l) => at.get(l.key) ?? 99))
    || (b.date ?? '').localeCompare(a.date ?? ''))
  return { softs: d.softs, rounds, leads, hiddenRounds: Math.max(0, (d.rounds_walked ?? d.rounds.length) - rounds.length) }
}

const PHASE = { rest: 0, softs: 1, rounds: 2, leads: 3, check: 4, done: 5 } as const

function Graph({ d, p, phase, checked, hot, setHot, onLead, width, roomy }: {
  d: WalkData; p: Plan; phase: number; checked: number; hot: string | null; setHot: (k: string | null) => void
  onLead: (key: string) => void; width: number; roomy: boolean
}) {
  const wide = width >= 560
  const rowL = 30
  const rowI = 44
  const rowR = wide ? 30 : Math.max(9, Math.min(20, ((roomy ? 16 : 7) * rowL) / Math.max(1, p.rounds.length)))
  const top = 26
  const H = top + Math.max(p.softs.length * rowI, p.rounds.length * rowR, p.leads.length * rowL, 120) + 6
  const col = wide
    ? { i: [0, width * 0.24], r: [width * 0.31, width * 0.63], l: [width * 0.7, width] }
    : { i: [0, width * 0.32], r: [width * 0.41, width * 0.41], l: [width * 0.5, width] }
  const yOf = (n: number, i: number, h: number) => top + (H - top - 6 - n * h) / 2 + i * h + h / 2
  const yI = (i: number) => yOf(p.softs.length, i, rowI)
  const yR = (i: number) => yOf(p.rounds.length, i, rowR)
  const yL = (i: number) => yOf(p.leads.length, i, rowL)
  const softAt = new Map(p.softs.map((s, i) => [s.key, i]))
  const leadAt = new Map(p.leads.map((l, i) => [l.key, i]))
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.5
    return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }

  // what lights up with the row under the pointer
  const lit = useMemo(() => {
    if (!hot) return null
    const [kind, key] = hot.split(':')
    const rs = p.rounds.filter((r) => (kind === 'r' ? r.id === key : kind === 's' ? r.soft.includes(key) : r.leads.some((l) => l.key === key)))
    return {
      rounds: new Set(rs.map((r) => r.id)),
      softs: new Set(kind === 's' ? [key] : rs.flatMap((r) => r.soft)),
      leads: new Set(kind === 'l' ? [key] : rs.flatMap((r) => r.leads.map((l) => l.key))),
      only: kind === 'l' || kind === 's' ? key : null, kind,
    }
  }, [hot, p])

  const links: { d: string; cls: string; delay: number; on: boolean }[] = []
  p.rounds.forEach((r, ri) => {
    for (const s of r.soft) {
      const si = softAt.get(s)
      if (si == null) continue
      const on = !lit || (lit.rounds.has(r.id) && (lit.kind !== 's' || lit.only === s))
      links.push({ d: curve(col.i[1] + 5, yI(si), col.r[0] - 5, yR(ri)), cls: 'lk lk--a', delay: ri * 55, on })
    }
    for (const l of r.leads) {
      const li = leadAt.get(l.key)
      if (li == null) continue
      const on = !lit || (lit.rounds.has(r.id) && (lit.kind !== 'l' || lit.only === l.key))
      const seen = phase >= PHASE.done || (phase === PHASE.check && li <= checked)
      const st = seen ? (ok(l.status) ? ' is-ok' : wrong(l.status) ? ' is-wrong' : ' is-open') : ''
      links.push({ d: curve(col.r[1] + 5, yR(ri), col.l[0] - 5, yL(li)), cls: `lk lk--b${st}`, delay: li * 70, on })
    }
  })

  const src = (s: Soft) => (s.from === 'inbox' ? 'inbox' : s.from === 'cala' ? 'cala' : 'typed')
  return (
    <div class={`g g--p${phase}${wide ? '' : ' g--narrow'}${lit ? ' has-hot' : ''}`} style={{ height: `${H}px` }}
      onMouseLeave={() => setHot(null)}>
      <svg class="g__links" width={width} height={H} aria-hidden="true">
        {links.map((l, i) => <path key={i} d={l.d} pathLength={1} class={`${l.cls}${l.on ? '' : ' is-dim'}`} style={{ '--d': `${l.delay}ms` }} />)}
      </svg>
      <span class="g__h" style={{ left: 0, width: `${col.i[1]}px`, textAlign: 'right' }}>Said yes</span>
      <span class="g__h g__h--mid" style={wide ? { left: `${col.r[0]}px` } : { left: `${col.r[0] - 60}px`, width: '120px', textAlign: 'center' }}>
        {wide ? 'Rounds they joined' : 'Rounds'}
      </span>
      <span class="g__h" style={{ left: `${col.l[0]}px` }}>Who led</span>

      {p.softs.map((s, i) => (
        <button key={s.key} type="button" class={`n n--soft${lit && !lit.softs.has(s.key) ? ' is-dim' : ''}`}
          style={{ top: `${yI(i) - rowI / 2}px`, height: `${rowI}px`, left: 0, width: `${col.i[1]}px`, '--i': i }}
          onMouseEnter={() => setHot(`s:${s.key}`)} onFocus={() => setHot(`s:${s.key}`)} onClick={() => setHot(hot === `s:${s.key}` ? null : `s:${s.key}`)}
          title={s.said ? `"${s.said}"${s.person ? ` ${s.person}` : ''}` : s.insight}>
          <span class="n__t">
            <b class="n__name">{s.name}</b>
            <span class="n__sub"><Icon name={src(s)} size={11} />{s.from === 'inbox' ? (s.person ? s.person : 'your inbox') : s.from === 'cala' ? 'in your round' : 'you named it'}</span>
          </span>
          <i class="n__dot" />
        </button>
      ))}

      {p.rounds.map((r, i) => (
        <button key={r.id} type="button" class={`n n--round${lit && !lit.rounds.has(r.id) ? ' is-dim' : ''}`}
          style={wide ? { top: `${yR(i) - rowR / 2}px`, height: `${rowR}px`, left: `${col.r[0]}px`, width: `${col.r[1] - col.r[0]}px`, '--i': i }
            : { top: `${yR(i) - 5}px`, height: '10px', left: `${col.r[0] - 5}px`, width: '10px', '--i': i }}
          onMouseEnter={() => setHot(`r:${r.id}`)} onFocus={() => setHot(`r:${r.id}`)} onClick={() => setHot(hot === `r:${r.id}` ? null : `r:${r.id}`)}
          title={roundName(r)} aria-label={roundName(r)}>
          <i class="n__dot" />
          {wide && <span class="n__t"><b class="n__name">{r.company}</b><span class="n__sub">{[r.stage_name, month(r.date)].filter(Boolean).join(' · ')}</span></span>}
          {wide && <i class="n__dot" />}
        </button>
      ))}

      {p.leads.map((l, i) => {
        const seen = phase >= PHASE.done || (phase === PHASE.check && i <= checked)
        const state = seen ? l.state : 'wait'
        return (
          <button key={l.key} type="button"
            class={`n n--lead is-${state}${phase === PHASE.check && i === checked ? ' is-reading' : ''}${lit && !lit.leads.has(l.key) ? ' is-dim' : ''}`}
            style={{ top: `${yL(i) - rowL / 2}px`, height: `${rowL}px`, left: `${col.l[0]}px`, width: `${col.l[1] - col.l[0]}px`, '--i': i }}
            onMouseEnter={() => setHot(`l:${l.key}`)} onFocus={() => setHot(`l:${l.key}`)}
            onClick={() => { setHot(`l:${l.key}`); onLead(l.key) }}>
            <i class="n__dot" />
            <span class="n__t">
              <b class="n__name">{l.name}</b>
              {state === 'wrong' && l.page?.length ? <span class="n__sub n__fix">page: {l.page[0]}</span> : null}
            </span>
            <span class="n__mark" aria-label={state === 'ok' ? 'the page says it led' : state === 'wrong' ? 'the page names another lead' : state === 'open' ? 'the page does not say' : ''}>
              {state === 'ok' ? <Icon name="check" size={13} /> : state === 'wrong' ? <Icon name="x" size={13} /> : state === 'open' ? <i class="n__q" /> : null}
            </span>
          </button>
        )
      })}
      {p.hiddenRounds > 0 && phase >= PHASE.rounds && (
        <span class="g__more" style={wide ? { left: `${col.r[0] + 14}px` } : { left: `${col.r[0] - 60}px`, width: '120px', textAlign: 'center' }}>
          +{p.hiddenRounds} more
        </span>
      )}
    </div>
  )
}

function Reading({ p, phase, checked, d }: { p: Plan; phase: number; checked: number; d: WalkData }) {
  // the sentence under the eye while the pages are read; when done, what the reading came to
  const [shown, setShown] = useState<LeadRow | null>(null)
  useEffect(() => {
    if (phase !== PHASE.check) return
    const row = p.leads[checked]
    if (row?.quote) setShown(row)
  }, [phase, checked, p])
  if (phase < PHASE.check) {
    return (
      <div class="read read--wait">
        <Src kind="cala" />
        <span>{phase <= PHASE.softs ? 'Asking Cala which rounds they joined' : phase === PHASE.rounds ? 'Opening each round in Cala’s graph' : 'Cala’s graph says who led each one'}</span>
      </div>
    )
  }
  if (phase === PHASE.check && shown?.quote) {
    return (
      <div class={`read read--quote${shown.state === 'wrong' ? ' is-wrong' : ''}`} key={shown.key}>
        <Src kind="page" label={shown.publisher || 'Page Cala cites'} />
        <Quote text={shown.quote} names={shown.state === 'wrong' ? (shown.page ?? []) : [shown.name]} struck={shown.state === 'wrong' ? [shown.name] : undefined} />
      </div>
    )
  }
  if (phase === PHASE.check) {
    return <div class="read read--wait"><Src kind="page" /><span>Reading the page Cala cites for each round</span></div>
  }
  const c = d.check
  return (
    <div class="read read--sum">
      <Src kind="page" />
      <span>
        <b class="num">{num(c.pages)}</b> pages read. <b class="good num">{num(c.confirmed)}</b> “led” claims hold word for word
        {c.corrected > 0 && <>, <b class="bad num">{num(c.corrected)}</b> {c.corrected === 1 ? 'does' : 'do'} not</>}
        {c.unstated > 0 && <>, <span class="num">{num(c.unstated)}</span> not stated</>}.
      </span>
    </div>
  )
}

function Pill({ l }: { l: Lead }) {
  if (l.now) return <span class="pill pill--now"><i />Leading now</span>
  return <span class="pill">{l.tier_label || 'On record'}</span>
}

function LeadCard({ l, open, onToggle, onDraft, onNet, busy, short, full }: {
  l: Lead; open: boolean; onToggle: () => void; onDraft: (l: Lead) => void; onNet: (l: Lead) => void; busy: boolean; short: boolean; full: boolean
}) {
  const e = l.evidence[0]
  const proven = ok(e?.status)
  return (
    <li class={`lead${open ? ' is-open' : ''}`}>
      <button type="button" class="lead__head" onClick={onToggle} aria-expanded={open}>
        <span class="lead__rank num">{l.rank}</span>
        <span class="lead__main">
          <span class="lead__name">{l.name}<Pill l={l} /></span>
          {e && (
            <span class="lead__line">
              {proven ? <Icon name="check" size={12} class="good" /> : <Icon name="cala" size={12} />}
              {l.rounds > 1 ? `Led ${l.rounds} rounds your investors joined, latest ` : 'Led '}
              {[e.company, e.amount, e.stage_name].filter(Boolean).join(' ')}{e.date ? `, ${month(e.date)}` : ''}
            </span>
          )}
          {l.door && (
            <span class="lead__line lead__door">
              <Icon name="door" size={12} />
              <span><b>{l.door.name}</b> opens the door{l.door.deals > 1 ? `: in ${l.door.deals} of those rounds` : ': it was in that round'}</span>
            </span>
          )}
        </span>
        <Icon name="down" size={14} class="lead__chev" />
      </button>
      {open && (
        <div class="lead__body">
          {e?.quote && (
            <figure class="proof">
              <Quote text={e.quote} names={[l.name]} />
              <figcaption>
                <Src kind="page" label={proven ? 'The page says it led' : 'From the page Cala cites'} />
                <Link href={e.url}>{e.publisher || 'source'}</Link>
              </figcaption>
            </figure>
          )}
          {l.why.length > (full ? 0 : 1) && (
            <ul class="why">
              {l.why.slice(full ? 0 : 1, 3).map((w) => <li key={w}><Icon name="cala" size={12} />{w}</li>)}
            </ul>
          )}
          {l.caution && <p class="caution">{l.caution}</p>}
          <div class="acts">
            <Btn kind="main" icon="mail" busy={busy} onClick={() => onDraft(l)}>Draft the ask{l.door && !short ? ` to ${l.door.name}` : ''}</Btn>
            <Btn icon="net" onClick={() => onNet(l)}>{short ? 'Who else opens it' : 'Who else opens this door'}</Btn>
          </div>
        </div>
      )}
    </li>
  )
}

function Inbox({ softs }: { softs: Soft[] }) {
  const mail = softs.filter((s) => s.from === 'inbox' && s.said)
  const [all, setAll] = useState(false)
  if (!mail.length) return null
  const rows = all ? mail : mail.slice(0, 1)
  return (
    <div class="inbox">
      {rows.map((s) => (
        <p key={s.key}>
          <Icon name="inbox" size={13} />
          <span><q>{s.said}</q> <i>{[s.person, s.name].filter(Boolean).join(', ')}{s.date ? ` · ${month(s.date)}` : ''}</i></span>
        </p>
      ))}
      {mail.length > 1 && (
        <button type="button" class="more" onClick={() => setAll(!all)}>
          {all ? 'Show one' : `${mail.length - 1} more from your inbox`}
        </button>
      )}
    </div>
  )
}

function Fixes({ fixes }: { fixes: Fix[] }) {
  if (!fixes.length) return null
  return (
    <section class="fixes">
      <h2>Where the page and Cala disagree</h2>
      <ul>
        {fixes.map((f, i) => (
          <li key={i}>
            <p><b>{[f.company, f.stage_name, month(f.date)].filter(Boolean).join(', ')}</b>. Cala: <s>{f.cala}</s> led. The page: {listAnd(f.page)}.</p>
            {f.quote && <Quote text={f.quote} names={f.page} struck={f.cala ? [f.cala] : undefined} />}
            <Link href={f.url}>{f.publisher || 'source'}</Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Walk({ data: d, roomy, fit, canExpand, onExpand, onNetwork }: {
  data: WalkData; roomy: boolean; fit: number; canExpand: boolean; onExpand: () => void; onNetwork: (focus?: string) => void
}) {
  const tight = fit >= 1
  const tiny = fit >= 2
  const [ref, width] = useWidth<HTMLDivElement>()
  const still = reduced()
  const [phase, setPhase] = useState<number>(still ? PHASE.done : PHASE.rest)
  const [checked, setChecked] = useState(-1)
  const [hot, setHot] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(tight ? null : d.leads[0]?.key ?? null)
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [run, setRun] = useState(0)
  const timers = useRef<number[]>([])
  const wide = width >= 560
  const p = useMemo(() => plan(d, roomy ? 16 : tiny ? 5 : wide ? 7 : 12, roomy ? 14 : tiny ? 4 : tight ? 5 : 7), [d, roomy, wide, tight, tiny])
  useEffect(() => { if (tight) setOpen(null) }, [tight])

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (still || !width) return
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms))
    setPhase(PHASE.rest)
    setChecked(-1)
    at(120, () => setPhase(PHASE.softs))
    at(900, () => setPhase(PHASE.rounds))
    at(900 + 500 + p.rounds.length * 55, () => setPhase(PHASE.leads))
    const t0 = 900 + 500 + p.rounds.length * 55 + 500 + p.leads.length * 70
    let t = t0
    at(t, () => setPhase(PHASE.check))
    let held = 0
    p.leads.forEach((row, i) => {
      at(t, () => setChecked(i))
      // a sentence is held long enough to read its marked name; the first few, and every struck one
      const hold = row.quote && (row.state === 'wrong' || held < 2)
      if (hold && row.state !== 'wrong') held++
      t += hold ? (row.state === 'wrong' ? 1500 : 1100) : 240
    })
    at(t + 200, () => setPhase(PHASE.done))
    return () => timers.current.forEach(clearTimeout)
  }, [run, width > 0, p, still])

  const skip = () => {
    if (phase >= PHASE.done) return
    timers.current.forEach(clearTimeout)
    setPhase(PHASE.done)
  }

  const names = d.softs.map((s) => s.name)
  const draft = async (l: Lead) => {
    setBusy(l.key)
    const to = l.door?.name
    const text = to
      ? `Draft the intro ask to ${to} about ${l.name} with Soft Yes (run ${d.run_id}), and save it to my drafts.`
      : `Draft a note to ${l.name} with Soft Yes (run ${d.run_id}), and save it to my drafts.`
    const sent = await say(text)
    setBusy(null)
    setNote(sent ? null : `Ask in the chat: “Draft the intro ask to ${to || l.name} about ${l.name}.”`)
  }
  const pickLead = (key: string) => {
    const l = d.leads.find((x) => x.key === key)
    if (!l) return
    if (!all && d.leads.indexOf(l) >= 3) setAll(true)
    setOpen(key)
    tell(`The founder is looking at ${l.name} (rank ${l.rank}) in the Soft Yes walk ${d.run_id}.`)
  }

  const shown = all || roomy ? d.leads : d.leads.slice(0, tight ? 2 : 3)
  const from = d.ledger.inbox > 0 ? 'inbox' : d.softs.some((s) => s.from === 'cala') ? 'cala' : 'typed'
  const title = d.stage_name ? `Who could lead your ${d.stage_name === 'Seed' || d.stage_name === 'Pre-seed' ? d.stage_name.toLowerCase() : d.stage_name}` : 'Who could lead your round'
  return (
    <div class="card card--walk" ref={ref}>
      <Head
        title={title}
        sub={<>{listAnd(names)} said yes once there is a lead. <b>{d.leads_total}</b> investors led rounds they joined{d.leading_now ? <>, <b>{d.leading_now}</b> are leading now</> : null}.</>}
        right={<>
          {phase >= PHASE.done && !still && <button type="button" class="tool" onClick={() => setRun(run + 1)} title="Play the walk again"><Icon name="replay" size={14} />Replay</button>}
          {canExpand && <button type="button" class="tool" onClick={onExpand} title="Open in full"><Icon name="expand" size={14} />Expand</button>}
        </>}
      />
      {!tiny && <Inbox softs={d.softs} />}
      <Ledger cells={[
        { kind: 'cala', label: 'From Cala’s graph', value: <Count to={d.ledger.facts ?? 0} run={phase >= PHASE.rounds} ms={1400} />, note: 'facts' },
        { kind: 'page', label: 'Pages Cala cites, read', value: <Count to={d.check.pages} run={phase >= PHASE.check} ms={1800} />,
          note: phase >= PHASE.done && d.check.corrected ? <span class="bad">{d.check.corrected} corrected</span> : 'pages' },
        from === 'inbox'
          ? { kind: 'inbox' as const, label: 'From your inbox', value: <Count to={d.ledger.inbox} run={phase >= PHASE.softs} ms={500} />, note: d.ledger.inbox === 1 ? 'soft yes' : 'soft yeses' }
          : from === 'cala'
            ? { kind: 'cala' as const, label: `Investors in ${d.company || 'your company'}`, value: <Count to={d.softs.length} run={phase >= PHASE.softs} ms={500} />, note: 'listed by Cala' }
            : { kind: 'typed' as const, label: 'From you', value: <Count to={d.softs.length} run={phase >= PHASE.softs} ms={500} />, note: d.softs.length === 1 ? 'name' : 'names' },
        { kind: 'model', label: 'From a language model', value: <span class="num">0</span>, note: 'facts' },
      ]} />

      <div class="stage" onClick={skip}>
        {width > 0 && <Graph d={d} p={p} phase={phase} checked={checked} hot={hot} setHot={setHot} onLead={pickLead} width={width - 2} roomy={roomy} />}
        <Reading p={p} phase={phase} checked={checked} d={d} />
      </div>

      {d.partial && <p class="banner">Cala’s graph is thin for one of these investors, so reports are still being read. The list fills in within a minute.</p>}

      {d.leads.length === 0 ? (
        <p class="empty">Cala lists no round these investors joined that someone else led. Try the investor’s full name, or add another who said yes.</p>
      ) : phase < PHASE.done ? null : (
        <ol class="leads is-in">
          {shown.map((l) => (
            <LeadCard key={l.key} l={l} short={!wide} full={roomy} open={open === l.key} onToggle={() => setOpen(open === l.key ? null : l.key)}
              onDraft={draft} onNet={(x) => onNetwork(x.key)} busy={busy === l.key} />
          ))}
        </ol>
      )}
      {note && <p class="banner">{note}</p>}

      {d.own?.found && phase >= PHASE.done && !tiny && (
        <p class="own">
          <Icon name="check" size={13} class="good" />
          <span>
            Tested on {d.company ? `${d.company}’s` : 'your'} own {String(d.own.stage_name || 'round').toLowerCase()}: leave it out, walk from {listAnd(d.own.from)} alone,
            and <b>{d.own.found.name}</b> comes out <b>{d.own.found.rank === 1 ? 'first' : `number ${d.own.found.rank}`} of {d.own.of}</b>. It led that round.
          </span>
        </p>
      )}

      {(roomy || all) && <Fixes fixes={d.fixes} />}

      <footer class="foot">
        <div class="foot__l">
          {!roomy && phase >= PHASE.done && d.leads.length > shown.length && <button type="button" class="more" onClick={() => setAll(true)}>All {Math.min(d.leads.length, 12)} of {d.leads_total}</button>}
          {!roomy && all && d.leads.length > 3 && <button type="button" class="more" onClick={() => setAll(false)}>Show fewer</button>}
          <button type="button" class="more" onClick={() => onNetwork()}><Icon name="net" size={13} />Explore the network</button>
        </div>
        <Link href={d.url} class="foot__r">Every round and source</Link>
      </footer>
    </div>
  )
}

export function WalkWait({ args, progress }: { args: any; progress: any }) {
  // drawn while the assistant's call is still out: the names it asked about, and how far Cala's walk has got
  const names: string[] = [
    ...((args?.soft_yeses as any[]) || []).map((s) => String(s?.investor || '')),
    ...((Array.isArray(args?.investors) ? args.investors : args?.investors ? [args.investors] : []) as any[]).map(String),
  ].filter(Boolean)
  const latest: any[] = progress?.latest || []
  return (
    <div class="card card--walk">
      <Head title="Walking Cala’s graph" sub={names.length ? <>From {listAnd(names)}: the rounds they joined, and who led them.</> : args?.company ? <>From the investors Cala lists in {String(args.company)}.</> : 'Finding who could lead.'} />
      <Ledger cells={[
        { kind: 'cala', label: 'Calls to Cala', value: <span class="num">{num(progress?.calls)}</span>, note: progress?.seconds ? `${Math.round(progress.seconds)} s` : 'so far' },
        { kind: 'cala', label: 'Rounds opened', value: <span class="num">{num(progress?.rounds)}</span>, note: progress?.leads ? plural(progress.leads, 'lead') : 'rounds' },
        { kind: 'page', label: 'Pages Cala cites, read', value: <span class="num">{num(progress?.pages?.pages)}</span>, note: 'pages' },
        { kind: 'model', label: 'From a language model', value: <span class="num">0</span>, note: 'facts' },
      ]} />
      <div class="stage stage--wait" aria-busy="true">
        <ul class="wait">
          {latest.length
            ? latest.slice(-5).map((r, i) => (
              <li key={`${r.company}${i}`}><Icon name="cala" size={12} /><b>{r.company}</b><span>{r.stage_name}</span>{r.leads?.length ? <em>led by {listAnd(r.leads)}</em> : null}</li>
            ))
            : [0, 1, 2, 3].map((i) => <li key={i}><i class="skel" style={{ width: `${46 + ((i * 17) % 30)}%` }} /></li>)}
        </ul>
      </div>
    </div>
  )
}
