import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearch } from 'wouter'
import { api, type ApiError, type Result } from '../lib/api'
import { download, proofLine, toCsv, toMarkdown } from '../lib/export'
import { fmtDate, listOr, plural } from '../lib/format'
import { rememberRun, useConfig, useMedia } from '../lib/store'
import { useWalk, walkStore, type WalkState } from '../lib/walk'
import { LeadDetail, LeadList, type Tab } from '../components/Leads'
import { Verdicts } from '../components/Verdicts'
import { WalkGraph } from '../components/WalkGraph'
import { CopyButton, Count, Icon, Mark, NamesProvider, useCopy } from '../components/ui'

const permalink = (runId: string) => `${location.origin}/r/${runId}`

function ExportMenu({ result }: { result: Result }) {
  const [open, setOpen] = useState(false)
  const [copied, copy] = useCopy()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="download" size={14} />
        Export
      </button>
      {open && (
        <div className="menu__pop" role="menu">
          <button type="button" role="menuitem" onClick={() => copy(toMarkdown(result, permalink(result.run_id)))}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy the shortlist as Markdown'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              download(`soft-yes-${result.run_id}.csv`, toCsv(result), 'text/csv;charset=utf-8')
              setOpen(false)
            }}
          >
            <Icon name="download" size={14} />
            Download the shortlist as CSV
          </button>
        </div>
      )}
    </div>
  )
}

/** The page's one headline slot: it narrates the walk, then states the result. Same box, no jump. */
function Headline({ walk }: { walk: WalkState }) {
  const walking = walk.phase === 'walking'
  let title = walk.narration
  let sub = walk.detail
  if (!walking && walk.result) {
    const cut = walk.result.headline.indexOf('. ')
    title = cut > 0 ? walk.result.headline.slice(0, cut + 1) : walk.result.headline
    sub = cut > 0 ? walk.result.headline.slice(cut + 2) : ''
  }
  return (
    <div className={`run__headline${walking ? ' is-walking' : ''}`} aria-live="polite" aria-atomic="true">
      <h1>
        {walking && <i className="run__live" aria-hidden="true" />}
        {title}
      </h1>
      <p className="run__sub truncate" title={walking ? undefined : sub}>{sub}</p>
    </div>
  )
}

function Tally({ walk }: { walk: WalkState }) {
  const c = walk.counters
  return (
    <dl className="tally" aria-label="What this walk is made of">
      <div>
        <dd className="num"><Count value={c.calls} /></dd>
        <dt>Cala calls</dt>
      </div>
      <div>
        <dd className="num"><Count value={c.facts} /></dd>
        <dt>facts</dt>
      </div>
      <div>
        <dd className="num"><Count value={c.sources} /></dd>
        <dt>sources</dt>
      </div>
      <div className="tally__zero">
        <dd className="num">0</dd>
        <dt>from a language model</dt>
      </div>
    </dl>
  )
}

function Skeleton() {
  return (
    <main className="page run" aria-busy="true" aria-label="Loading the walk">
      <div className="run__head">
        <div className="run__headline">
          <i className="skel" style={{ width: 'min(520px, 80%)', height: 26 }} />
          <i className="skel" style={{ width: 'min(380px, 60%)', height: 16, marginTop: 10 }} />
        </div>
      </div>
      <div className="run__skelgraph">
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} className="skel" style={{ width: `${34 + ((i * 37) % 40)}%`, height: 12 }} />
        ))}
      </div>
    </main>
  )
}

export function Run() {
  const { runId = '' } = useParams<{ runId: string }>()
  const [, navigate] = useLocation()
  const search = useSearch()
  const walk = useWalk()
  const config = useConfig()
  const wide = useMedia('(min-width: 961px)')
  const [load, setLoad] = useState<{ status: 'idle' | 'loading' | 'missing' | 'error'; error?: string }>({ status: 'idle' })
  const [attempt, retry] = useReducer((n: number) => n + 1, 0)
  const [tab, setTab] = useState<Tab>('overview')
  const leadsRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const live = runId === 'live'
  const mine = walk.phase !== 'idle' && (live || walk.runId === runId)

  // /r/live is only a place to stand while a walk has no id yet.
  useEffect(() => {
    if (live && walk.phase === 'idle') navigate('/', { replace: true })
    if (live && walk.runId) navigate(`/r/${walk.runId}`, { replace: true })
  }, [live, walk.phase, walk.runId, navigate])

  // A permalink opened cold: load the stored run and show it finished.
  useEffect(() => {
    if (live || mine) return
    const ctl = new AbortController()
    setLoad({ status: 'loading' })
    api.run(runId, ctl.signal).then(
      (r) => {
        walkStore.show(r)
        setLoad({ status: 'idle' })
      },
      (e: ApiError) => {
        if (e.name === 'AbortError') return
        setLoad(e.status === 404 ? { status: 'missing' } : { status: 'error', error: e.message })
      },
    )
    return () => ctl.abort()
    // `mine` flips once the store holds this run; that must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, live, attempt])

  const result = mine ? walk.result : null
  const done = mine && walk.phase === 'done' && !!result
  const walking = mine && walk.phase === 'walking'

  useEffect(() => {
    if (done && result) rememberRun(result)
  }, [done, result])

  useEffect(() => {
    if (!mine) return
    const names = (walk.inputs?.soft_yeses ?? []).map((s) => s.name).join(' + ')
    document.title = names ? `${names} · Soft Yes` : 'Soft Yes'
  }, [mine, walk.inputs])

  // ---- selection lives in the URL so a lead can be shared
  const all = useMemo(() => (result ? [...result.leads, ...result.second_ring] : []), [result])
  const urlLead = useMemo(() => new URLSearchParams(search).get('lead'), [search])
  const selectedKey = urlLead && all.some((l) => l.key === urlLead) ? urlLead : wide ? (all[0]?.key ?? null) : null
  const selected = all.find((l) => l.key === selectedKey) ?? null

  const select = useCallback(
    (key: string | null) => {
      if (!result) return
      const base = `/r/${result.run_id}`
      // On a phone the sheet is a place you can go back from.
      navigate(key ? `${base}?lead=${encodeURIComponent(key)}` : base, { replace: wide || !key })
    },
    [navigate, result, wide],
  )

  // The detail swaps under the reader: bring its top back if they had scrolled into the old one.
  useEffect(() => {
    if (!wide || !selectedKey) return
    const el = detailRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    if (top < 0) window.scrollTo({ top: window.scrollY + top - 64 })
  }, [selectedKey, wide])

  const focusRow = (key: string) => {
    const row = document.querySelector<HTMLButtonElement>(`.lead-row[data-lead="${CSS.escape(key)}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }

  useEffect(() => {
    if (!done) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (e.key === 'Escape') {
        if (!wide && selectedKey) {
          e.preventDefault()
          select(null)
        } else if (wide && selectedKey && detailRef.current?.contains(document.activeElement)) {
          e.preventDefault()
          focusRow(selectedKey)
        }
        return
      }
      if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const inList = !!t.closest?.('.leads')
      const down = e.key === 'j' || (e.key === 'ArrowDown' && inList)
      const up = e.key === 'k' || (e.key === 'ArrowUp' && inList)
      if (!down && !up) return
      e.preventDefault()
      const i = all.findIndex((l) => l.key === selectedKey)
      const next = all[i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + (down ? 1 : -1)))]
      if (!next) return
      select(next.key)
      requestAnimationFrame(() => focusRow(next.key))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [done, all, selectedKey, select, wide])

  // The sheet owns the screen on a phone.
  const sheet = done && !wide && !!selected
  useEffect(() => {
    document.documentElement.classList.toggle('is-locked', sheet)
    return () => document.documentElement.classList.remove('is-locked')
  }, [sheet])

  if (!mine) {
    if (load.status === 'missing') {
      return (
        <main className="page run">
          <div className="state">
            <strong>This walk is not stored here.</strong>
            <span>The link may be from another server, or the walk was cleared. Start it again and you get a new link.</span>
            <Link className="btn" href="/">Start a walk</Link>
          </div>
        </main>
      )
    }
    if (load.status === 'error') {
      return (
        <main className="page run">
          <div className="state state--error" role="alert">
            <strong>The walk could not be loaded.</strong>
            <span>{load.error}</span>
            <button type="button" className="btn" onClick={retry}>Try again</button>
          </div>
        </main>
      )
    }
    return <Skeleton />
  }

  const inputs = walk.inputs
  const stageName = result?.input.stage_name ?? config?.stages.find((s) => s.id === inputs?.stage)?.name ?? null
  const companyName = result?.input.company?.name ?? inputs?.company?.name ?? null
  const softNames = (inputs?.soft_yeses ?? []).map((s) => s.name)
  const attending = result?.slush?.connected ? result.slush.leads_attending : 0

  const replay = () => {
    if (!result) return
    window.scrollTo({ top: 0 })
    walkStore.replay(result)
  }

  const onGraphSelect = (key: string) => {
    select(key)
    if (wide) requestAnimationFrame(() => leadsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const onRowSelect = (key: string, byKeyboard: boolean) => {
    select(key)
    if (wide && byKeyboard) requestAnimationFrame(() => detailRef.current?.querySelector<HTMLElement>('.detail')?.focus({ preventScroll: true }))
  }

  return (
    <NamesProvider result={result}>
      <main className="page run">
        <header className="run__head">
          <Headline walk={walk} />
          <div className="run__actions">
            {walking ? (
              <button type="button" className="btn" onClick={() => walkStore.skip()}>
                Skip to the shortlist
                <Icon name="skip" size={14} />
              </button>
            ) : done && result ? (
              <>
                <button type="button" className="btn btn--ghost" onClick={replay}>
                  <Icon name="replay" size={14} />
                  Replay the walk
                </button>
                <CopyButton text={() => permalink(result.run_id)} label="Copy link" done="Link copied" icon="link" />
                <ExportMenu result={result} />
              </>
            ) : null}
          </div>
        </header>

        <div className="run__meta">
          <p className="run__query">
            {softNames.map((n) => (
              <span key={n} className="q">
                <i className="q__ring" aria-hidden="true" />
                <span className="truncate" title={n}>{n}</span>
              </span>
            ))}
            {stageName && <span className="tag">{stageName}</span>}
            {companyName && <span className="faint truncate">for {companyName}</span>}
          </p>
          <Tally walk={walk} />
        </div>

        {walk.deep && (
          <p className="deepline" role="status">
            <i className="spinner" aria-hidden="true" />
            <span>
              <b>Still reading.</b> {walk.deep.line}. {done ? 'The shortlist below updates when it is done, usually within a minute.' : ''}
            </span>
          </p>
        )}

        {walk.notes.map((n) => (
          <p key={n} className="notice">
            <Icon name="alert" size={14} />
            {n}
          </p>
        ))}

        {walk.phase === 'error' ? (
          <div className="state state--error" role="alert">
            <strong>The walk stopped.</strong>
            <span>{walk.error}</span>
            <div className="state__row">
              {inputs && (
                <button type="button" className="btn" onClick={() => walkStore.start(inputs)}>Try again</button>
              )}
              <Link className="btn btn--ghost" href="/">Change the investors</Link>
            </div>
          </div>
        ) : (
          <section className="run__graph" aria-label="The walk through Cala's funding graph">
            <WalkGraph model={walk.model} live={walking} selected={done ? selectedKey : null} onSelect={done ? onGraphSelect : undefined} />
          </section>
        )}

        {done && result && (
          <div className="run__results">
            <section className="run__sec">
              <div className="run__sechead">
                <h2>Will they lead, or wait for one?</h2>
                <p>Counted from each one’s own rounds in Cala.</p>
              </div>
              <Verdicts softs={result.soft_yeses} />
            </section>

            {all.length > 0 ? (
              <section className="run__sec run__leads" ref={leadsRef} aria-label="Likely leads">
                <div className="run__sechead">
                  <h2>
                    Who could lead{' '}
                    <span className="count num">{result.leads.length}</span>
                  </h2>
                  <p>
                    Ranked by the rounds they led with {listOr(softNames)}, and by whether they still lead.
                    {attending > 0 ? ` ${attending} of them ${attending === 1 ? 'is' : 'are'} registered for Slush.` : ''}
                    {wide && (
                      <span className="run__keys">
                        <kbd className="kbd">J</kbd>
                        <kbd className="kbd">K</kbd> to move
                      </span>
                    )}
                  </p>
                </div>
                {result.leads.length === 0 && (
                  <p className="notice">
                    <Icon name="alert" size={14} />
                    Nobody else led a round they joined in Cala. The investors below sat in those rounds and lead elsewhere.
                  </p>
                )}
                <div className="md-split">
                  <LeadList result={result} selected={selectedKey} onSelect={onRowSelect} />
                  {wide && selected && (
                    <div className="md-split__detail" ref={detailRef}>
                      <LeadDetail lead={selected} result={result} tab={tab} onTab={setTab} />
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section className="run__sec">
                <div className="state">
                  <strong>No lead to point at.</strong>
                  <span>
                    Cala has no round that {listOr(softNames)} joined and someone else led
                    {result.soft_yeses.some((s) => !s.rounds_in_cala) ? ', and no rounds at all for some of them' : ''}. That is a gap in
                    what Cala covers, not a verdict on them.
                  </span>
                  <span>Add another investor who said yes, or try the fund’s full legal name.</span>
                  <Link className="btn" href="/">Add another investor</Link>
                </div>
              </section>
            )}

            <footer className="run__proof">
              <p>
                <Mark size={18} />
                <span className="num">{proofLine(result)}.</span>
              </p>
              <p className="faint">
                Every fact on this page comes from Cala and links to the page Cala found it on. Walked{' '}
                {fmtDate(new Date(result.created * 1000).toISOString().slice(0, 10))}
                {result.ledger.fresh > 0
                  ? `, ${plural(result.ledger.fresh, 'fresh call')} and ${result.ledger.cached} from cache.`
                  : ', all from calls Cala had already answered.'}
              </p>
            </footer>
          </div>
        )}

        {sheet && selected && result && (
          <div className="sheet" role="dialog" aria-modal="true" aria-label={selected.name}>
            <LeadDetail lead={selected} result={result} tab={tab} onTab={setTab} onClose={() => select(null)} />
          </div>
        )}
      </main>
    </NamesProvider>
  )
}
