// The search, drawn: what Cala was asked, the companies it names, the investors in them, and each investor's own
// record read from the graph. A signal is a count over those facts; a filled dot means the record bears it out.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { say, tell } from './bridge'
import { type ChainLink, type FindCompany, type FindData, type FindInvestor, type FindProgress, askWords, listAnd, month, num, ok, plural, reduced } from './lib'
import { Btn, Count, Head, Icon, Ledger, Link, Quote, Src, useWidth } from './ui'
import { Fixes, drawn } from './walk'

const ORDER = ['field', 'leads', 'stage', 'recent', 'size', 'place', 'path']
/** Text assembled at the server uses the typewriter apostrophe; the card sets it as type. */
const ty = (s?: string | null) => (s || '').replace(/'/g, '’')
const NAMED = '~cala'   // the node for investors Cala's own answer names, with no company of the list behind them
const VIA = '~via'      // the node for the investors the founder knows: the rounds they sat in lead to the way in

type Left = FindCompany | typeof NAMED | typeof VIA
interface LinkRow { c: number; i: number; ok: boolean; led: boolean; far?: boolean }
interface Plan { cos: Left[]; invs: FindInvestor[]; links: LinkRow[]; cols: string[]; moreCos: number; moreInvs: number }

function plan(d: FindData, maxC: number, maxI: number): Plan {
  const invs = d.investors.slice(0, maxI)
  const held = new Map(d.companies.map((c) => [c.name, c]))
  const of = invs.map((x) => {
    const m = new Map<string, { led: boolean; ok: boolean }>()
    for (const dl of x.deals) {
      if (!dl.company || !held.has(dl.company)) continue
      const was = m.get(dl.company)
      m.set(dl.company, { led: dl.led || !!was?.led, ok: (dl.led && ok(dl.status)) || !!was?.ok })
    }
    for (const b of x.backed) if (held.has(b.company) && !m.has(b.company)) m.set(b.company, { led: false, ok: false })
    return m
  })
  const count = new Map<string, number>()
  of.forEach((m) => m.forEach((_, name) => count.set(name, (count.get(name) ?? 0) + 1)))
  const order = [...d.companies].sort((a, b) => (count.get(b.name) ?? 0) - (count.get(a.name) ?? 0) || b.rounds.length - a.rounds.length)
  const loose = invs.some((x, i) => of[i].size === 0 && x.named_by_cala && !x.path.length)
  const via = invs.some((x) => x.path.length > 0 || (x.chain?.links.length ?? 0) > 1)
  const room = maxC - (loose ? 1 : 0) - (via ? 1 : 0)
  const cos: Left[] = order.slice(0, room)
  if (loose) cos.push(NAMED)
  if (via) cos.push(VIA)
  const at = new Map(cos.map((c, i) => [typeof c === 'string' ? c : c.name, i]))
  const links: LinkRow[] = []
  of.forEach((m, i) => {
    m.forEach((v, name) => { const c = at.get(name); if (c != null) links.push({ c, i, ...v }) })
    const way = invs[i].path[0]
    if (way) links.push({ c: at.get(VIA)!, i, ok: !!way.led && ok(way.status), led: !!way.led })
    else if ((invs[i].chain?.links.length ?? 0) > 1) links.push({ c: at.get(VIA)!, i, ok: false, led: false, far: true })
    else if (m.size === 0 && invs[i].named_by_cala && at.has(NAMED)) links.push({ c: at.get(NAMED)!, i, ok: false, led: false })
  })
  const cols = ORDER.filter((id) => invs.some((x) => x.signals.some((s) => s.id === id)))
  return { cos, invs, links, cols, moreCos: Math.max(0, d.companies.length - room), moreInvs: Math.max(0, d.investors_total - invs.length) }
}

const PHASE = { rest: 0, ask: 1, cos: 2, invs: 3, read: 4, done: 5 } as const

/** The line of Cala's query language as it was sent, without its paging. */
function shortQuery(q?: string): string {
  return (q || '').replace(/\.limit=\d+/, '').replace(/\.return\(.*\)$/, '')
}

function Dots({ x, cols, lit }: { x: FindInvestor; cols: string[]; lit: boolean }) {
  const by = new Map(x.signals.map((s) => [s.id, s]))
  const on = x.signals.filter((s) => s.on).map((s) => s.label)
  return (
    <span class={`sig${lit ? ' is-lit' : ''}`} title={on.length ? on.join(' · ') : 'No signal in its record'} aria-label={`${on.length} of ${x.signals.length} signals`}>
      {cols.map((id, n) => {
        const s = by.get(id)
        return <i key={id} class={s ? (s.on ? 'is-on' : s.far ? 'is-far' : 'is-off') : 'is-none'} style={{ '--n': n }} />
      })}
    </span>
  )
}

function Graph({ p, phase, read, hot, setHot, onPick, onMore, width, d }: {
  p: Plan; phase: number; read: number; hot: string | null; setHot: (k: string | null) => void; onPick: (key: string) => void; onMore: () => void; width: number; d: FindData
}) {
  const wide = width >= 560
  const rowC = wide ? 38 : 30
  const rowI = 30
  const top = 26
  const foot = p.moreCos > 0 || p.moreInvs > 0 ? 20 : 6
  const H = top + Math.max(p.cos.length * rowC, p.invs.length * rowI, 120) + foot
  const col = wide ? { c: [0, width * 0.36], i: [width * 0.5, width] } : { c: [0, width * 0.39], i: [width * 0.5, width] }
  const yOf = (n: number, i: number, h: number) => top + (H - top - foot - n * h) / 2 + i * h + h / 2
  const yC = (i: number) => yOf(p.cos.length, i, rowC)
  const yI = (i: number) => yOf(p.invs.length, i, rowI)
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.5
    return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }
  /** The length of that curve in pixels, near enough to set a dash by. */
  const span = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.5
    let len = 0, px = x1, py = y1
    for (let k = 1; k <= 16; k++) {
      const t = k / 16, u = 1 - t
      const x = u * u * u * x1 + 3 * u * u * t * (x1 + dx) + 3 * u * t * t * (x2 - dx) + t * t * t * x2
      const y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2
      len += Math.hypot(x - px, y - py); px = x; py = y
    }
    return Math.max(1, Math.round(len))
  }
  const lit = useMemo(() => {
    if (!hot) return null
    const [kind, at] = hot.split(':')
    const n = +at
    const mine = p.links.filter((l) => (kind === 'c' ? l.c === n : l.i === n))
    return { cos: new Set(kind === 'c' ? [n] : mine.map((l) => l.c)), invs: new Set(kind === 'i' ? [n] : mine.map((l) => l.i)), kind, n }
  }, [hot, p])
  const cls = `g g--find${phase >= PHASE.cos ? ' is-cos' : ''}${phase >= PHASE.invs ? ' is-invs' : ''}${phase >= PHASE.done ? ' is-done' : ''}${wide ? '' : ' g--narrow'}${lit ? ' has-hot' : ''}`
  return (
    <div class={cls} style={{ height: `${H}px` }} onMouseLeave={() => setHot(null)}>
      <svg class="g__links" width={width} height={H} aria-hidden="true">
        {p.links.map((l, n) => {
          const on = !lit || (lit.kind === 'c' ? l.c === lit.n : l.i === lit.n)
          const seen = phase >= PHASE.done || (phase === PHASE.read && l.i <= read)
          const at: [number, number, number, number] = [col.c[1] + 5, yC(l.c), col.i[0] - 5, yI(l.i)]
          const dashed = l.far || p.cos[l.c] === NAMED
          return <path key={n} d={curve(...at)} pathLength={dashed ? span(...at) : 1}
            class={`lk lk--f${seen && l.ok ? ' is-ok' : ''}${p.cos[l.c] === NAMED ? ' lk--named' : p.cos[l.c] === VIA ? ' lk--via' : ''}${l.far ? ' lk--far' : ''}${on ? '' : ' is-dim'}`} style={{ '--d': `${l.i * 60}ms` }} />
        })}
      </svg>
      <span class="g__h" style={{ left: 0, width: `${col.c[1]}px`, textAlign: 'right' }}>{d.ask.like.length && !d.ask.sector ? 'Companies you named' : wide ? 'Companies like yours' : 'Like yours'}</span>
      <span class="g__h" style={{ left: `${col.i[0]}px` }}>Investors</span>
      <span class="g__h g__h--r" style={{ right: 0 }}>Signals</span>

      {p.cos.map((c, i) => {
        const whose = d.ask.via_company ? `${d.ask.via_company}’s investors` : 'Your investors'
        const name = c === NAMED ? 'Cala’s own answer' : c === VIA ? whose : c.name
        const sub = c === NAMED ? 'investors it names' : c === VIA ? `${plural(d.counts.mine_rounds ?? d.counts.way_rounds ?? 0, 'round')} they sat in`
          : [c.where, c.rounds[0] ? [c.rounds[0].stage_name, c.rounds[0].money].filter(Boolean).join(' ') : plural(c.investors_listed, 'investor')].filter(Boolean).join(' · ')
        const title = c === NAMED ? 'Investors Cala’s answer names for this field' : c === VIA ? `Rounds ${listAnd(d.ask.mine.slice(0, 4))} sat in, and who led or joined them` : c.description || c.name
        return (
          <button key={typeof c === 'string' ? c : c.id} type="button" class={`n n--co${c === NAMED ? ' n--named' : c === VIA ? ' n--via' : ''}${lit && !lit.cos.has(i) ? ' is-dim' : ''}`}
            style={{ top: `${yC(i) - rowC / 2}px`, height: `${rowC}px`, left: 0, width: `${col.c[1]}px`, '--i': i }}
            onMouseEnter={() => setHot(`c:${i}`)} onFocus={() => setHot(`c:${i}`)} onClick={() => setHot(hot === `c:${i}` ? null : `c:${i}`)} title={title}>
            <span class="n__t">
              <b class="n__name">{name}</b>
              {wide && <span class="n__sub">{sub}</span>}
            </span>
            <i class="n__dot" />
          </button>
        )
      })}

      {p.invs.map((x, i) => {
        const seen = phase >= PHASE.done || (phase === PHASE.read && i <= read)
        return (
          <button key={x.key} type="button"
            class={`n n--inv${phase === PHASE.read && i === read ? ' is-reading' : ''}${seen && x.proof ? ' is-ok' : ''}${lit && !lit.invs.has(i) ? ' is-dim' : ''}`}
            style={{ top: `${yI(i) - rowI / 2}px`, height: `${rowI}px`, left: `${col.i[0]}px`, width: `${col.i[1] - col.i[0]}px`, '--i': i }}
            onMouseEnter={() => setHot(`i:${i}`)} onFocus={() => setHot(`i:${i}`)} onClick={() => { setHot(`i:${i}`); onPick(x.key) }}>
            <i class="n__dot" />
            <span class="n__t"><b class="n__name">{x.name}</b></span>
            <Dots x={x} cols={p.cols} lit={seen} />
          </button>
        )
      })}
      {p.moreCos > 0 && phase >= PHASE.cos && <span class="g__more" style={{ left: 0, width: `${col.c[1]}px`, textAlign: 'right' }}>+{p.moreCos} more</span>}
      {p.moreInvs > 0 && phase >= PHASE.invs && <button type="button" class="g__more g__more--b" style={{ left: `${col.i[0] + 15}px` }} onClick={(e) => { e.stopPropagation(); onMore() }}>+{p.moreInvs} more</button>}
    </div>
  )
}

/** What the dots stand for, in the order they are drawn. */
function Legend({ d, cols, far }: { d: FindData; cols: string[]; far: boolean }) {
  const label = new Map<string, string>()
  for (const x of d.investors) for (const s of x.signals) if (!label.has(s.id)) label.set(s.id, s.label)
  const names = cols.map((id) => label.get(id)).filter(Boolean) as string[]
  if (names.length < 2) return null
  return (
    <p class="legend">
      <span class="legend__k">The dots, left to right</span>
      {names.map((n, i) => <span key={n} class="legend__i"><i>{i + 1}</i>{n}</span>)}
      {far && (
        <span class="legend__far">
          <i class="legend__ring" />
          <svg class="legend__dash" width="22" height="6" viewBox="0 0 22 6" aria-hidden="true"><path d="M0 3H22" /></svg>
          two or three introductions away
        </span>
      )}
    </p>
  )
}

/** What an investor's own record in Cala says, in one line: the counts behind its signals. */
function recordLine(x: FindInvestor): string {
  const pick = x.signals.filter((s) => ['stage', 'leads', 'recent'].includes(s.id) && s.on).slice(0, 2)
  return ty((pick.length ? pick : x.signals.slice(0, 1)).map((s) => s.text).join('. ') || x.line)
}

function Reading({ d, p, phase, read, typed }: { d: FindData; p: Plan; phase: number; read: number; typed: string }) {
  const c = d.counts
  if (phase <= PHASE.ask) {
    return (
      <div class="read read--ask">
        <Src kind="cala" label="Cala is asked" />
        {d.queries.length
          ? <span><code class="ql">{typed}<i class="caret" /></code></span>
          : <span>Looking up {listAnd(d.ask.like.slice(0, 4))} in Cala’s graph</span>}
      </div>
    )
  }
  if (phase === PHASE.cos) {
    return (
      <div class="read read--sum" key="cos">
        <Src kind="cala" />
        <span>{c.named_by_cala
          ? <>Cala names <b class="num">{num(c.named_by_cala)}</b> companies for the field. <b class="num">{num(c.companies)}</b> are in its graph with their investors.</>
          : <>Cala has <b class="num">{num(c.companies)}</b> of the companies you named, with their investors.</>}</span>
      </div>
    )
  }
  if (phase === PHASE.invs) {
    return (
      <div class="read read--sum" key="invs">
        <Src kind="cala" />
        <span><b class="num">{num(c.investors)}</b> investors sit in their rounds and on their cap tables. Now each one’s own record.</span>
      </div>
    )
  }
  if (phase === PHASE.read) {
    const x = p.invs[read]
    if (x?.proof?.quote) {
      return (
        <div class="read read--quote" key={`q${x.key}`}>
          <Src kind="page" label={x.proof.publisher || 'Page Cala cites'} />
          <Quote text={x.proof.quote} names={[x.name]} />
        </div>
      )
    }
    return (
      <div class="read read--sum" key={x?.key ?? 'r'}>
        <Src kind="cala" label="Its record in Cala" />
        <span>{x ? <><b>{x.name}</b>. {recordLine(x)}.</> : 'Reading each investor’s own record'}</span>
      </div>
    )
  }
  return (
    <div class="read read--sum" key="done">
      <Src kind="cala" />
      <span>
        <b class="num">{num(c.own_records)}</b> investors’ own records read: <b class="num">{num(c.rounds_read)}</b> rounds.
        {d.check.pages > 0 && <> <b class="num">{num(d.check.pages)}</b> {d.check.pages === 1 ? 'page' : 'pages'} read: <b class="good num">{num(d.check.confirmed)}</b> “led” {d.check.confirmed === 1 ? 'claim holds' : 'claims hold'} word for word
          {d.check.corrected > 0 && <>, <b class="bad num">{num(d.check.corrected)}</b> {d.check.corrected === 1 ? 'does' : 'do'} not</>}.</>}
      </span>
    </div>
  )
}

/** The way in, link by link: who the founder knows, the fund that one sat with, and so on to this investor. Each link is a round in Cala. */
function Chain({ x }: { x: FindInvestor }) {
  const ch = x.chain!
  const n = ch.links.length
  const what = (l: ChainLink) => [l.company ? `${ty(l.company)}${l.stage_name ? ` ${/^series/i.test(l.stage_name) ? l.stage_name : l.stage_name.toLowerCase()}` : ''}` : '', l.company && l.date ? l.date.slice(0, 4) : ''].filter(Boolean).join(', ')
  const from = ch.start ? ty(ch.start) : 'You'
  const tie = (l: ChainLink) => l.strength == null ? '' : l.strength >= 0.8 ? 'strong' : l.strength <= 0.3 ? 'thin' : ''
  const page = (l: ChainLink) => l.named === 'both' ? <span class="chain__pg is-ok"><Icon name="check" size={11} />the page names both</span>
    : l.named === 'one' || l.named === 'none' ? <span class="chain__pg">{l.named === 'one' ? 'the page names one: only Cala has the other' : 'the page names neither: only Cala does'}</span>
      : l.named ? <span class="chain__pg">page not read</span> : null
  let k = 0
  return (
    <div class="chain">
      <p class="chain__k"><Src kind="cala" label="The way in" /><span>{n === 1 ? 'One introduction' : `${n} introductions`}. Each link is a round both sat in. It shows who invested together, not who will introduce you.</span></p>
      <ol class="chain__t" aria-label={`From ${from} to ${x.name}`}>
        <li class="chain__n chain__n--you" style={{ '--k': k++ }}><i /><b>{from}</b></li>
        <li class="chain__l" style={{ '--k': k++ }}><span>{ch.start ? 'its investor' : 'your investor'}</span></li>
        {ch.links.flatMap((l, i) => [
          <li key={`a${i}`} class="chain__n" style={{ '--k': k++ }}><i /><b>{ty(l.a)}</b></li>,
          <li key={`l${i}`} class="chain__l" style={{ '--k': k++ }}>
            <span>{l.led ? `${ty(l.b)} led a round with ${ty(l.a)} in it` : `${plural(l.rounds, 'round')} together`}{!l.led && l.rounds === 1 && (l.size ?? 0) > 2 ? `, ${l.size} investors in it` : ''}{tie(l) && <b class={`chain__tie${tie(l) === 'thin' ? ' is-thin' : ''}`}>{tie(l)}</b>}{what(l) && <i class="chain__sep">·</i>}</span>
            {what(l) && <span class="chain__r">{!l.led && l.rounds > 1 && <span>one is</span>}{l.url ? <Link href={l.url}>{what(l)}</Link> : <span>{what(l)}</span>}{page(l)}</span>}
          </li>,
        ])}
        <li class="chain__n chain__n--it" style={{ '--k': k++ }}><i /><b>{ty(x.name)}</b></li>
      </ol>
    </div>
  )
}

function Row({ x, open, onToggle, short, onNet }: { x: FindInvestor; open: boolean; onToggle: () => void; short: boolean; onNet: (x: FindInvestor) => void }) {
  const cites = [
    ...x.deals.map((dl) => ({ what: [dl.company, dl.stage_name, month(dl.date), dl.money].filter(Boolean).join(', ') + (dl.led ? ', led' : ''), src: dl.url ? { url: dl.url, publisher: dl.publisher } : dl.sources[0] })),
    ...(x.ways || []).map((dl) => ({ what: [dl.company, dl.stage_name, month(dl.date), dl.money].filter(Boolean).join(', ') + (dl.led ? ', led' : '') + `, with ${listAnd(dl.with.slice(0, 2))}`, src: dl.url ? { url: dl.url, publisher: dl.publisher } : dl.sources[0] })),
    ...x.backed.map((b) => ({ what: `${b.company}, listed as an investor`, src: b.sources[0] })),
  ].filter((r) => r.src?.url).slice(0, 4)
  return (
    <li class={`lead lead--inv${open ? ' is-open' : ''}`}>
      <button type="button" class="lead__head" onClick={onToggle} aria-expanded={open}>
        <span class="lead__rank num">{x.rank}</span>
        <span class="lead__main">
          <span class="lead__name">{x.name}{x.kind === 'accelerator' ? <span class="lead__where">Accelerator</span> : null}{x.hq && !short ? <span class="lead__where">{x.hq}</span> : null}</span>
          <span class="lead__line">
            {x.proof ? <Icon name="check" size={12} class="good" /> : <Icon name="cala" size={12} />}
            <span>{ty(x.line)}</span>
          </span>
          <span class="sgs">
            {x.signals.map((s) => <span key={s.id} class={`sg${s.on ? ' is-on' : s.far ? ' is-far' : ''}`}><i />{s.far ? `${s.far} introductions away` : s.label}{s.id === 'field' && (s.n ?? 0) > 1 ? ` ×${s.n}` : ''}</span>)}
          </span>
        </span>
        <Icon name="down" size={14} class="lead__chev" />
      </button>
      {open && (
        <div class="lead__body">
          {x.proof?.quote && (
            <figure class="proof">
              <Quote text={x.proof.quote} names={[x.name]} />
              <figcaption>
                <Src kind="page" label="The page says it led" />
                <Link href={x.proof.url}>{x.proof.publisher || 'source'}</Link>
              </figcaption>
            </figure>
          )}
          <ul class="why why--sig">
            {x.signals.map((s) => (
              <li key={s.id} class={s.on ? 'is-on' : s.far ? 'is-far' : 'is-off'}>
                <Icon name={s.on ? 'check' : s.far ? 'net' : 'x'} size={12} />
                <span><b>{s.label}.</b> {ty(s.text)}.</span>
              </li>
            ))}
          </ul>
          {x.chain && x.chain.links.length > 0 && <Chain x={x} />}
          {x.sum && x.sum.parts.length > 0 && (
            <div class="sum">
              <p class="sum__k"><Src kind="cala" label={`Why #${x.rank}`} /><span>Points from Cala’s graph, then a bit more for being nearby and for a way in.</span></p>
              <ul>
                {x.sum.parts.map((q, i) => <li key={`p${i}`}><b class="num">{i ? '+' : ''}{q.points.toFixed(2)}</b><span>{ty(q.text)}</span></li>)}
                {x.sum.times.map((q, i) => <li key={`t${i}`}><b class="num">×{q.by.toFixed(2)}</b><span>{ty(q.text)}</span></li>)}
                <li class="sum__t"><b class="num">{(x.score ?? 0).toFixed(2)}</b><span>its score</span></li>
              </ul>
            </div>
          )}
          {cites.length > 0 && (
            <p class="cites">
              <Src kind="cala" label="Cala’s sources" />
              {cites.map((r, n) => <Link key={n} href={r.src!.url}>{r.what}</Link>)}
            </p>
          )}
          {x.description && <p class="about">{x.description}</p>}
          <div class="acts">
            <Btn icon="net" onClick={() => onNet(x)}>{short || x.name.length > 32 ? 'Who it invests with' : `Who ${x.name} invests with`}</Btn>
            {x.website && <Link href={/^https?:/.test(x.website) ? x.website : `https://${x.website}`} class="acts__lnk">{x.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</Link>}
          </div>
        </div>
      )}
    </li>
  )
}

function Companies({ d }: { d: FindData }) {
  return (
    <section class="cos">
      <h2>{d.ask.like.length && !d.ask.sector ? 'The companies you named' : 'The companies Cala names'}</h2>
      <ul>
        {d.companies.map((c) => (
          <li key={c.id}>
            <p><b>{c.name}</b>{[c.where, c.founded ? `founded ${c.founded}` : ''].filter(Boolean).map((t) => <span key={t} class="dim"> · {t}</span>)}</p>
            {c.description && <p class="cos__d">{c.description}</p>}
            {c.rounds.length ? c.rounds.slice(0, 2).map((r) => (
              <p key={r.id} class="cos__r">
                {[r.stage_name, month(r.date), r.money].filter(Boolean).join(', ')}
                {r.leads.length ? <>, led by {r.leads.map((l, n) => <span key={l.key}>{n ? ' and ' : ''}{ok(l.status) ? <b class="good">{l.name}</b> : l.name}</span>)}</> : null}
                {r.sources[0]?.url && <> <Link href={r.sources[0].url}>{r.sources[0].publisher || 'source'}</Link></>}
              </p>
            )) : <p class="cos__r dim">{plural(c.investors_listed, 'investor')} listed in Cala, no round entity</p>}
          </li>
        ))}
      </ul>
      {d.queries.length > 0 && (
        <>
          <h2>What Cala was asked</h2>
          <ul class="qls">{d.queries.map((q) => <li key={q}><code class="ql">{q}</code></li>)}</ul>
          <p class="facts__note">Only names come from these answers. Every round, lead, date and count is then read from Cala’s graph, entity by entity, with its sources.</p>
        </>
      )}
    </section>
  )
}

export function Find({ data: d, cardId, roomy, fit, canExpand, onExpand }: {
  data: FindData; cardId: string; roomy: boolean; fit: number; canExpand: boolean; onExpand: () => void
}) {
  const once = d.run_id ? `${cardId}:${d.run_id}` : ''
  const tight = fit >= 1
  const tiny = fit >= 2
  const [ref, width] = useWidth<HTMLDivElement>()
  const still = reduced()
  const [phase, setPhase] = useState<number>(still || drawn(once) ? PHASE.done : PHASE.rest)
  const [read, setRead] = useState(-1)
  const [typed, setTyped] = useState('')
  const [hot, setHot] = useState<string | null>(null)
  const [open, setOpen] = useState<string[]>(tight || !d.investors[0] ? [] : [d.investors[0].key])   // rows open one by one: closing another row above would move the one you clicked
  const [all, setAll] = useState(false)
  const [cos, setCos] = useState(false)
  const [rest, setRest] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [run, setRun] = useState(0)
  const played = useRef(-1)   // the run that has drawn itself to the end: making the card larger does not start it over
  const timers = useRef<number[]>([])
  const wide = width >= 560
  const p = useMemo(() => plan(d, roomy ? 12 : tiny ? 4 : tight ? 5 : 7, roomy ? 14 : tiny ? 4 : tight ? 5 : 8), [d, roomy, tight, tiny])
  const query = shortQuery(d.queries[0])
  useEffect(() => { if (tight) setOpen([]) }, [tight])

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (still || !width) return
    if ((run === 0 && drawn(once)) || played.current === run) { setPhase(PHASE.done); setTyped(query); return }
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms))
    setPhase(PHASE.rest)
    setRead(-1)
    setTyped('')
    at(100, () => setPhase(PHASE.ask))
    const type = query ? 1000 : 500
    const steps = Math.max(1, Math.ceil(query.length / 3))
    for (let k = 1; k <= steps; k++) at(100 + (type * k) / steps, () => setTyped(query.slice(0, k * 3)))
    let t = 100 + type + 650
    at(t, () => setPhase(PHASE.cos))
    t += 900 + p.cos.length * 60
    at(t, () => setPhase(PHASE.invs))
    t += 1000 + p.invs.length * 60
    at(t, () => setPhase(PHASE.read))
    let held = 0
    p.invs.forEach((x, i) => {
      at(t, () => setRead(i))
      const hold = held < 3 || !!x.proof?.quote
      if (hold) held++
      t += hold ? (x.proof?.quote ? 1500 : 1150) : 260
    })
    at(t + 200, () => setPhase(PHASE.done))
    return () => timers.current.forEach(clearTimeout)
  }, [run, width > 0, p, still])
  useEffect(() => { if (phase >= PHASE.done) { drawn(once, true); played.current = run } }, [phase, once])

  const skip = () => {
    if (phase >= PHASE.done) return
    timers.current.forEach(clearTimeout)
    setTyped(query)
    setPhase(PHASE.done)
  }
  const pick = (key: string) => {
    const x = d.investors.find((v) => v.key === key)
    if (!x) return
    if (!all && d.investors.indexOf(x) >= (tight ? 2 : 4)) setAll(true)
    setOpen([key])
    tell(`The founder is looking at ${x.name} (rank ${x.rank}) in the Soft Yes investor search ${d.run_id}.`)
  }
  const net = async (x: FindInvestor) => {
    const sent = await say(`Use Soft Yes to show who ${x.name} invests with (explore_network, fund: ${x.name}).`)
    setNote(sent ? null : `Ask in the chat: “Who does ${x.name} invest with?”`)
  }

  const shown = all || roomy ? d.investors : d.investors.slice(0, tight ? 2 : 4)
  const words = askWords(d.ask)
  const way = d.ask.mine.length ? (d.ask.via_company ? `The way in is looked for through ${d.ask.via_company}’s investors.` : `The way in is looked for through ${listAnd(d.ask.mine.slice(0, 3))}.`) : ''
  return (
    <div class="card card--find" ref={ref}>
      <Head
        title={`Investors for ${words || 'your round'}`}
        sub={d.investors.length
          ? <><b>{num(d.investors_total)}</b> investors around <b>{num(d.counts.companies)}</b> {d.counts.companies === 1 ? 'company' : 'companies'} like yours{d.counts.way_rounds ? <> and <b>{num(d.counts.mine_rounds ?? d.counts.way_rounds)}</b> rounds {d.ask.via_company ? `${d.ask.via_company}’s` : 'your'} investors sat in</> : null}{(d.counts.ways ?? 0) + (d.counts.ways_far ?? 0) > 0
            ? <>. <b>{num((d.counts.ways ?? 0) + (d.counts.ways_far ?? 0))}</b> have a way in{d.counts.ways_far ? <>, <b>{num(d.counts.ways_far)}</b> of them two or three introductions away</> : null}.</>
            : <>, ranked by what Cala’s graph says of each.{d.counts.way_rounds ? '' : ` ${way}`}</>}</>
          : d.headline}
        right={<>
          {phase >= PHASE.done && !still && <button type="button" class="tool" onClick={() => setRun(run + 1)} title="Play the search again"><Icon name="replay" size={14} />Replay</button>}
          {phase < PHASE.done && phase > PHASE.rest && !still && <button type="button" class="tool" onClick={skip} title="Go straight to the list">Skip</button>}
          {canExpand && <button type="button" class="tool" onClick={onExpand} title="Open in full"><Icon name="expand" size={14} />Expand</button>}
        </>}
      />
      <Ledger cells={[
        { kind: 'cala', label: 'From Cala’s graph', value: <Count to={d.ledger.facts ?? 0} run={phase >= PHASE.cos} ms={1600} />, note: 'facts' },
        { kind: 'cala', label: 'Investors’ records read', value: <Count to={d.counts.own_records} run={phase >= PHASE.read} ms={1800} />, note: `${num(d.counts.rounds_read)} rounds` },
        { kind: 'page', label: 'Pages Cala cites, read', value: <Count to={d.check.pages} run={phase >= PHASE.read} ms={1200} />,
          note: phase >= PHASE.done && d.check.corrected ? <span class="bad">{d.check.corrected} corrected</span> : d.check.pages === 1 ? 'page' : 'pages' },
        { kind: 'model', label: 'From a language model', value: <span class="num">0</span>, note: 'facts' },
      ]} />

      {d.investors.length > 0 && (
        <div class="stage" onClick={skip}>
          {width > 0 && <Graph d={d} p={p} phase={phase} read={read} hot={hot} setHot={setHot} onPick={pick} onMore={() => { setAll(true); setRest(true) }} width={width - 2} />}
          {phase >= PHASE.read && !tiny && <Legend d={d} cols={p.cols} far={p.links.some((l) => l.far)} />}
          <Reading d={d} p={p} phase={phase} read={read} typed={typed} />
          {phase >= PHASE.done && <Fixes fixes={d.fixes} wide={wide} bare={tiny} />}
        </div>
      )}

      {d.investors.length === 0 ? (
        <p class="empty">{d.headline}</p>
      ) : phase < PHASE.done ? null : (
        <>
          <ol class="leads is-in">
            {shown.flatMap((x, i) => [
              x.in_field === false && i > 0 && shown[i - 1].in_field !== false
                ? <li key="tier" class="tier">Below: only shared a round with {d.ask.via_company ? `${d.ask.via_company}’s` : 'your'} investors. Cala shows none in a company like yours.</li> : null,
              <Row key={x.key} x={x} short={!wide} open={open.includes(x.key)} onToggle={() => setOpen(open.includes(x.key) ? open.filter((k) => k !== x.key) : [...open, x.key])} onNet={net} />,
            ])}
          </ol>
          {d.investors.some((x) => x.sum) && <p class="facts__note order">{words ? `Companies like yours are the ones Cala names for ${words}${d.ask.like.length ? ', and the ones you named' : ''}. On top: investors Cala has in one of them, or lists for your field.` : 'On top: investors Cala has in a company like yours.'} Highest score first. The score adds up their rounds and their own record in Cala. Open one to see the sum.</p>}
        </>
      )}
      {note && <p class="banner">{note}</p>}
      {rest && d.rest && d.rest.length > 0 && (
        <section class="cos rest">
          <h2>The other {d.rest.length}</h2>
          <p class="facts__note">A lower score, or only a name on a cap table in Cala. Highest score first.</p>
          <ul>
            {d.rest.map((r) => (
              <li key={r.name}><p><b>{r.name}</b>{r.way > 0 && <span class="rest__way">{r.way === 1 ? 'a way in' : `${r.way} introductions away`}</span>}</p><p class="cos__d">{ty(r.line)}</p></li>
            ))}
          </ul>
        </section>
      )}
      {cos && <Companies d={d} />}

      <footer class="foot">
        <div class="foot__l">
          {!roomy && phase >= PHASE.done && d.investors.length > shown.length && <button type="button" class="more" onClick={() => setAll(true)}>All {d.investors.length} ranked</button>}
          {!roomy && all && d.investors.length > 4 && <button type="button" class="more" onClick={() => setAll(false)}>Show fewer</button>}
          {phase >= PHASE.done && d.rest && d.rest.length > 0 && <button type="button" class="more" onClick={() => setRest(!rest)}>{rest ? 'Hide the others' : `The other ${d.rest.length}`}</button>}
          {d.companies.length > 0 && <button type="button" class="more" onClick={() => setCos(!cos)}><Icon name="cala" size={13} />{cos ? 'Hide the companies' : `The ${d.companies.length} companies and what Cala was asked`}</button>}
        </div>
        <Link href={d.url} class="foot__r">Every checked claim</Link>
      </footer>
    </div>
  )
}

const STEPS = ['field', 'companies', 'rounds', 'pages', 'investors', 'done']

export function FindWait({ args, ask, queries, progress }: { args: any; ask?: FindData['ask']; queries?: string[]; progress: FindProgress | null }) {
  // drawn while Cala is being read: what it was asked, then what has come back so far
  const words = ask ? askWords(ask) : [String(args?.stage || '').replace(/_/g, ' ').toLowerCase().replace('pre seed', 'pre-seed'), String(args?.sector || ''),
    args?.place ? `in ${String(args.place)}` : ''].filter(Boolean).join(' ') || (Array.isArray(args?.like) ? `companies like ${listAnd(args.like.map(String).slice(0, 3))}` : '')
  const at = STEPS.indexOf(progress?.step || 'field')
  const q = shortQuery(queries?.[0])
  const names = progress?.names || []
  const failed = progress?.state === 'failed'
  const line = (n: number, done: any, doing: any) => at < n ? null : <li key={n} class={at === n && !failed ? 'is-now' : ''}><Icon name={at > n ? 'check' : 'cala'} size={12} /><span>{at > n ? done : doing}</span></li>
  return (
    <div class="card card--find">
      <Head title={`Reading Cala for ${words || 'your round'}`}
        sub="Cala names the companies in the field. Their rounds, who led them and each investor’s own record are then read from its graph." />
      <Ledger cells={[
        { kind: 'cala', label: 'Calls to Cala', value: <span class="num">{num(progress?.calls)}</span>, note: progress?.seconds ? `${Math.round(progress.seconds)} s` : 'so far' },
        { kind: 'cala', label: 'Companies named', value: <span class="num">{num(progress?.found)}</span>, note: progress?.companies != null ? `${num(progress.companies)} in the graph` : 'companies' },
        { kind: 'page', label: 'Pages Cala cites, read', value: <span class="num">{num(progress?.pages?.pages)}</span>, note: 'pages' },
        { kind: 'model', label: 'From a language model', value: <span class="num">0</span>, note: 'facts' },
      ]} />
      <div class="stage stage--wait" aria-busy={!failed}>
        <ul class="wait wait--steps">
          {line(0, <>Cala was asked in its query language{q ? <>: <code class="ql">{q}</code></> : null}</>,
            <>Cala is asked{q ? <>: <code class="ql">{q}</code></> : ' for companies in the field'}. This is the slow part, a minute or two</>)}
          {line(1, <>Cala names <b>{num(progress?.found)}</b> companies{names.length ? <>: <em>{names.slice(0, 5).join(', ')}</em></> : null}</>,
            <>Cala names <b>{num(progress?.found)}</b> companies{names.length ? <>: <em>{names.slice(0, 5).join(', ')}</em></> : null}. Opening each one in the graph</>)}
          {line(2, <><b>{num(progress?.companies)}</b> are in the graph with investors, <b>{num(progress?.rounds)}</b> {progress?.rounds === 1 ? 'round' : 'rounds'} opened</>,
            <><b>{num(progress?.companies)}</b> are in the graph with investors. Reading the page Cala cites for each round</>)}
          {line(3, <><b>{num(progress?.pages?.pages)}</b> {progress?.pages?.pages === 1 ? 'page' : 'pages'} read, <b>{num(progress?.pages?.confirmed)}</b> “led” confirmed</>,
            <>Pages read. Collecting every investor in those companies</>)}
          {line(4, <><b>{num(progress?.investors)}</b> investors found</>,
            <><b>{num(progress?.investors)}</b> investors. Reading the own record of {progress?.reading?.length ? <em>{progress.reading.slice(0, 4).join(', ')}</em> : 'each'}</>)}
          {failed && <li class="bad"><Icon name="x" size={12} /><span>The search stopped: {progress?.error || 'Cala did not answer'}. Ask again in the chat.</span></li>}
          {at < 1 && !failed && [0, 1].map((i) => <li key={`s${i}`}><i class="skel" style={{ width: `${52 + i * 18}%` }} /></li>)}
        </ul>
      </div>
    </div>
  )
}
