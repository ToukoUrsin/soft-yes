// What a result opens on: the first lead, the page's sentence that says it led, and the message that asks for the intro.

import type { ReactNode } from 'react'
import type { Evidence, Lead, Result, SaysLine } from '../lib/api'
import { fmtMonth, listAnd } from '../lib/format'
import { CheckLabel, CheckNote, PageLink, Quote } from './Evidence'
import { SaysRow, type Tab } from './Leads'
import { DraftPane, useRunFounder } from './Tools'
import { Icon, Sources } from './ui'

/** The round behind the intro when its page says who led, else any round whose page does, else the intro's round. */
function proofRound(lead: Lead): Evidence | null {
  const rows = [lead.ask?.last, ...lead.evidence].filter((e): e is Evidence => !!e)
  return (lead.ring === 1 && rows.find((e) => e.check?.status === 'lead' && e.check.quote)) || rows[0] || null
}

export function Answer({
  lead, result, says, settled, onOpen, onOpenOther, children,
}: {
  lead: Lead
  result: Result
  says: SaysLine | 'reading' | null
  /** False while the walk still reads further and the first lead may change. */
  settled: boolean
  onOpen: (tab: Tab) => void
  /** Opens another lead of the list: the one this lead is level with. */
  onOpenOther?: (key: string) => void
  /** The page check, which closes the answer. */
  children?: ReactNode
}) {
  useRunFounder(result)
  const round = proofRound(lead)
  const check = lead.ring === 1 ? round?.check : null
  const said = check?.status === 'lead' && !!check.quote
  const where = round
    ? [round.issuer?.name, round.stage && round.stage_name ? round.stage_name : null, fmtMonth(round.date)].filter(Boolean).join(', ')
    : ''
  const withWhom = round && round.relation !== 'cap_table' && round.with.length ? `with ${listAnd(round.with)}` : ''
  const unnamed = round ? round.with.filter((_, i) => round.with_on_page?.[i] === false) : []
  // Cala's record does not always single one lead out: two can be level, or the rounds can be too few to rank.
  // What the page check took away from this lead: rounds Cala has it leading where the cited page names someone else.
  const wrong = lead.ring === 1
    ? new Set(result.page_check?.findings.filter((f) => f.kind === 'lead' && f.cala === lead.name).map((f) => f.round)).size
    : 0
  const held = lead.evidence.filter((e) => e.check?.status === 'lead').length
  const mode = result.start?.mode ?? 'pick'
  const level = mode === 'tie' ? result.leads.find((e) => e.key !== lead.key && result.start?.keys.includes(e.key)) : undefined
  return (
    <section className="answer" aria-label="Where to start">
      <div className="answer__lead">
        <div className="answer__title">
          {lead.ring === 1 && lead.rank != null && mode === 'pick' && <span className="answer__rank num">{lead.rank}</span>}
          <h2>
            <button type="button" className="name-link" onClick={() => onOpen('record')} title={`Open ${lead.name}`}>
              {lead.name}
            </button>
          </h2>
        </div>
        {level && (
          <p className="answer__level">
            Level with{' '}
            <button type="button" className="name-link" onClick={() => onOpenOther?.(level.key)}>{level.name}</button>
            {' '}on Cala’s record. Ask for both.
          </p>
        )}
        {mode === 'list' && (
          <p className="answer__level">
            Too few rounds to rank. One lead from a short list, not a first pick.
          </p>
        )}
        {said && check ? (
          <figure className="answer__proof">
            <Quote text={check.quote} hit={[lead.name]} />
            <figcaption>
              <CheckLabel status="lead" />
              <span className="answer__where">
                {where}
                {withWhom && <span className="faint">, {withWhom}</span>}
                {unnamed.length > 0 && <span className="faint"> (the page does not name {listAnd(unnamed)})</span>}
              </span>
              <PageLink url={check.url} publisher={check.publisher} />
            </figcaption>
          </figure>
        ) : (
          <div className="answer__proof answer__proof--plain">
            {lead.why[0] && <p className="answer__why">{lead.why[0].text}</p>}
            {round && (
              <p className="answer__round">
                <span className="answer__where">
                  {where}
                  {withWhom && <span className="faint">, {withWhom}</span>}
                </span>
                <Sources sources={round.sources} />
              </p>
            )}
            <CheckNote check={check} who={lead.name} promoted={round?.promoted} />
          </div>
        )}
        {wrong > 0 && (
          <p className="answer__cut">
            Cala has it leading <b className="num">{lead.evidence.length + wrong}</b> rounds your investors joined. The pages confirm{' '}
            <b className="num">{held}</b> and name another lead for <b className="num">{wrong}</b>.
          </p>
        )}
        {says && <SaysRow lead={lead} says={says} />}
        <button type="button" className="answer__more" onClick={() => onOpen('record')}>
          Its record
          <Icon name="arrow" size={13} />
        </button>
      </div>
      <div className="answer__msg">
        <div className="answer__msghead">
          <h2>The message</h2>
          <p>{lead.ask ? `To ${lead.ask.name}, asking for the introduction` : `To ${lead.name}, citing the shared deal`}</p>
        </div>
        <DraftPane lead={lead} result={result} kind={lead.ask ? 'intro_ask' : 'direct'} onChange={() => onOpen('reach')} wait={!settled} />
      </div>
      {children}
    </section>
  )
}
