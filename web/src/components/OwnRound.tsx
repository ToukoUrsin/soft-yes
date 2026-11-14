// The walk put to the test on the founder's own last round: that round left out, its lead taken out of the start.
// Did the walk still reach the investor who led it? Said plainly either way.

import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { api, type Backtest, type Holdout, type Result } from '../lib/api'
import { fmtMonth, listAnd, possessive, stageWord } from '../lib/format'
import { CheckLabel, PageLink, Quote } from './Evidence'

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const place = (rank: number) => ORDINAL[rank] ?? `number ${rank}`
const pct = (x: number) => `${Math.round(x * 100)}%`

export function OwnRound({ result }: { result: Result }) {
  const [state, set] = useState<{ id: string; data: Holdout | null }>({ id: '', data: null })
  const [past, setPast] = useState<Backtest | null>(null)
  const company = result.own?.company
  const runId = result.run_id

  useEffect(() => {
    if (!company?.id) return
    const ctl = new AbortController()
    api.holdout(runId, ctl.signal).then(
      (data) => set({ id: runId, data }),
      () => undefined,   // the test is an extra: without it the page is whole
    )
    return () => ctl.abort()
  }, [runId, company?.id])

  const h = state.id === runId ? state.data : null
  const found = h?.found?.[0] ?? null
  const missed = !!h?.round && !found && !h.skipped

  useEffect(() => {
    if (!missed) return
    const ctl = new AbortController()
    api.backtest(ctl.signal).then(setPast, () => undefined)
    return () => ctl.abort()
  }, [missed])

  if (!company?.id) return null
  if (!h) {
    return (
      <section className="ownround ownround--wait" aria-busy="true" aria-label="Testing the walk on your own round">
        <div className="ownround__say">
          <h2>Checked on {possessive(company.name)} own round</h2>
          <i className="skel" style={{ width: 'min(440px, 90%)', height: 18 }} />
          <i className="skel" style={{ width: 'min(320px, 70%)', height: 18 }} />
        </div>
      </section>
    )
  }
  if (!h.round || h.skipped || !h.from?.length) return null

  const round = h.round
  const what = stageWord(round.stage_name)
  const real = round.leads.map((l) => l.name)
  const proof = round.leads.find((l) => l.check?.quote)?.check ?? null
  const two = past?.two
  return (
    <section className={`ownround${found ? ' is-hit' : ''}`} aria-label="The walk tested on your own round">
      <div className="ownround__say">
        <h2>Checked on {possessive(company.name)} own round</h2>
        {found ? (
          <p className="ownround__verdict">
            Take the {what} out of Cala’s graph and walk from {listAnd(h.from)} alone.{' '}
            <b>{found.name}</b> comes out <b>{place(found.rank)} of {h.of}</b>. It led that {what}.
          </p>
        ) : (
          <p className="ownround__verdict">
            Take the {what} out of Cala’s graph and walk from {listAnd(h.from)} alone. The walk does not reach{' '}
            <b>{listAnd(real)}</b>, who led it.
          </p>
        )}
        {!found && (
          <p className="ownround__note">
            {h.top?.length ? `It put ${listAnd(h.top)} first. ` : ''}
            {two && two.tested > 0 && two.base_rate != null
              ? `On ${two.tested} past rounds with two followers, the real lead was on the list ${pct(two.hit / two.tested)} of the time. A random pick: ${pct(two.base_rate)}. `
              : ''}
            <Link className="link" href="/audit#backtest">See the test</Link>
          </p>
        )}
      </div>
      <div className="ownround__proof">
        {found?.through.slice(0, 2).map((t) => (
          <figure key={`${t.company}:${t.date}`}>
            <figcaption>
              <span className="ownround__k">How the walk got there</span>
              <span>
                {[t.company, t.stage_name, fmtMonth(t.date)].filter(Boolean).join(', ')}
                {t.with.length > 0 && <span className="faint">, with {listAnd(t.with)}</span>}
              </span>
            </figcaption>
            {t.check?.quote && <Quote text={t.check.quote} hit={[found.name]} />}
            {t.check && (
              <p className="ownround__src">
                <CheckLabel status={t.check.status} />
                <PageLink url={t.check.url} publisher={t.check.publisher} />
              </p>
            )}
          </figure>
        ))}
        {proof && (
          <figure>
            <figcaption>
              <span className="ownround__k">What happened</span>
              <span>
                {[company.name, round.stage_name, fmtMonth(round.date)].filter(Boolean).join(', ')}
              </span>
            </figcaption>
            <Quote text={proof.quote} hit={real} />
            <p className="ownround__src">
              <CheckLabel status={proof.status} />
              <PageLink url={proof.url} publisher={proof.publisher} />
            </p>
          </figure>
        )}
      </div>
    </section>
  )
}
