import { useEffect, useReducer, useState } from 'react'
import { Link, useLocation, useParams, useSearch } from 'wouter'
import { api, type Result, type Verdict } from '../lib/api'
import { proofLine } from '../lib/export'
import { capped, host, plural } from '../lib/format'
import { walkStore } from '../lib/walk'
import { Deal } from '../components/Deal'
import { ReportTag, WhyList } from '../components/Leads'
import { Icon, Investor, InvestorList, Mark, NamesProvider } from '../components/ui'
import { YearBars } from '../components/YearBars'

const VERDICT: Record<Verdict, { text: string; cls: string }> = {
  follows: { text: 'Follows', cls: 'tag' },
  mixed: { text: 'Leads sometimes', cls: 'tag' },
  leads: { text: 'Leads', cls: 'tag tag--accent' },
  thin: { text: 'Thin record', cls: 'tag tag--warn' },
  unknown: { text: 'No rounds in Cala', cls: 'tag tag--warn' },
}

// One read per investor per session: going back to a page must not spend Cala calls again.
const seen = new Map<string, Result>()

function Loading({ name }: { name: string | null }) {
  const [seconds, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const id = window.setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <main className="page inv" aria-busy="true">
      <header className="inv__head">
        <h1>{name ?? 'Investor'}</h1>
      </header>
      <p className="working__now" role="status">
        <i className="spinner" aria-hidden="true" />
        <span>{seconds < 6 ? 'Reading its funding rounds in Cala' : seconds < 16 ? 'Opening the rounds it followed' : 'Reading who led them. A long record takes a little longer.'}</span>
        <span className="num faint">{seconds} s</span>
      </p>
      <div className="inv__skel">
        <i className="skel" style={{ width: '62%', height: 20 }} />
        <i className="skel" style={{ width: '100%', height: 132 }} />
        <i className="skel" style={{ width: '100%', height: 40 }} />
        <i className="skel" style={{ width: '100%', height: 40 }} />
      </div>
    </main>
  )
}

export function InvestorPage() {
  const { ids = '' } = useParams<{ ids: string }>()
  const search = useSearch()
  const [, navigate] = useLocation()
  const name = new URLSearchParams(search).get('name')
  const [attempt, retry] = useReducer((n: number) => n + 1, 0)
  const [state, setState] = useState<{ result: Result | null; error: string | null }>({ result: seen.get(ids) ?? null, error: null })

  useEffect(() => {
    const hit = seen.get(ids)
    if (hit) {
      setState({ result: hit, error: null })
      return
    }
    const list = ids.split(',').filter((x) => x.length === 36)
    if (!list.length) {
      setState({ result: null, error: 'That link does not name an investor.' })
      return
    }
    const ctl = new AbortController()
    setState({ result: null, error: null })
    api.investor(list, name, ctl.signal).then(
      async (first) => {
        setState({ result: first, error: null })
        // A thin record is read further at the server: wait for the stored result and swap it in.
        let r = first
        for (let i = 0; r.pending?.length && i < 60 && !ctl.signal.aborted; i++) {
          await new Promise((done) => setTimeout(done, 2500))
          try {
            const next = await api.run(first.run_id, ctl.signal)
            if (!next.pending?.length) r = { ...next, profile: first.profile }
          } catch {
            /* offline for a moment: keep waiting */
          }
        }
        if (ctl.signal.aborted) return
        if (r.pending?.length) r = { ...r, pending: undefined }
        seen.set(ids, r)
        setState({ result: r, error: null })
      },
      (e: Error) => e.name !== 'AbortError' && setState({ result: null, error: e.message }),
    )
    return () => ctl.abort()
    // the name is only a label for the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, attempt])

  const result = state.result
  const s = result?.soft_yeses[0] ?? null
  useEffect(() => {
    document.title = `${s?.name ?? name ?? 'Investor'} · Soft Yes`
  }, [s?.name, name])

  if (state.error) {
    return (
      <main className="page inv">
        <div className="state state--error" role="alert">
          <strong>Cala could not be read for this investor.</strong>
          <span>{state.error}</span>
          <div className="state__row">
            <button type="button" className="btn" onClick={retry}>Try again</button>
            <Link className="btn btn--ghost" href="/investor">Check another investor</Link>
          </div>
        </div>
      </main>
    )
  }
  if (!result || !s) return <Loading name={name} />

  const tag = VERDICT[s.verdict] ?? VERDICT.unknown
  const p = s.pulse
  const profile = result.profile
  const desc = profile?.description ?? s.description
  const site = profile?.website ? (/^https?:/.test(profile.website) ? profile.website : `https://${profile.website}`) : null
  const none = !s.found || !s.rounds_in_cala
  const led = s.led_rounds ?? []
  const followed = s.followed_rounds ?? []
  const noLead = followed.filter((r) => !r.leads.filter((n) => n !== s.name).length).length

  // Replayed from this result: no new Cala calls.
  const walk = () => {
    walkStore.replay(result)
    navigate(`/r/${result.run_id}`)
  }

  return (
    <NamesProvider result={result}>
      <main className="page inv">
        <header className="inv__head">
          <div className="inv__title">
            <h1>{s.name}</h1>
            <span className={tag.cls}>{tag.text}</span>
          </div>
          {desc && <p className="inv__desc">{desc}</p>}
          {(site || profile?.hq) && (
            <p className="inv__links">
              {site && (
                <a className="src" href={site} target="_blank" rel="noopener noreferrer">
                  <span>{host(site)}</span>
                  <Icon name="out" size={11} />
                </a>
              )}
              {profile?.hq && <span className="faint">{profile.hq}</span>}
            </p>
          )}
        </header>

        {!!result.pending?.length && (
          <p className="deepline" role="status">
            <i className="spinner" aria-hidden="true" />
            <span>
              <b>Still reading.</b> Cala’s graph is thin for {s.name}, so its knowledge search is reading reports that name it. This page
              updates when it is done, usually within a minute.
            </span>
          </p>
        )}

        {none ? (
          <div className="state">
            <strong>Cala has no funding rounds for {s.name}.</strong>
            <span>That is a gap in what Cala covers, not a verdict on the investor. Try its full legal name, or the fund rather than the firm.</span>
            <Link className="btn" href="/investor">Check another investor</Link>
          </div>
        ) : (
          <>
            <p className="inv__verdict">{s.insight}</p>

            <dl className="stats">
              <div>
                <dt>Rounds in Cala</dt>
                <dd className="num">{capped(s.rounds_in_cala, s.capped)}</dd>
              </div>
              <div className="stats__lead">
                <dt>Led</dt>
                <dd className="num">{s.led ?? 0}</dd>
              </div>
              <div>
                <dt>Followed</dt>
                <dd className="num">{Math.max(s.followed ?? 0, followed.length)}</dd>
              </div>
              {p && (
                <div>
                  <dt>Led in the last {p.recent_months} months</dt>
                  <dd className="num">{p.led_recent}</dd>
                </div>
              )}
              {s.knowledge?.added ? (
                <div>
                  <dt>More followed, from reports</dt>
                  <dd className="num">{s.knowledge.added}</dd>
                </div>
              ) : null}
            </dl>
            {s.capped && <p className="faint inv__cap">Cala returns 50 rounds at most, so the real counts are higher.</p>}

            {p?.by_year?.length ? (
              <section className="inv__sec">
                <h2>Rounds per year</h2>
                <YearBars data={p.by_year} variant="full" label={`${s.name}, rounds per year`} />
              </section>
            ) : null}

            <div className="inv__cols">
              <section className="inv__sec">
                <h2>
                  Rounds it led
                  <span className="count num">{s.led ?? led.length}</span>
                </h2>
                {led.length ? (
                  <ul className="deals">
                    {led.map((r) => (
                      <Deal key={r.id} round={r} sources={r.sources} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Cala has no round that {s.name} led.</p>
                )}
                {(s.led ?? 0) > led.length && led.length > 0 && <p className="faint">The latest {led.length} are shown.</p>}
              </section>

              <section className="inv__sec">
                <h2>
                  Rounds it followed, and who led
                  <span className="count num">{Math.max(s.followed ?? 0, followed.length)}</span>
                </h2>
                {followed.length ? (
                  <ul className="deals">
                    {followed.map((r) => (
                      <Deal key={r.id} round={r} sources={r.sources}>
                        {r.relation === 'cap_table' && <>backs the company, not listed in this round<span className="sep"> · </span></>}
                        {r.leads.length ? (
                          <>
                            led by <InvestorList names={r.leads.filter((n) => n !== s.name)} />
                          </>
                        ) : (
                          <span className="faint">no outside lead in Cala</span>
                        )}
                        {r.via === 'knowledge' && (
                          <>
                            <span className="sep"> · </span>
                            <ReportTag />
                          </>
                        )}
                      </Deal>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Cala has no round where {s.name} joined without leading.</p>
                )}
                {noLead > 0 && followed.length > 0 && (
                  <p className="faint">For {plural(noLead, 'round')}, Cala names no lead other than {s.name}.</p>
                )}
              </section>
            </div>

            <section className="inv__sec">
              <h2>
                Who leads when it follows
                <span className="count num">{result.leads.length}</span>
              </h2>
              {result.leads.length ? (
                <>
                  <ol className="usual">
                    {result.leads.map((l) => (
                      <li key={l.key}>
                        <span className="usual__rank num">{l.rank}</span>
                        <span className="usual__name truncate"><Investor name={l.name} ids={l.ids} /></span>
                        <WhyList why={l.why.slice(0, 3)} />
                        {l.pulse?.by_year?.length ? <YearBars data={l.pulse.by_year} variant="spark" label={`${l.name}, rounds per year`} /> : <span />}
                      </li>
                    ))}
                  </ol>
                  <div className="inv__cta">
                    <Link className="btn" href={`/r/${result.run_id}`}>
                      Open the full shortlist, with evidence and drafts
                      <Icon name="arrow" size={14} />
                    </Link>
                    <button type="button" className="btn btn--ghost" onClick={walk}>
                      <Icon name="replay" size={14} />
                      Watch the walk
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">Nobody else led a round {s.name} joined in Cala.</p>
              )}
            </section>

            {profile?.people?.length ? (
              <section className="inv__sec">
                <h2>People Cala names there</h2>
                <ul className="people">
                  {profile.people.slice(0, 12).map((x) => (
                    <li key={x.name}>
                      <span>{x.name}</span>
                      {x.role && <span className="faint">{x.role}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <footer className="run__proof">
              <p>
                <Mark size={18} />
                <span className="num">{proofLine(result)}.</span>
              </p>
              <p className="faint">Every count and round on this page comes from Cala and links to the page Cala found it on.</p>
            </footer>
          </>
        )}
      </main>
    </NamesProvider>
  )
}
