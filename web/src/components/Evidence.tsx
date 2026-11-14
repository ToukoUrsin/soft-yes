// The page check, shown: what the page Cala cites says about a "led" claim, in the page's own words.

import type { CSSProperties, ReactNode } from 'react'
import type { AmountFinding, Check, CheckStatus, ConfirmedRow, LeadFinding, StageFinding, StagePage } from '../lib/api'
import { cleanQuote, fmtMoney, fmtMonth, host, listAnd, possessive, stageWord } from '../lib/format'
import { Icon } from './ui'

// --------------------------------------------------------------------------------------- the sentence

const GENERIC = /[\s,]+(capital|ventures?|venture partners|partners|vc|fund|funds|group|management|growth|holdings?|investments?|oy|ab|ltd|inc|llc|gmbh)\.?$/i
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** How a page may write a name: in full, or without "Capital", "Ventures" and the like ("Sequoia led the Series D"). */
function forms(name: string): string[] {
  const out = [name.trim()]
  let short = name.trim()
  for (let i = 0; i < 2 && GENERIC.test(short); i++) short = short.replace(GENERIC, '')
  if (short.length >= 4 && short !== out[0]) out.push(short)
  const bare = name.replace(/\.(vc|io|com|ai)$/i, '')
  if (bare.length >= 4 && bare !== name) out.push(bare)
  return out
}

/** The page's sentence, with the names it turns on marked. `hit`: who led, as the page has it. `also`: who Cala named. */
export function Quote({ text, hit = [], also = [] }: { text: string | null | undefined; hit?: string[]; also?: string[] }) {
  const clean = cleanQuote(text)
  if (!clean) return null
  const want: { re: string; cls: string }[] = []
  for (const [names, cls] of [[hit, 'quote__hit'], [also, 'quote__also']] as const) {
    for (const n of names) {
      const found = forms(n).find((f) => clean.toLowerCase().includes(f.toLowerCase()))
      if (found) want.push({ re: esc(found), cls })
    }
  }
  let parts: ReactNode[] = [clean]
  if (want.length) {
    want.sort((a, b) => b.re.length - a.re.length)
    const re = new RegExp(`(${want.map((w) => w.re).join('|')})`, 'gi')
    parts = clean.split(re).map((p, i) => {
      const w = want.find((x) => new RegExp(`^${x.re}$`, 'i').test(p))
      return w ? <mark key={i} className={w.cls}>{p}</mark> : p
    })
  }
  return <blockquote className="quote">{parts}</blockquote>
}

export function PageLink({ url, publisher }: { url: string | null | undefined; publisher?: string | null }) {
  if (!url) return null
  const name = (publisher || host(url)).replace(/^www\./, '')
  return (
    <a className="src pagelink" href={url} target="_blank" rel="noopener noreferrer" title={`Open the page\n${url}`}>
      <span>{name}</span>
      <Icon name="out" size={11} />
    </a>
  )
}

// ------------------------------------------------------------------------------- one claim on a round

type Tone = 'ok' | 'plain' | 'fix'
const STATUS: Record<CheckStatus, { label: string; tone: Tone; tip: string }> = {
  lead: { label: 'On the page', tone: 'ok', tip: 'The page Cala cites says, in these words, that it led this round.' },
  report: { label: 'From a report', tone: 'plain', tip: 'This round comes from a report Cala read, not from a page about the round.' },
  follower: { label: 'Page names another lead', tone: 'fix', tip: 'The page lists it in the round under a different lead.' },
  unstated: { label: 'Named, not as lead', tone: 'plain', tip: 'The page names it in the round but does not say it led.' },
  other: { label: 'Led another round', tone: 'plain', tip: 'The page says it led a different round of this company.' },
  absent: { label: 'Not on the page', tone: 'plain', tip: 'The page Cala cites was read and does not name it.' },
  off: { label: 'Page is about something else', tone: 'plain', tip: 'The page Cala cites is not about this round.' },
  unread: { label: 'Page could not be read', tone: 'plain', tip: 'The page Cala cites did not open, so the claim is Cala’s alone.' },
}

const ledBy = (c: Check): string[] => c.led_by ?? []

export function CheckLabel({ status, children }: { status: CheckStatus; children?: ReactNode }) {
  const s = STATUS[status] ?? STATUS.unread
  return (
    <span className={`chk__label chk__label--${s.tone}`} title={s.tip}>
      {s.tone === 'ok' ? <Icon name="check" size={12} /> : s.tone === 'fix' ? <Icon name="alert" size={12} /> : <i aria-hidden="true" />}
      {children ?? s.label}
    </span>
  )
}

/**
 * Under a round: what the page says about the investor the row is about.
 * `who` is that investor, so its name can be marked in the sentence.
 */
export function CheckNote({ check, who, promoted }: { check: Check | null | undefined; who?: string; promoted?: boolean }) {
  if (!check) return null
  const others = ledBy(check)
  const fix = check.status === 'follower'
  const isLead = check.status === 'lead'
  const me = who ? [who] : []
  return (
    <div className={`chk${fix ? ' chk--fix' : ''}`}>
      <p className="chk__head">
        <CheckLabel status={check.status}>
          {check.status === 'other' && check.other_round ? `Page says it led the ${stageWord(check.other_round)}` : undefined}
        </CheckLabel>
        {promoted && <span className="chk__more">Cala had not marked it as lead</span>}
        {others.length > 0 && (
          <span className={fix ? 'chk__page' : 'chk__more'}>
            The page: <b>{listAnd(others)}</b> led
          </span>
        )}
        <PageLink url={check.url} publisher={check.publisher} />
      </p>
      <Quote text={check.quote} hit={isLead ? me : others} also={isLead ? [] : me} />
    </div>
  )
}

/** Cala's stage label next to the page's. */
export function StageNote({ stage }: { stage: StagePage | null | undefined }) {
  if (!stage) return null
  return (
    <p className="chk__aside">
      <span>Stage</span>
      Cala says {stageWord(stage.cala)}. {stage.page ? `The page says ${stageWord(stage.page)}.` : 'The page names no stage, so none is shown.'}
    </p>
  )
}

// ----------------------------------------------------------------------------- rows of the audit list

function When({ row }: { row: { stage_name: string | null; date: string | null } }) {
  const when = fmtMonth(row.date)
  return when ? <time className="find__when num">{when}</time> : null
}

const claim = (cala: string, row: { company: string; stage_name: string | null }) =>
  `${cala} led ${possessive(row.company)} ${stageWord(row.stage_name)}`

/** A lead claim the page confirms word for word. */
export function ConfirmedItem({ row, index }: { row: ConfirmedRow; index?: number }) {
  return (
    <li className="find" style={index != null ? ({ '--i': index } as CSSProperties) : undefined}>
      <p className="find__line">
        <span className="find__who">Cala</span>
        <span className="find__claim">{claim(row.cala, row)}</span>
        <When row={row} />
      </p>
      <div className="find__line">
        <span className="find__who">Page</span>
        <Quote text={row.quote} hit={[row.cala]} />
        <PageLink url={row.url} publisher={row.publisher} />
      </div>
    </li>
  )
}

/** Cala names one lead, the page another. */
export function LeadFix({ row }: { row: LeadFinding }) {
  return (
    <li className="find find--fix">
      <p className="find__line">
        <span className="find__who">Cala</span>
        <span className="find__claim find__claim--was">{claim(row.cala, row)}</span>
        <When row={row} />
      </p>
      <div className="find__line">
        <span className="find__who">Page</span>
        <span className="find__claim find__claim--is">
          {row.page.length ? `${listAnd(row.page)} led` : row.other_round ? `It led the ${stageWord(row.other_round)}` : 'Someone else led'}
        </span>
      </div>
      {(row.quote || row.url) && (
        <div className="find__line">
          <span className="find__who" aria-hidden="true" />
          <Quote text={row.quote} hit={row.page} also={[row.cala]} />
          <PageLink url={row.url} publisher={row.publisher} />
        </div>
      )}
    </li>
  )
}

function Pages({ urls }: { urls: string[] }) {
  const seen = new Set<string>()
  const list = urls.filter((u) => !seen.has(host(u)) && seen.add(host(u))).slice(0, 3)
  return (
    <span className="sources">
      {list.map((u) => <PageLink key={u} url={u} />)}
    </span>
  )
}

/** An amount Cala gives that no page it cites for the round states. */
export function AmountFix({ row }: { row: AmountFinding }) {
  return (
    <li className="find find--row">
      <span className="find__co truncate">{row.company}</span>
      <span className="find__what">
        <span className="find__who">Cala</span>
        <span className="num">{fmtMoney(row.amount, row.currency) || 'an amount'}</span>
        <span className="faint">{row.stage_name && row.stage_name !== 'Round' ? stageWord(row.stage_name) : ''}</span>
      </span>
      <When row={row} />
      <Pages urls={row.pages} />
    </li>
  )
}

/** A stage label Cala gives that the page does not use. */
export function StageFix({ row }: { row: StageFinding }) {
  return (
    <li className="find find--row">
      <span className="find__co truncate">{row.company}</span>
      <span className="find__what">
        <span className="find__who">Cala</span>
        <span>{row.cala}</span>
        <span className="find__who">Page</span>
        <span className={row.page ? '' : 'faint'}>{row.page ?? 'no stage named'}</span>
      </span>
      <When row={row} />
      <Pages urls={row.pages} />
    </li>
  )
}

// ----------------------------------------------------------------------------------- the claims strip

/** One mark per lead claim: solid where the page confirms it, amber where it corrects it, open where it does not say. */
export function ClaimStrip({
  confirmed, corrected, open, reading = 0, max = 72,
}: { confirmed: number; corrected: number; open: number; reading?: number; max?: number }) {
  const total = confirmed + corrected + open
  if (reading > 0 && !total) {
    const n = Math.min(reading, max)
    return (
      <span className="strip2 strip2--reading" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => <i key={i} style={{ '--i': i, '--n': n } as CSSProperties} />)}
      </span>
    )
  }
  if (!total) return null
  // More claims than marks: keep the proportions, and never drop a correction.
  const k = total > max ? max / total : 1
  const fix = corrected ? Math.max(1, Math.round(corrected * k)) : 0
  const gap = open ? Math.max(1, Math.round(open * k)) : 0
  const ok = Math.max(0, Math.round(total * k) - fix - gap)
  return (
    <span className="strip2" aria-hidden="true">
      {Array.from({ length: ok }, (_, i) => <i key={`o${i}`} className="is-ok" style={{ '--i': i } as CSSProperties} />)}
      {Array.from({ length: fix }, (_, i) => <i key={`f${i}`} className="is-fix" style={{ '--i': ok + i } as CSSProperties} />)}
      {Array.from({ length: gap }, (_, i) => <i key={`g${i}`} className="is-open" style={{ '--i': ok + fix + i } as CSSProperties} />)}
    </span>
  )
}
