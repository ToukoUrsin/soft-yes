import type { ReactNode } from 'react'
import type { Check, RoundBrief, SetAside, Source, StagePage } from '../lib/api'
import { fmtDate, fmtMoney, fmtMonth } from '../lib/format'
import { CheckNote, StageNote } from './Evidence'
import { Icon, Sources } from './ui'

/** One funding round as a row: company, stage, amount, date, the context, and what the cited page says about who led. */
export function Deal({
  round, sources, children, dateNote, caution, setAside, check, who, promoted, stagePage,
}: {
  round: RoundBrief
  sources?: Source[] | null
  children?: ReactNode
  dateNote?: string
  /** Why a fact on this row should be read with care. */
  caution?: string | null
  /** An amount Cala holds for the round that its sources do not back for this round. */
  setAside?: SetAside | null
  /** What the page Cala cites says about `who` leading this round. */
  check?: Check | null
  who?: string
  /** The page says it led; Cala had not flagged it. */
  promoted?: boolean
  stagePage?: StagePage | null
}) {
  const stage = round.stage && round.stage_name ? round.stage_name : ''
  const money = fmtMoney(round.amount, round.currency)
  const when = fmtDate(round.date)
  return (
    <li className={`deal${check?.status === 'follower' ? ' deal--fix' : ''}`}>
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
      <CheckNote check={check} who={who} promoted={promoted} />
      <StageNote stage={stagePage} />
      {caution && (
        <p className="deal__note">
          <Icon name="alert" size={12} />
          <span>{caution}</span>
        </p>
      )}
      {setAside && (
        <p className="chk__aside">
          <span>Amount</span>
          {setAside.why === 'page' || !setAside.reported
            ? `Cala lists ${fmtMoney(setAside.amount, setAside.currency) || 'one'}. No page it cites for this round states it, so none is shown.`
            : `Cala lists ${fmtMoney(setAside.amount, setAside.currency) || 'one'}, from a page dated ${fmtMonth(setAside.reported)}, before this round. None is shown.`}
        </p>
      )}
    </li>
  )
}
