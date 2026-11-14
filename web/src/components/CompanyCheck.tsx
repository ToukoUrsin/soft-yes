// The page check for one company: its rounds in Cala, who Cala says led each, and what the cited pages say.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type ApiError, type CompanyCheck as Result, type CompanyRound } from '../lib/api'
import { fmtMoney, fmtMonth, plural, stageWord } from '../lib/format'
import { CheckNote, ConfirmedItem, LeadFix, PageLink, Quote } from './Evidence'
import { Icon } from './ui'
import '../styles/check.css'

const TRY = ['Verda', 'Measur', 'Lovable', 'Wolt']

function readParam(): string {
  try {
    return new URLSearchParams(window.location.search).get('company')?.slice(0, 80) ?? ''
  } catch {
    return ''
  }
}

function writeParam(q: string) {
  try {
    const url = new URL(window.location.href)
    if (q) url.searchParams.set('company', q)
    else url.searchParams.delete('company')
    window.history.replaceState(window.history.state, '', url)
  } catch {
    /* the address stays as it was */
  }
}

function RoundBlock({ round, company }: { round: CompanyRound; company: string }) {
  const claims = round.investors.filter((i) => i.cala_lead || i.is_lead)
  const base = { round: round.id, company, stage_name: round.stage_name, date: null }   // the date is in the round's heading
  const amount = round.amount_set_aside ? '' : fmtMoney(round.amount, round.currency)
  const stage = stageWord(round.stage_name)
  return (
    <li className="cround">
      <p className="cround__head">
        <span className="cround__stage">{stage === 'round' ? 'Round' : stage.replace(/^./, (c) => c.toUpperCase())}</span>
        {amount && <span className="num">{amount}</span>}
        <time className="num">{fmtMonth(round.date)}</time>
      </p>
      {claims.length === 0 ? (
        <p className="cround__none">Cala names no lead for this round, so there is nothing to check.</p>
      ) : (
        <ul className="finds">
          {claims.map((i) => {
            const c = i.check
            if (c?.status === 'lead' && i.cala_lead && c.quote && c.url)
              return <ConfirmedItem key={i.name} row={{ ...base, ...(c.earlier ? { stage_name: c.earlier.stage_name ?? 'Round', date: c.earlier.date } : {}), kind: 'confirmed', cala: i.name, quote: c.quote, url: c.url, publisher: c.publisher ?? null }} />
            if (c?.status === 'follower')
              return <LeadFix key={i.name} row={{ ...base, kind: 'lead', cala: i.name, page: c.led_by ?? [], quote: c.quote ?? null, url: c.url ?? null, publisher: c.publisher ?? null }} />
            return (
              <li className="find" key={i.name}>
                <p className="find__line">
                  <span className="find__who">{i.cala_lead ? 'Cala' : 'Page'}</span>
                  <span className="find__claim">{i.name} led</span>
                </p>
                <div className="find__line">
                  <span className="find__who" aria-hidden="true" />
                  <div className="cround__note">
                    {c ? <CheckNote check={c} who={i.name} promoted={i.promoted} /> : <span className="faint">Cala cites no page for this round.</span>}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

function Answer({ d, onPick }: { d: Result; onPick: (id: string, name: string) => void }) {
  if (!d.company) {
    return (
      <div className="state">
        <strong>Cala does not know a company called {d.q}.</strong>
        <span>Try the name it raised money under.</span>
      </div>
    )
  }
  const co = d.company
  const pc = d.page_check
  const others = d.matches.filter((m) => m.id !== co.id).slice(0, 3)
  const quotes = d.knowledge?.quotes ?? []
  return (
    <div className="ccheck__answer">
      <div className="ccheck__co">
        <div>
          <h3>{co.name}</h3>
          {co.description && <p className="truncate">{co.description}</p>}
        </div>
        {others.length > 0 && (
          <p className="ccheck__others">
            <span className="faint">Not this one?</span>
            {others.map((m) => {
              // Cala can hold several entities under one name: tell them apart by how each is described.
              const twin = m.name.toLowerCase() === co.name.toLowerCase() || others.some((o) => o !== m && o.name.toLowerCase() === m.name.toLowerCase())
              const hint = twin && m.description ? m.description.replace(/^(an?|the)\s+/i, '').split(/\s+/).slice(0, 4).join(' ').replace(/[,.;:]+$/, '') : ''
              return (
                <button key={m.id} type="button" className="chip" title={m.description ?? undefined} onClick={() => onPick(m.id, m.name)}>
                  <span className="truncate">
                    {m.name}
                    {hint && <span className="faint"> · {hint}</span>}
                  </span>
                </button>
              )
            })}
          </p>
        )}
      </div>

      {d.rounds.length > 0 ? (
        <>
          <p className="ccheck__sum">
            {plural(d.rounds.length, 'round')} in Cala, {plural(pc.pages, 'page')} read. <b>{pc.confirmed}</b> lead {pc.confirmed === 1 ? 'claim' : 'claims'} confirmed word for word
            {pc.corrected > 0 && <>, <b className="is-fix">{pc.corrected}</b> corrected</>}
            {pc.unstated > 0 && <>, {pc.unstated} the page does not say</>}
            {pc.unread > 0 && <>, {pc.unread} not read</>}.
          </p>
          <ol className="crounds">
            {d.rounds.map((r) => <RoundBlock key={r.id} round={r} company={co.name} />)}
          </ol>
        </>
      ) : (
        <>
          <p className="ccheck__sum">
            {d.investors_in_cala
              ? `Cala’s graph lists ${plural(d.investors_in_cala, 'investor')} for ${co.name} but no rounds, so there is no lead claim to check.`
              : `Cala’s graph holds no funding round for ${co.name}.`}
          </p>
          {quotes.length > 0 && (
            <div className="ccheck__said">
              <p className="ccheck__label">Cala’s knowledge search read these pages. What they say about who led, word for word:</p>
              <ul className="finds">
                {quotes.map((q, i) => (
                  <li className="find" key={i}>
                    <div className="find__line">
                      <span className="find__who">{q.table ? 'Table' : 'Page'}</span>
                      {q.table ? <p className="ccheck__tablerow">{q.quote}</p> : <Quote text={q.quote} />}
                      <PageLink url={q.url} publisher={q.publisher} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function CompanyCheck() {
  const [q, setQ] = useState(readParam)
  const [ask, setAsk] = useState<{ q: string; id?: string; n: number } | null>(() => (readParam() ? { q: readParam(), n: 0 } : null))
  const [state, setState] = useState<{ data: Result | null; error: string | null; busy: boolean }>({ data: null, error: null, busy: false })
  const top = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!ask) return
    const ctl = new AbortController()
    setState((s) => ({ data: s.data, error: null, busy: true }))
    api.check(ask.id ? { id: ask.id } : { q: ask.q }, ctl.signal).then(
      (data) => setState({ data, error: null, busy: false }),
      (e: ApiError) => e.name !== 'AbortError' && setState({ data: null, error: e.message, busy: false }),
    )
    return () => ctl.abort()
  }, [ask])

  const go = useCallback((name: string, id?: string) => {
    const clean = name.trim().slice(0, 80)
    if (clean.length < 2) return
    setQ(clean)
    writeParam(clean)
    setAsk((a) => ({ q: clean, id, n: (a?.n ?? 0) + 1 }))
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    go(q)
  }

  useEffect(() => {
    if (readParam()) top.current?.scrollIntoView({ block: 'start' })
  }, [])

  return (
    <section className="audit__sec ccheck" aria-labelledby="ccheck-h" ref={top}>
      <div className="audit__sechead">
        <div>
          <h2 id="ccheck-h">Check a company</h2>
          <p>Name any company. Soft Yes reads the pages Cala cites for its rounds and shows who led each, in the page’s words.</p>
        </div>
      </div>
      <form className="ccheck__form" onSubmit={submit}>
        <input
          name="company"
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Company name"
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          aria-label="Company name"
        />
        <button type="submit" className="btn btn--primary" disabled={q.trim().length < 2 || state.busy}>
          {state.busy ? 'Reading' : 'Check'}
        </button>
        <span className="ccheck__try">
          <span className="faint">Try</span>
          {TRY.map((name) => (
            <button key={name} type="button" className="chip" onClick={() => go(name)} disabled={state.busy}>
              {name}
            </button>
          ))}
        </span>
      </form>

      <div aria-live="polite">
        {state.busy && (
          <div className="ccheck__busy" aria-busy="true">
            <p>
              <i className="ccheck__dot" aria-hidden="true" />
              Reading the pages Cala cites for {ask?.q}. A company nobody checked yet takes up to a minute.
            </p>
            <i className="skel" style={{ width: '46%', height: 13 }} />
            <i className="skel" style={{ width: '82%', height: 13 }} />
            <i className="skel" style={{ width: '64%', height: 13 }} />
          </div>
        )}
        {!state.busy && state.error && (
          <div className="state state--error" role="alert">
            <strong>That check did not come back.</strong>
            <span>{state.error}</span>
            <button type="button" className="btn" onClick={() => ask && go(ask.q, ask.id)}>
              <Icon name="replay" size={14} />
              Try again
            </button>
          </div>
        )}
        {!state.busy && !state.error && state.data && <Answer d={state.data} onPick={(id, name) => go(name, id)} />}
      </div>
    </section>
  )
}
