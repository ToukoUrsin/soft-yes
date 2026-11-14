import type { ReactNode } from 'react'
import type { RoundBrief, Source } from '../lib/api'
import { fmtDate, fmtMoney } from '../lib/format'
import { Sources } from './ui'

/** One funding round as a row: company, stage, amount, date, then context and the sources behind it. */
export function Deal({
  round, sources, children, dateNote,
}: {
  round: RoundBrief
  sources?: Source[] | null
  children?: ReactNode
  dateNote?: string
}) {
  const stage = round.stage && round.stage_name ? round.stage_name : ''
  const money = fmtMoney(round.amount, round.currency)
  const when = fmtDate(round.date)
  return (
    <li className="deal">
      <div className="deal__row">
        <span className="deal__co truncate" title={round.issuer?.name ?? undefined}>{round.issuer?.name ?? 'Unnamed company'}</span>
        <span className="deal__stage truncate">{stage}</span>
        <span className="deal__amt num">{money}</span>
        <time className="deal__when" title={dateNote}>{when}{dateNote && when ? <i aria-label={dateNote}>*</i> : null}</time>
      </div>
      {(children || (sources && sources.length > 0)) && (
        <div className="deal__sub">
          {children && <span className="deal__ctx">{children}</span>}
          <Sources sources={sources} />
        </div>
      )}
    </li>
  )
}
