import { useEffect, useReducer, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { api, investorHref, type Lead, type Result, type SaysLine, type Why } from '../lib/api'
import { capped, dealPhrase, fmtDate, fmtMoney, fmtMonth, listAnd, plural, possessive } from '../lib/format'
import { Deal } from './Deal'
import { Drafts, SaysDid, Slush } from './Tools'
import { CheckLabel } from './Evidence'
import { Icon, Investor, InvestorList, N, Segmented } from './ui'
import { YearBars } from './YearBars'

export type Tab = 'record' | 'reach' | 'before'

const TABS: { id: Tab; name: string }[] = [
  { id: 'record', name: 'Record' },
  { id: 'reach', name: 'Reach out' },
  { id: 'before', name: 'Before you meet' },
]

export function WhyList({ why }: { why: Why[] }) {
  return (
    <ul className="why">
      {why.map((w) => (
        <li key={w.text} className={`why__i why__i--${w.tone}`}>
          <i aria-hidden="true" />
          <span>{w.text}</span>
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------------------------------- list

/** A row carries the two reasons that rank it, plus anything that counts against it. The detail lists them all. */
function rowWhy(lead: Lead): Lead['why'] {
  // When a stage was asked, the line on that stage is one of the two: it moves the lead up or down the list.
  const fit = lead.fit?.line ? lead.why.find((w) => w.text === lead.fit?.line) : undefined
  const head = fit ? [lead.why[0], fit] : lead.why.slice(0, 2)
  return [...head, ...lead.why.slice(1).filter((w) => w.tone === 'warn' && !head.includes(w))].slice(0, 3)
}

// What the first five leads say on their own sites. A stored run carries it; a walk that just ended asks once.
const SAYS_ROWS = 5
type SaysRead = { status: 'reading' | 'done'; items: Map<string, SaysLine | null> }
const saysRead = new Map<string, SaysRead>()

function useSaysTop(result: Result, ready: boolean): SaysRead | null {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const missing = result.leads.slice(0, SAYS_ROWS).some((l) => l.says === undefined)
  useEffect(() => {
    if (!missing || !ready) return
    let alive = true
    const again = () => alive && bump()
    let read = saysRead.get(result.run_id)
    if (!read) {
      read = { status: 'reading', items: new Map() }
      saysRead.set(result.run_id, read)
      const mine = read
      api.saysTop(result.run_id).then(
        (r) => {
          for (const i of r.items) mine.items.set(i.key, i.says ?? null)
          mine.status = 'done'
          window.dispatchEvent(new Event('softyes:says'))
        },
        () => {
          // Nothing to show is a fine answer here: the tab still reads the site on request.
          mine.status = 'done'
          window.dispatchEvent(new Event('softyes:says'))
        },
      )
    }
    // Whoever asked first holds the read; everyone showing it draws again now that there is one.
    bump()
    window.addEventListener('softyes:says', again)
    return () => {
      alive = false
      window.removeEventListener('softyes:says', again)
    }
  }, [missing, ready, result.run_id])
  return missing ? (saysRead.get(result.run_id) ?? null) : null
}

/** What to put under a lead's row: its line, "reading" while it is fetched, or nothing. Only the first five have one. */
export function useSays(result: Result, settled: boolean): (l: Lead) => SaysLine | 'reading' | null {
  const read = useSaysTop(result, settled)
  const top = new Set(result.leads.slice(0, SAYS_ROWS).map((l) => l.key))
  return (l) => {
    if (!top.has(l.key)) return null
    if (l.says !== undefined) return l.says
    if (!read) return null
    return read.status === 'reading' ? 'reading' : (read.items.get(l.key) ?? null)
  }
}

/** One sentence from the investor's own site, word for word, over what it did in Cala. */
export function SaysRow({ lead, says, full }: { lead: Lead; says: SaysLine | 'reading'; full?: boolean }) {
  const [open, setOpen] = useState(false)
  if (says === 'reading') {
    return (
      <p className="lead-says lead-says--reading" role="status">
        <i aria-hidden="true" />
        Reading what {lead.name} says on its own site
      </p>
    )
  }
  return (
    <dl className="lead-says">
      <div>
        <dt>Says</dt>
        <dd>
          {full ? (
            <q className="lead-says__quote is-open">{says.quote}</q>
          ) : (
            <button
              type="button"
              className={`lead-says__quote${open ? ' is-open' : ''}`}
              aria-expanded={open}
              title={open ? undefined : says.quote}
              onClick={() => setOpen((o) => !o)}
            >
              <q>{says.quote}</q>
            </button>
          )}
          <a className="src" href={says.url} target="_blank" rel="noopener noreferrer" title={`Open the page on ${says.site}\n${says.url}`}>
            <span>{says.site}</span>
            <Icon name="out" size={11} />
          </a>
        </dd>
      </div>
      <div>
        <dt>Did</dt>
        <dd>{says.did}</dd>
      </div>
    </dl>
  )
}

function Row({
  lead, selected, onSelect, says,
}: { lead: Lead; selected: boolean; onSelect: (byKeyboard: boolean) => void; says?: SaysLine | 'reading' | null }) {
  const last = lead.pulse ? lead.last_led?.date : null
  return (
    <li className="lead-item" data-current={selected || undefined}>
      <button type="button" className="lead-row" aria-current={selected || undefined} data-lead={lead.key} onClick={(e) => onSelect(e.detail === 0)}>
        <span className="lead-row__rank num">{lead.ring === 1 ? lead.rank : ''}</span>
        <span className="lead-row__body">
          <span className="lead-row__head">
            <span className="lead-row__name truncate" title={lead.name}>{lead.name}</span>
            {lead.kind === 'person' && <span className="tag">Person</span>}
            {lead.at_slush && (
              <span className="tag" title={`${plural(lead.at_slush.people, 'person', 'people')} from ${lead.at_slush.firm} registered for Slush`}>At Slush</span>
            )}
          </span>
          <WhyList why={rowWhy(lead)} />
        </span>
        <span className="lead-row__side">
          {lead.pulse?.by_year?.length ? (
            <YearBars data={lead.pulse.by_year} variant="spark" label={`${lead.name}, rounds per year`} />
          ) : (
            <span className="lead-row__noread">{lead.pulse ? 'from a report' : 'not read'}</span>
          )}
          {last && (
            <span className="lead-row__last">
              last led <time>{fmtMonth(last)}</time>
            </span>
          )}
        </span>
      </button>
      {says && <SaysRow lead={lead} says={says} />}
    </li>
  )
}

export function LeadList({
  result, selected, onSelect, settled = true,
}: {
  result: Result
  selected: string | null
  onSelect: (key: string, byKeyboard: boolean) => void
  /** False while the walk is still reading further: the list may yet change, so nothing slow is asked for it. */
  settled?: boolean
}) {
  const saysFor = useSays(result, settled)
  return (
    <div className="leads" role="navigation" aria-label="Ranked leads">
      {(result.tiers?.length ? result.tiers : [null]).map((t) => (
        <div key={t?.id ?? 'all'} className="leads__tier">
          {t && (
            <div className={`leads__tierhead leads__tierhead--${t.id}`}>
              <h3>
                <i aria-hidden="true" />
                {t.label}<N>{t.count}</N>
              </h3>
              <p>{t.note}</p>
            </div>
          )}
          <ol className="leads__list">
            {result.leads.filter((l) => !t || l.tier === t.id).map((l) => (
              <Row key={l.key} lead={l} selected={selected === l.key} onSelect={(kb) => onSelect(l.key, kb)} says={saysFor(l)} />
            ))}
          </ol>
        </div>
      ))}
      {result.second_ring.length > 0 && (
        <>
          <div className="leads__ring">
            <h3>Second ring</h3>
            <p>Sat in those rounds without leading, but lead elsewhere.</p>
          </div>
          <ol className="leads__list">
            {result.second_ring.map((l) => (
              <Row key={l.key} lead={l} selected={selected === l.key} onSelect={(kb) => onSelect(l.key, kb)} />
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------- the path

/** Soft yes -> the deal -> the lead. The same three marks as the graph. */
export function PathStrip({ soft, deal, lead, led }: { soft: string; deal: ReactNode; lead: string; led: boolean }) {
  return (
    <div className="strip" aria-hidden="true">
      <span className="strip__node"><i className="strip__soft" /><span className="truncate">{soft}</span></span>
      <i className="strip__line" />
      <span className="strip__node strip__node--deal"><i className="strip__deal" /><span className="truncate">{deal}</span></span>
      <i className={`strip__line${led ? ' strip__line--lead' : ''}`} />
      <span className="strip__node"><i className={led ? 'strip__lead' : 'strip__co'} /><span className="truncate">{lead}</span></span>
    </div>
  )
}

/** A round Cala's knowledge search read in a report, rather than a funding-round entity in its graph. */
export function ReportTag() {
  return (
    <span className="via" title="Cala’s knowledge search found this round in the page cited. It is kept only because that page names both the company and the lead.">
      from a report
    </span>
  )
}

// ----------------------------------------------------------------------------------------- detail

/** Who to ask for the introduction, and the round that ties them to the lead. */
function Intro({ lead }: { lead: Lead }) {
  const ask = lead.ask
  if (!ask) return null
  const led = lead.ring === 1
  const others = lead.asks.filter((a) => a.key !== ask.key)
  const stageName = (d: { stage: string | null; stage_name: string | null }) => (d.stage && d.stage_name ? d.stage_name.toLowerCase().replace(/series ([a-z])/, (_, c: string) => `Series ${c.toUpperCase()}`) : 'round')
  return (
        <section className="ov__sec ov__warm">
          <h3>Ask {ask.name} for the intro</h3>
          <p className="ov__lede">
            {ask.last.relation === 'cap_table' ? (
              <>
                <Investor name={ask.name} /> backs {ask.last.issuer?.name ?? 'a company'}, and {lead.name} led its{' '}
                {fmtMoney(ask.last.amount, ask.last.currency) ? `${fmtMoney(ask.last.amount, ask.last.currency)} ` : ''}
                {stageName(ask.last)}
                {fmtMonth(ask.last.date) ? ` in ${fmtMonth(ask.last.date)}` : ''}. Cala does not list {ask.name} in that round itself.
              </>
            ) : (
              <>
                <Investor name={ask.name} /> was in {ask.last.issuer?.name ? possessive(ask.last.issuer.name) : 'a company’s'}{' '}
                {fmtMoney(ask.last.amount, ask.last.currency) ? `${fmtMoney(ask.last.amount, ask.last.currency)} ` : ''}
                {stageName(ask.last)}
                {fmtMonth(ask.last.date) ? ` in ${fmtMonth(ask.last.date)}` : ''}
                {led ? `, which ${lead.name} led` : `, where ${lead.name} also invested`}.
              </>
            )}
            {ask.deals > 1 ? ` They share ${plural(ask.deals, 'round')} in Cala; this is the latest.` : ''}
          </p>
          <PathStrip
            soft={ask.name}
            deal={[ask.last.issuer?.name, ask.last.stage && ask.last.stage_name ? ask.last.stage_name : null].filter(Boolean).join(', ') || 'Shared round'}
            lead={lead.name}
            led={led}
          />
          {others.length > 0 && (
            <p className="faint ov__also">
              Also shares {others.map((o) => `${plural(o.deals, 'round')} with ${o.name}`).join(', ')}.
            </p>
          )}
        </section>
  )
}

function Record({ lead, onReach }: { lead: Lead; onReach: () => void }) {
  const p = lead.pulse
  const led = lead.ring === 1
  const evidenceIds = new Set(lead.evidence.map((e) => e.id))
  const otherLed = lead.recent_leads.filter((r) => !evidenceIds.has(r.id))
  const checked = led ? lead.checked ?? 0 : 0
  const confirmed = lead.confirmed ?? 0
  return (
    <div className="ov">
      <section className="ov__sec">
        <div className="ov__head">
          <h3>
            {!led
              ? 'Rounds it shared with your investors'
              : lead.evidence.every((e) => e.relation === 'cap_table')
                ? 'Rounds it led in companies your investors back'
                : 'Rounds it led that your investors joined'}
            <N>{lead.evidence.length}</N>
          </h3>
          {checked > 0 && (
            <CheckLabel status={confirmed > 0 ? 'lead' : 'unstated'}>
              {confirmed === checked && checked === 1 ? 'Confirmed on the page' : `${confirmed} of ${checked} confirmed on the page`}
            </CheckLabel>
          )}
        </div>
        <ul className="deals">
          {lead.evidence.map((e) => (
            <Deal
              key={e.id}
              round={e}
              sources={e.sources}
              dateNote={e.date_is_report ? 'Date the round was first reported' : undefined}
              caution={e.caution}
              setAside={e.amount_set_aside}
              check={led ? e.check : null}
              who={lead.name}
              promoted={e.promoted}
              stagePage={e.stage_page}
            >
              {e.relation === 'cap_table' ? (
                <>
                  <InvestorList names={e.with} /> {e.with.length === 1 ? 'backs' : 'back'} the company, not listed in this round
                </>
              ) : (
                <>
                  with <InvestorList names={e.with} />
                  {e.with.some((_, i) => e.with_on_page?.[i] === false) && (
                    <span className="faint" title="Cala lists it as an investor in this round. The page it cites was read and does not name it.">
                      {' '}(the announcement does not name {listAnd(e.with.filter((_, i) => e.with_on_page?.[i] === false))})
                    </span>
                  )}
                </>
              )}
              {e.via === 'knowledge' && (
                <>
                  <span className="sep"> · </span>
                  <ReportTag />
                </>
              )}
              {e.co_leads.length > 0 && (
                <>
                  <span className="sep"> · </span>
                  {led ? 'co-led by ' : 'led by '}
                  <InvestorList names={e.co_leads} doubt={e.co_doubt} />
                </>
              )}
              {e.investors != null && e.investors > 0 && (
                <>
                  <span className="sep"> · </span>
                  <span className="num">{plural(e.investors, 'investor')}</span>
                </>
              )}
            </Deal>
          ))}
        </ul>
        {lead.ask && (
          <div className="ov__actions">
            <button type="button" className="btn" onClick={onReach}>
              Ask {lead.ask.name} for the intro
              <Icon name="arrow" size={14} />
            </button>
          </div>
        )}
      </section>

      <section className="ov__sec">
        <h3>Does it still lead?</h3>
        {p && p.rounds === 0 ? (
          <p className="ov__lede muted">
            Cala’s graph holds no funding rounds under this name, so there is nothing to count.{' '}
            {lead.name} is here because a report Cala’s knowledge search read names it as the lead. Open the source above before you rely on it.
          </p>
        ) : p ? (
          <>
            <p className="ov__lede">
              Cala marks it as lead in <b className="num">{p.led}</b> of <b className="num">{capped(p.rounds, p.capped)}</b> {p.rounds === 1 ? 'round' : 'rounds'}
              {p.led_recent > 0 ? (
                <>
                  , <b className="num">{p.led_recent}</b> in the last {p.recent_months} months.
                </>
              ) : (
                <>. None of them is dated in the last {p.recent_months} months.</>
              )}
              {p.led_read ? (
                <>
                  {' '}
                  Soft Yes has read the cited page for <b className="num">{p.led_read}</b> of those so far:{' '}
                  <b className="num">{p.led_on_page ?? 0}</b> {p.led_on_page === 1 ? 'says' : 'say'} it led.
                </>
              ) : p.led > 0 ? (
                ' No page has been read for those yet.'
              ) : null}
              {p.capped && ' Cala returns 50 rounds at most, so the real count is higher.'}
              {p.rounds <= 2 && !p.capped && ' Cala’s record of it is thin, so read this as a floor.'}
            </p>
            <YearBars data={p.by_year} variant="full" label={`${lead.name}, rounds per year`} />
            <dl className="facts">
              {lead.fit && (
                <div>
                  <dt>{lead.fit.stage_name}</dt>
                  <dd className={lead.fit.match ? 'is-good' : 'is-warn'}>
                    <i aria-hidden="true" />
                    {lead.fit.match ? `Has led ${plural(lead.fit.led_at_stage, 'round')} at this stage in Cala` : `No ${lead.fit.stage_name} lead in Cala`}
                  </dd>
                </div>
              )}
              {p.led_stages.length > 0 && (
                <div>
                  <dt>Stages it led</dt>
                  <dd>
                    {p.led_stages.map((s, i) => (
                      <span key={s.stage}>
                        {i > 0 && <span className="sep">, </span>}
                        {s.stage} <span className="num faint">{s.n}</span>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {lead.typical_round && (
                <div>
                  <dt>Round sizes it led</dt>
                  <dd className="num">
                    {lead.typical_round.min === lead.typical_round.max
                      ? fmtMoney(lead.typical_round.min, 'EUR').replace('€', '')
                      : `${fmtMoney(lead.typical_round.min, 'EUR').replace('€', '')} to ${fmtMoney(lead.typical_round.max, 'EUR').replace('€', '')}`}
                    <span className="faint"> across {plural(lead.typical_round.n, 'round')} with a stated amount, euros and dollars alike</span>
                  </dd>
                </div>
              )}
              {p.portfolio_size > 0 && (
                <div>
                  <dt>Portfolio in Cala</dt>
                  <dd className="num">{plural(p.portfolio_size, 'company', 'companies')}</dd>
                </div>
              )}
            </dl>
          </>
        ) : (
          <p className="ov__lede muted">
            This walk read the full record of its top leads only, and {lead.name} was outside them.{' '}
            <Link className="link" href={investorHref(lead.ids, lead.name)}>Read its record</Link> to see how often it leads.
          </p>
        )}
        {otherLed.length > 0 && (
          <>
            <h4 className="ov__h4">Latest other rounds it led</h4>
            <ul className="deals">
              {otherLed.map((r) => (
                <Deal key={r.id} round={r} sources={r.sources} check={r.check} who={lead.name} stagePage={r.stage_page} />
              ))}
            </ul>
          </>
        )}
        {lead.last_led && !otherLed.length && p && p.rounds > 0 && (
          <p className="faint ov__note">
            Most recent round it led in Cala: {dealPhrase({ ...lead.last_led, date: null })}{lead.last_led.date ? `, ${fmtDate(lead.last_led.date)}` : ''}.
          </p>
        )}
      </section>
    </div>
  )
}

export function LeadDetail({
  lead, result, tab, onTab, onClose,
}: {
  lead: Lead
  result: Result
  tab: Tab
  onTab: (t: Tab) => void
  onClose?: () => void
}) {
  const softNames = Array.from(new Set(lead.evidence.flatMap((e) => e.with)))
  // The one caution that puts the whole lead in doubt gets its own line; the rest stay as short reasons.
  const doubtWhy = lead.why.find((w) => w.tone === 'warn' && /wrong company/i.test(w.text))
  const doubt = lead.doubt?.text ?? (lead.wrong_entity || doubtWhy ? 'Cala may have tied this name to the wrong company. Read the sources before you use it.' : null)
  return (
    <article className="detail" aria-label={lead.name} tabIndex={-1}>
      <header className="detail__head">
        <div className="detail__title">
          {onClose && (
            <button type="button" className="btn btn--ghost detail__close" onClick={onClose} aria-label="Back to the list">
              <Icon name="x" />
            </button>
          )}
          {lead.ring === 1 && lead.rank != null && <span className="detail__rank num">{lead.rank}</span>}
          <h2 className="truncate" title={lead.name}>{lead.name}</h2>
          <Link className="btn btn--ghost btn--sm detail__check" href={investorHref(lead.ids, lead.name)}>
            Lead or follow?
            <Icon name="arrow" size={13} />
          </Link>
        </div>
        <p className="detail__meta">
          {lead.ring !== 1
            ? `Second ring: sat in ${plural(lead.evidence.length, 'round')} with ${listAnd(softNames)} without leading`
            : lead.evidence.every((e) => e.relation === 'cap_table')
              ? `Led ${plural(lead.evidence.length, 'round')} in companies ${listAnd(softNames)} ${softNames.length === 1 ? 'backs' : 'back'}`
              : `Led ${plural(lead.evidence.length, 'round')} that ${listAnd(softNames)} joined${lead.evidence.some((e) => e.relation === 'cap_table') ? ', or in companies they back' : ''}`}
          {lead.kind === 'person' ? ' · a person, not a fund' : ''}
          {lead.also_named?.length ? ` · Cala also lists it as ${listAnd(lead.also_named.map((a) => a.name))}` : ''}
          <span className="detail__check2">
            <span className="sep"> · </span>
            <Link className="link" href={investorHref(lead.ids, lead.name)}>Lead or follow?</Link>
          </span>
        </p>
        <WhyList why={lead.why.slice(1).filter((w) => w !== doubtWhy)} />
        {doubt && (
          <p className="notice detail__doubt">
            <Icon name="alert" size={14} />
            {doubt}
          </p>
        )}
      </header>
      <div className="detail__tabs">
        <Segmented options={TABS} value={tab} onChange={onTab} label="About this lead" role="tablist" />
      </div>
      <div className="detail__body" key={`${lead.key}:${tab}`}>
        {tab === 'record' && <Record lead={lead} onReach={() => onTab('reach')} />}
        {tab === 'reach' && (
          <div className="ov">
            <Intro lead={lead} />
            <section className="ov__sec">
              <h3>The message</h3>
              <Drafts lead={lead} result={result} />
            </section>
            <section className="ov__sec">
              <h3>At Slush</h3>
              <Slush lead={lead} result={result} />
            </section>
          </div>
        )}
        {tab === 'before' && (
          <div className="ov">
            <section className="ov__sec">
              <h3>What it says, what it did</h3>
              <SaysDid lead={lead} result={result} />
            </section>
          </div>
        )}
      </div>
    </article>
  )
}
