import type { ReactNode } from 'react'
import type { RoundBrief, Source } from '../lib/api'
import { fmtDate, fmtMoney, fmtMonth } from '../lib/format'
import { Icon, Sources } from './ui'

/** One funding round as a row: company, stage, amount, date, then context and the sources behind it. */
export function Deal({
  round, sources, children, dateNote, caution, setAside,
}: {
  round: RoundBrief
  sources?: Source[] | null
  children?: ReactNode
  dateNote?: string
  /** Why a fact on this row should be read with care. */
  caution?: string | null
  /** An amount Cala holds for the round that its sources do not back for this round. */
  setAside?: { amount: number; currency: string | null; reported: string } | null
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
      {caution && (
        <p className="deal__note">
          <Icon name="alert" size={12} />
          <span>{caution}</span>
        </p>
      )}
      {setAside && (
        <p className="deal__note deal__note--plain">
          <span>
            No amount shown: Cala lists {fmtMoney(setAside.amount, setAside.currency) || 'one'}, but the only page behind it is from{' '}
            {fmtMonth(setAside.reported)}, before this round.
          </span>
        </p>
      )}
    </li>
  )
}
