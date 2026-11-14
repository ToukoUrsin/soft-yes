import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { api, type ApiError, type Audit, type ConfirmedRow } from '../lib/api'
import { download } from '../lib/export'
import { cleanQuote, plural } from '../lib/format'
import { AmountFix, ConfirmedItem, LeadFix, StageFix } from '../components/Evidence'
import { CompanyCheck } from '../components/CompanyCheck'
import { Icon, N } from '../components/ui'

const DRAW = 10

function sample<T>(rows: T[], n: number, not: Set<T> = new Set()): T[] {
  // A fresh draw avoids the rows on screen while there are enough others to choose from.
  const pool = rows.length - not.size >= n ? rows.filter((r) => !not.has(r)) : [...rows]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n)
}

const cell = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Every place a page disagrees with Cala, one row each: what Cala can use to fix its graph. */
function toCsv(a: Audit): string {
  const head = ['kind', 'company', 'stage', 'round_date', 'round_id', 'cala_says', 'page_says', 'sentence', 'page']
  const rows: (string | number | null)[][] = [
    ...a.leads.map((r) => ['lead', r.company, r.stage_name, r.date, r.round, `${r.cala} led`, r.page.length ? `${r.page.join('; ')} led` : '', cleanQuote(r.quote), r.url]),
    ...a.amounts.map((r) => ['amount', r.company, r.stage_name, r.date, r.round, `${r.amount} ${r.currency ?? ''}`.trim(), 'amount not on the page', '', r.pages.join(' ')]),
    ...a.stages.map((r) => ['stage', r.company, r.stage_name, r.date, r.round, r.cala, r.page ?? 'no stage named', '', r.pages.join(' ')]),
  ]
  return [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')
}

function Numbers({ a }: { a: Audit }) {
  const items: { n: number; label: string; cls?: string }[] = [
    { n: a.pages, label: 'pages read' },
    { n: a.claims, label: 'lead claims checked' },
    { n: a.confirmed, label: 'confirmed word for word', cls: 'is-ok' },
    { n: a.corrected, label: 'corrected', cls: 'is-fix' },
    { n: a.unstated, label: 'page does not say who led' },
    { n: a.unread, label: 'page could not be read' },
  ]
  const total = Math.max(1, a.confirmed + a.corrected + a.unstated + a.unread)
  return (
    <div className="audit__sum">
      <dl className="audit__nums">
        {items.map((x) => (
          <div key={x.label} className={x.cls}>
            <dd className="num">{x.n.toLocaleString('en-GB')}</dd>
            <dt>{x.label}</dt>
          </div>
        ))}
      </dl>
      <div
        className="audit__bar"
        role="img"
        aria-label={`Of ${a.claims} lead claims: ${a.confirmed} confirmed, ${a.corrected} corrected, ${a.unstated} the page does not say, ${a.unread} not read`}
      >
        <i className="is-ok" style={{ flexGrow: a.confirmed / total }} />
        {a.corrected > 0 && <i className="is-fix" style={{ flexGrow: a.corrected / total }} />}
        {a.unstated > 0 && <i className="is-open" style={{ flexGrow: a.unstated / total }} />}
        {a.unread > 0 && <i className="is-unread" style={{ flexGrow: a.unread / total }} />}
      </div>
    </div>
  )
}

/** Ten confirmed claims, drawn at random. The judge's test: do they all hold up against their pages? */
function Draw({ rows }: { rows: ConfirmedRow[] }) {
  const [state, setState] = useState(() => ({ picks: sample(rows, DRAW), n: 1 }))
  const again = useCallback(() => setState((s) => ({ picks: sample(rows, DRAW, new Set(s.picks)), n: s.n + 1 })), [rows])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'r') return
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      again()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [again])
  const count = Math.min(DRAW, rows.length)
  return (
    <section className="audit__sec audit__draw" aria-labelledby="draw-h">
      <div className="audit__sechead">
        <div>
          <h2 id="draw-h">{count === DRAW ? 'Ten at random' : `${plural(count, 'confirmed claim')}`}</h2>
          <p>
            Drawn from every lead claim a page confirms. Each shows the page’s own sentence. Open it and check.
          </p>
        </div>
        {rows.length > DRAW && (
          <button type="button" className="btn audit__again" onClick={again}>
            <Icon name="shuffle" size={14} />
            Draw another ten
            <kbd className="kbd" aria-hidden="true">R</kbd>
          </button>
        )}
      </div>
      <ol className="finds finds--draw" key={state.n}>
        {state.picks.map((r, i) => (
          <ConfirmedItem key={`${r.round}:${r.cala}`} row={r} index={i} />
        ))}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {state.n > 1 ? `Draw ${state.n}: ${state.picks.map((r) => r.company).join(', ')}` : ''}
      </p>
    </section>
  )
}

function More<T>({ rows, first, render }: { rows: T[]; first: number; render: (r: T, i: number) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const shown = open ? rows : rows.slice(0, first)
  return (
    <>
      <ul className="finds finds--rows">{shown.map(render)}</ul>
      {rows.length > first && !open && (
        <button type="button" className="btn btn--ghost btn--sm audit__more" onClick={() => setOpen(true)}>
          Show all {rows.length}
          <Icon name="chevron" size={13} />
        </button>
      )}
    </>
  )
}

function Skeleton() {
  return (
    <div className="audit__skel" aria-busy="true" aria-label="Loading the page check">
      <i className="skel" style={{ width: 'min(680px, 100%)', height: 16 }} />
      <i className="skel" style={{ width: '100%', height: 6, marginTop: 14 }} />
      <div className="audit__skelrows">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i}>
            <i className="skel" style={{ width: `${32 + ((i * 29) % 26)}%`, height: 13 }} />
            <i className="skel" style={{ width: `${68 + ((i * 17) % 26)}%`, height: 13 }} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function AuditPage() {
  const [state, setState] = useState<{ data: Audit | null; error: string | null }>({ data: null, error: null })
  const [attempt, retry] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    document.title = 'What the pages say · Soft Yes'
  }, [])

  useEffect(() => {
    const ctl = new AbortController()
    setState({ data: null, error: null })
    api.audit(ctl.signal).then(
      (data) => setState({ data, error: null }),
      (e: ApiError) => e.name !== 'AbortError' && setState({ data: null, error: e.message }),
    )
    return () => ctl.abort()
  }, [attempt])

  const a = state.data
  const fixes = a ? a.leads.length + a.amounts.length + a.stages.length : 0

  return (
    <main className="page audit">
      <header className="audit__head">
        <h1>What the pages say</h1>
        <p className="audit__lede">
          Cala says who led a round and cites a page. Soft Yes opens that page and looks for the sentence. Where the page says
          otherwise, the page wins.
        </p>
      </header>

      {state.error ? (
        <div className="state state--error" role="alert">
          <strong>The page check could not be loaded.</strong>
          <span>{state.error}</span>
          <button type="button" className="btn" onClick={retry}>Try again</button>
        </div>
      ) : !a ? (
        <Skeleton />
      ) : !a.claims ? (
        <div className="state">
          <strong>No page has been checked yet.</strong>
          <span>Each walk reads the pages Cala cites for its rounds. Run one and its claims show up here.</span>
          <Link className="btn" href="/">Start a walk</Link>
        </div>
      ) : (
        <>
          <Numbers a={a} />

          <CompanyCheck />

          {a.confirmed_rows.length > 0 && <Draw rows={a.confirmed_rows} />}

          <section className="audit__sec" aria-labelledby="fix-h">
            <div className="audit__sechead">
              <div>
                <h2 id="fix-h">
                  Corrections<N>{a.leads.length}</N>
                </h2>
                <p>Cala names one lead. The page names another, so Soft Yes goes with the page.</p>
              </div>
            </div>
            {a.leads.length ? (
              <ul className="finds">{a.leads.map((r) => <LeadFix key={`${r.round}:${r.cala}`} row={r} />)}</ul>
            ) : (
              <p className="muted">No page has named a different lead so far.</p>
            )}
          </section>

          <div className="audit__cols">
            <section className="audit__sec" aria-labelledby="amt-h">
              <div className="audit__sechead">
                <div>
                  <h2 id="amt-h">
                    Amounts set aside<N>{a.amounts.length}</N>
                  </h2>
                  <p>Cala gives an amount. No page it cites for the round states it, so it is not shown.</p>
                </div>
              </div>
              {a.amounts.length ? (
                <More rows={a.amounts} first={8} render={(r) => <AmountFix key={r.round} row={r} />} />
              ) : (
                <p className="muted">Every amount shown is on a page.</p>
              )}
            </section>

            <section className="audit__sec" aria-labelledby="stage-h">
              <div className="audit__sechead">
                <div>
                  <h2 id="stage-h">
                    Stage labels<N>{a.stages.length}</N>
                  </h2>
                  <p>Cala’s stage label is not the one the page uses.</p>
                </div>
              </div>
              {a.stages.length ? (
                <More rows={a.stages} first={8} render={(r) => <StageFix key={r.round} row={r} />} />
              ) : (
                <p className="muted">Every stage label shown is on a page.</p>
              )}
            </section>
          </div>

          <footer className="audit__foot">
            <p>
              This list is feedback for Cala. Each of the {fixes} rows is one fix to its graph, with the page that shows it.
            </p>
            <button type="button" className="btn" onClick={() => download('soft-yes-page-check.csv', toCsv(a), 'text/csv;charset=utf-8')}>
              <Icon name="download" size={14} />
              Download as CSV
            </button>
            <p className="faint">
              From {plural(a.walks, 'walk')} over {plural(a.rounds, 'round')}. It grows with every walk.
            </p>
          </footer>
        </>
      )}
    </main>
  )
}
