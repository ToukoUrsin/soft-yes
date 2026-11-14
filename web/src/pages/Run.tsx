import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearch } from 'wouter'
import { api, type ApiError, type Result } from '../lib/api'
import { download, proofLine, toCsv, toMarkdown } from '../lib/export'
import { fmtDate, listOr, plural } from '../lib/format'
import { rememberRun, useConfig, useMedia } from '../lib/store'
import { forgetWalking, pagesLine, useWalk, walkingInputs, walkStore, type WalkState } from '../lib/walk'
import { AmountFix, ClaimStrip, LeadFix, StageFix } from '../components/Evidence'
import { Answer } from '../components/Answer'
import { OwnRound } from '../components/OwnRound'
import { LeadDetail, LeadList, useSays, type Tab } from '../components/Leads'
import { Verdicts } from '../components/Verdicts'
import { WalkGraph } from '../components/WalkGraph'
import { CopyButton, Count, Icon, Mark, N, NamesProvider, useCopy } from '../components/ui'

const permalink = (runId: string) => `${location.origin}/r/${runId}`
// Hooks need a result to read before there is one.
const NO_RESULT = { run_id: '', leads: [] } as unknown as Result

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

/** The page's one headline slot: it narrates the walk, then states the result, or says why it stopped. Same box, no jump. */
function Headline({ walk }: { walk: WalkState }) {
  const walking = walk.phase === 'walking'
  const stopped = walk.phase === 'error'
  let title = walk.narration
  let sub = walk.detail
  if (stopped) {
    title = 'The walk stopped'
    sub = walk.error ?? ''
  } else if (!walking && walk.result) {
    const cut = walk.result.headline.indexOf('. ')
    title = cut > 0 ? walk.result.headline.slice(0, cut + 1) : walk.result.headline
    sub = cut > 0 ? walk.result.headline.slice(cut + 2) : ''
  }
  return (
    <div
      className={`run__headline${walking ? ' is-walking' : ''}${stopped ? ' is-stopped' : ''}`}
      role={stopped ? 'alert' : undefined}
      aria-live={stopped ? undefined : 'polite'}
      aria-atomic="true"
    >
      <h1>
        {walking && <i className="run__live" aria-hidden="true" />}
        {stopped && <i className="run__live run__live--stopped" aria-hidden="true" />}
        {title}
      </h1>
      <p className={`run__sub${stopped ? '' : ' truncate'}`} title={walking || stopped ? undefined : sub}>{sub}</p>
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
      {walk.pages && walk.pages.pages > 0 && (
        <div>
          <dd className="num"><Count value={walk.pages.pages} /></dd>
          <dt>pages read</dt>
        </div>
      )}
      <div className="tally__zero">
        <dd className="num">0</dd>
        <dt>from a language model</dt>
      </div>
    </dl>
  )
}

/**
 * The page check as a step of the walk. While the pages are being read it shows one mark per round; when they are
 * read, one mark per lead claim. Once the walk is done the line opens what the pages changed in this run.
 * `shown`: how many corrections stay on the page while the rest is folded (the result opens on them).
 */
function PageStep({ walk, result, shown = 0 }: { walk: WalkState; result: Result | null; shown?: number }) {
  const [open, setOpen] = useState(false)
  const p = walk.pages
  const walking = walk.phase === 'walking'
  const pc = !walking ? result?.page_check : null
  const findings = pc?.findings ?? []
  const leads = findings.filter((f) => f.kind === 'lead')
  const amounts = findings.filter((f) => f.kind === 'amount')
  const stages = findings.filter((f) => f.kind === 'stage')
  useEffect(() => setOpen(false), [walk.generation])
  if (!p && !walking) return null

  const reading = !p || p.state === 'reading'
  const sentence = p && p.state === 'done' && (
    <>
      <b className="num">{p.pages}</b> pages read. <b className="num">{p.confirmed}</b> lead {p.confirmed === 1 ? 'claim' : 'claims'} confirmed word for word
      {p.corrected > 0 && <>, <b className="num pagestep__fix">{p.corrected}</b> corrected</>}
      {p.unstated > 0 && <>, <b className="num">{p.unstated}</b> the page does not say</>}.
    </>
  )
  return (
    <section className={`pagestep${reading ? ' is-reading' : ''}${!p ? ' is-waiting' : ''}`} aria-label="The page check">
      <div className="pagestep__line">
        <span className="pagestep__name">
          <Icon name="page" size={14} />
          Page check
        </span>
        {!p ? (
          <p className="pagestep__text faint">Next: open the pages Cala cites and find the sentence that says who led.</p>
        ) : p.state === 'reading' ? (
          <>
            <ClaimStrip confirmed={0} corrected={0} open={0} reading={Math.max(p.rounds, 6)} max={36} />
            <p className="pagestep__text" role="status">
              Reading the pages behind {plural(p.rounds, 'round')}
              <span className="faint"> for the sentence that says who led</span>
            </p>
          </>
        ) : (
          <>
            <ClaimStrip confirmed={p.confirmed} corrected={p.corrected} open={p.unstated} max={36} />
            {pc && findings.length > 0 ? (
              <button type="button" className="pagestep__text pagestep__sum" aria-expanded={open} aria-controls="pagestep-panel" onClick={() => setOpen((o) => !o)}
                title="See what the pages changed in this walk">
                <span>{sentence}</span>
                <Icon name="chevron" size={13} />
              </button>
            ) : (
              <p className="pagestep__text" role="status">{sentence}</p>
            )}
          </>
        )}
        {pc && <Link className="link pagestep__all" href="/audit">Every check</Link>}
      </div>
      {!open && pc && shown > 0 && leads.length > 0 && (
        <div className="pagestep__panel pagestep__panel--first">
          <h3>Another lead on the page<N>{leads.length}</N></h3>
          <ul className="finds finds--cols">
            {leads.slice(0, shown).map((f) => f.kind === 'lead' && <LeadFix key={`${f.round}:${f.cala}`} row={f} />)}
          </ul>
          {findings.length > Math.min(shown, leads.length) && (
            <button type="button" className="pagestep__more" aria-expanded="false" aria-controls="pagestep-panel" onClick={() => setOpen(true)}>
              All {findings.length} changes
              <Icon name="chevron" size={13} />
            </button>
          )}
        </div>
      )}
      {open && pc && (
        <div className="pagestep__panel" id="pagestep-panel">
          {leads.length > 0 && (
            <>
              <h3>Another lead on the page<N>{leads.length}</N></h3>
              <ul className="finds finds--cols">{leads.map((f) => f.kind === 'lead' && <LeadFix key={`${f.round}:${f.cala}`} row={f} />)}</ul>
            </>
          )}
          {(amounts.length > 0 || stages.length > 0) && (
            <div className="pagestep__cols">
              {amounts.length > 0 && (
                <div>
                  <h3>Amounts set aside<N>{amounts.length}</N></h3>
                  <ul className="finds finds--rows">{amounts.map((f) => f.kind === 'amount' && <AmountFix key={f.round} row={f} />)}</ul>
                </div>
              )}
              {stages.length > 0 && (
                <div>
                  <h3>Stage labels<N>{stages.length}</N></h3>
                  <ul className="finds finds--rows">{stages.map((f) => f.kind === 'stage' && <StageFix key={f.round} row={f} />)}</ul>
                </div>
              )}
            </div>
          )}
          <p className="faint pagestep__tail">
            {pc.unread > 0 ? `${plural(pc.unread, 'claim')} could not be checked: the page did not open or is about something else. ` : ''}
            Each confirmed claim shows its sentence under the round, further down.{' '}
            <Link className="link" href="/audit">See every check across all walks</Link>
          </p>
        </div>
      )}
    </section>
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
  const [tab, setTab] = useState<Tab>('record')
  const leadsRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const live = runId === 'live'
  const mine = walk.phase !== 'idle' && (live || walk.runId === runId)

  // /r/live is only a place to stand while a walk has no id yet.
  useEffect(() => {
    if (live && walk.phase === 'idle') {
      // Reloaded mid-walk: ask for the same walk again. Cala's answers so far are kept, so it catches up fast.
      const again = walkingInputs()
      if (again) void walkStore.start(again)
      else navigate('/', { replace: true })
    }
    if (live && walk.runId) {
      forgetWalking()
      navigate(`/r/${walk.runId}`, { replace: true })
    }
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
  const stopped = mine && walk.phase === 'error'

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

  const settled = !walk.deep
  const saysFor = useSays(result ?? NO_RESULT, done && settled)
  const first = result ? (result.leads[0] ?? result.second_ring[0] ?? null) : null

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
            <Link className="btn" href="/find">Start a walk</Link>
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
  const usual = result && !result.input.stage ? result.input.stage_usual : null

  const replay = () => {
    if (!result) return
    window.scrollTo({ top: 0 })
    walkStore.replay(result)
  }

  const onGraphSelect = (key: string) => {
    select(key)
    if (!wide) return
    requestAnimationFrame(() => {
      // The list scrolls on its own. Put the picked row a third of the way down it first, so it is there when the page arrives.
      const list = leadsRef.current?.querySelector<HTMLElement>('.leads')
      const row = list?.querySelector<HTMLElement>(`.lead-row[data-lead="${CSS.escape(key)}"]`)
      if (list && row) {
        const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
        list.scrollTop = Math.max(0, top - list.clientHeight / 3)
      }
      leadsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  /** From the answer on top into the lead itself, on the tab asked for. */
  const openLead = (key: string, t: Tab) => {
    setTab(t)
    select(key)
    if (wide) requestAnimationFrame(() => leadsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const onRowSelect = (key: string, byKeyboard: boolean) => {
    select(key)
    if (wide && byKeyboard) requestAnimationFrame(() => detailRef.current?.querySelector<HTMLElement>('.detail')?.focus({ preventScroll: true }))
  }

  // A finished walk opens on the answer; what it was asked and how much it read move below it, with the graph.
  const answered = done && !!result && !!first
  const meta = (
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
      {!(stopped && walk.counters.calls === 0) && <Tally walk={walk} />}
    </div>
  )

  return (
    <NamesProvider result={result}>
      <main className={`page run${answered ? ' is-answered' : ''}`}>
        <header className="run__head">
          <Headline walk={walk} />
          <div className="run__actions">
            {walking ? (
              <button type="button" className="btn" onClick={() => walkStore.skip()}>
                Skip to the shortlist
                <Icon name="skip" size={14} />
              </button>
            ) : stopped ? (
              <>
                {inputs && (
                  <button type="button" className="btn btn--primary" onClick={() => walkStore.start(inputs)}>Try again</button>
                )}
                <Link className="btn" href="/find">Change the investors</Link>
              </>
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

        {!answered && meta}

        {walk.deep && !stopped && (
          <p className="deepline" role="status">
            <i className="spinner" aria-hidden="true" />
            <span>
              <b>Still reading.</b> {walk.deep.line}.{done ? ' The shortlist below updates when it is done, usually within a minute.' : ''}
            </span>
          </p>
        )}

        {walk.notes.map((n) => (
          <p key={n} className="notice">
            <Icon name="alert" size={14} />
            {n}
          </p>
        ))}

        {!stopped && !answered && <PageStep walk={walk} result={result} />}

        {answered && result && first && (
          <Answer lead={first} result={result} says={saysFor(first)} settled={settled} onOpen={(t) => openLead(first.key, t)} onOpenOther={(k) => openLead(k, 'record')}>
            <PageStep walk={walk} result={result} shown={3} />
          </Answer>
        )}

        {answered && result && settled && result.own?.company?.id && <OwnRound result={result} />}

        {answered && meta}

        {!stopped && (
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
                    Who could lead<N>{result.leads.length}</N>
                  </h2>
                  <p>
                    Ranked by the rounds they led with {listOr(softNames)}, and by whether they still lead.
                    {usual ? ` No stage given: ${usual.rounds} of the ${usual.of} staged rounds are ${usual.stage_name}, so ${usual.stage_name} leads rank higher.` : ''}
                    {wide && (
                      <span className="run__keys">
                        <kbd className="kbd">J</kbd>
                        <kbd className="kbd">K</kbd> to move
                      </span>
                    )}
                  </p>
                  {attending > 0 && (
                    <p className="run__slush">
                      <span className="tag">At Slush</span>
                      <span>
                        <b className="num">{attending}</b> of them {attending === 1 ? 'is' : 'are'} registered for Slush.
                      </span>
                    </p>
                  )}
                </div>
                {result.leads.length === 0 && (
                  <p className="notice">
                    <Icon name="alert" size={14} />
                    Nobody else led a round they joined in Cala. The investors below sat in those rounds and lead elsewhere.
                  </p>
                )}
                <div className="md-split">
                  <LeadList result={result} selected={selectedKey} onSelect={onRowSelect} settled={!walk.deep} />
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
                  <Link className="btn" href="/find">Add another investor</Link>
                </div>
              </section>
            )}

            <footer className="run__proof">
              <p>
                <Mark size={18} />
                <span className="num">{proofLine(result)}.</span>
              </p>
              <p className="faint">
                Every fact on this page comes from Cala and links to the page Cala found it on.
                {result.page_check ? (
                  <>
                    {' '}Each lead claim was read again on that page: {pagesLine(result.page_check)}.{' '}
                    <Link className="link" href="/audit">See the page check</Link>.
                  </>
                ) : null}{' '}
                Walked{' '}
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
