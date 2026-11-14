import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { investorHref, type Lead, type Result, type Why } from '../lib/api'
import { capped, dealPhrase, fmtDate, fmtMoney, fmtMonth, listAnd, plural } from '../lib/format'
import { Deal } from './Deal'
import { AskCala, Conflicts, Drafts, References, SaysDid, Slush } from './Tools'
import { Icon, Investor, InvestorList, Segmented } from './ui'
import { YearBars } from './YearBars'

export type Tab = 'overview' | 'drafts' | 'says' | 'conflicts' | 'refs' | 'slush' | 'ask'

const TABS: { id: Tab; name: string }[] = [
  { id: 'overview', name: 'Evidence' },
  { id: 'drafts', name: 'Drafts' },
  { id: 'says', name: 'Says vs did' },
  { id: 'conflicts', name: 'Conflicts' },
  { id: 'refs', name: 'References' },
  { id: 'slush', name: 'At Slush' },
  { id: 'ask', name: 'Ask Cala' },
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
  const head = lead.why.slice(0, 2)
  return [...head, ...lead.why.slice(2).filter((w) => w.tone === 'warn')].slice(0, 3)
}

function Row({ lead, selected, onSelect }: { lead: Lead; selected: boolean; onSelect: (byKeyboard: boolean) => void }) {
  const last = lead.pulse ? lead.last_led?.date : null
  return (
    <li>
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
    </li>
  )
}

export function LeadList({
  result, selected, onSelect,
}: { result: Result; selected: string | null; onSelect: (key: string, byKeyboard: boolean) => void }) {
  return (
    <div className="leads" role="navigation" aria-label="Ranked leads">
      {(result.tiers?.length ? result.tiers : [null]).map((t) => (
        <div key={t?.id ?? 'all'} className="leads__tier">
          {t && (
            <div className={`leads__tierhead leads__tierhead--${t.id}`}>
              <h3>
                <i aria-hidden="true" />
                {t.label}
                <span className="count num">{t.count}</span>
              </h3>
              <p>{t.note}</p>
            </div>
          )}
          <ol className="leads__list">
            {result.leads.filter((l) => !t || l.tier === t.id).map((l) => (
              <Row key={l.key} lead={l} selected={selected === l.key} onSelect={(kb) => onSelect(l.key, kb)} />
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

function Overview({ lead, onDraft }: { lead: Lead; onDraft: () => void }) {
  const p = lead.pulse
  const ask = lead.ask
  const led = lead.ring === 1
  const others = lead.asks.filter((a) => a.key !== ask?.key)
  const stageName = (d: { stage: string | null; stage_name: string | null }) => (d.stage && d.stage_name ? d.stage_name.toLowerCase().replace(/series ([a-z])/, (_, c: string) => `Series ${c.toUpperCase()}`) : 'round')
  const evidenceIds = new Set(lead.evidence.map((e) => e.id))
  const otherLed = lead.recent_leads.filter((r) => !evidenceIds.has(r.id))
  return (
    <div className="ov">
      {ask && (
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
                <Investor name={ask.name} /> was in {ask.last.issuer?.name ?? 'a company'}’s{' '}
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
          <div className="ov__actions">
            <button type="button" className="btn" onClick={onDraft}>
              Draft the ask
              <Icon name="arrow" size={14} />
            </button>
            {others.length > 0 && (
              <span className="faint">
                Also shares {others.map((o) => `${plural(o.deals, 'round')} with ${o.name}`).join(', ')}.
              </span>
            )}
          </div>
        </section>
      )}

      <section className="ov__sec">
        <h3>
          {!led
            ? 'Rounds it shared with your investors'
            : lead.evidence.every((e) => e.relation === 'cap_table')
              ? 'Rounds it led in companies your investors back'
              : 'Rounds it led that your investors joined'}
          <span className="count num">{lead.evidence.length}</span>
        </h3>
        <ul className="deals">
          {lead.evidence.map((e) => (
            <Deal
              key={e.id}
              round={e}
              sources={e.sources}
              dateNote={e.date_is_report ? 'Date the round was first reported' : undefined}
              caution={e.caution}
              setAside={e.amount_set_aside}
            >
              {e.relation === 'cap_table' ? (
                <>
                  <InvestorList names={e.with} /> {e.with.length === 1 ? 'backs' : 'back'} the company, not listed in this round
                </>
              ) : (
                <>
                  with <InvestorList names={e.with} />
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
                  <InvestorList names={e.co_leads} />
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
              Led <b className="num">{p.led}</b> of <b className="num">{capped(p.rounds, p.capped)}</b> {p.rounds === 1 ? 'round' : 'rounds'} in Cala
              {p.led_recent > 0 ? (
                <>
                  , <b className="num">{p.led_recent}</b> in the last {p.recent_months} months.
                </>
              ) : (
                <>. None of them is dated in the last {p.recent_months} months.</>
              )}
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
                <Deal key={r.id} round={r} sources={r.sources} />
              ))}
            </ul>
          </>
        )}
        {lead.last_led && !otherLed.length && p && p.rounds > 0 && (
          <p className="faint ov__note">
            Most recent round it led in Cala: {dealPhrase(lead.last_led)}{lead.last_led.date ? `, ${fmtDate(lead.last_led.date)}` : ''}.
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
          <span className="detail__check2">
            <span className="sep"> · </span>
            <Link className="link" href={investorHref(lead.ids, lead.name)}>Lead or follow?</Link>
          </span>
        </p>
        <WhyList why={lead.why.slice(1)} />
      </header>
      <div className="detail__tabs">
        <Segmented options={TABS} value={tab} onChange={onTab} label="About this lead" role="tablist" />
      </div>
      <div className="detail__body" key={`${lead.key}:${tab}`}>
        {tab === 'overview' && <Overview lead={lead} onDraft={() => onTab('drafts')} />}
        {tab === 'drafts' && <Drafts lead={lead} result={result} />}
        {tab === 'says' && <SaysDid lead={lead} result={result} />}
        {tab === 'conflicts' && <Conflicts lead={lead} result={result} />}
        {tab === 'refs' && <References lead={lead} result={result} />}
        {tab === 'slush' && <Slush lead={lead} result={result} />}
        {tab === 'ask' && <AskCala lead={lead} result={result} />}
      </div>
    </article>
  )
}
