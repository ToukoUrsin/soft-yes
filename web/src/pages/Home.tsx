import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { api, investorHref, type Audit, type Company, type CompanyRef, type Config, type Example, type SoftInput, type StageId } from '../lib/api'
import { isMac, listAnd, plural } from '../lib/format'
import { recentRuns, useConfig, useSessionState, useTask } from '../lib/store'
import { walkStore } from '../lib/walk'
import { SingleField, TokenField, type Token } from '../components/Pickers'
import { CopyButton, Icon, Segmented } from '../components/ui'
import { Front } from './Front'

interface Examples { examples: Example[]; real: Example[] }

function useExamples(): Examples | null {
  const [examples, set] = useState<Examples | null>(null)
  useEffect(() => {
    let live = true
    api.examples().then(
      (r) => live && set({ examples: r.examples, real: r.real ?? [] }),
      () => live && set({ examples: [], real: [] }),
    )
    return () => {
      live = false
    }
  }, [])
  return examples
}

function CreditNote({ config }: { config: Config | null }) {
  if (!config || config.credits.used < config.credits.cap) return null
  return (
    <p className="notice">
      <Icon name="alert" size={14} />
      Live reads from Cala are paused: this demo has used its credits. Investors already walked still work, including the examples.
    </p>
  )
}

/** The three marks the graph is drawn with, in the order the walk meets them. */
function HowItWalks() {
  return (
    <aside className="hops" aria-label="How the walk goes">
      <h2>What the walk does</h2>
      <ol>
        <li>
          <i className="hops__soft" aria-hidden="true" />
          <div>
            <p>Starts at the investor who said yes</p>
            <span>Cala lists every funding round it took part in.</span>
          </div>
        </li>
        <li>
          <i className="hops__round" aria-hidden="true" />
          <div>
            <p>Opens each round it joined without leading</p>
            <span>Company, stage, amount, date, and the page that reported it.</span>
          </div>
        </li>
        <li>
          <i className="hops__lead" aria-hidden="true" />
          <div>
            <p>Arrives at whoever led that round</p>
            <span>Then reads that investor’s own record: does it still lead?</span>
          </div>
        </li>
        <li>
          <i className="hops__page" aria-hidden="true" />
          <div>
            <p>Opens the page behind each “led”</p>
            <span>And shows the sentence. Where the page names another lead, the page wins.</span>
          </div>
        </li>
      </ol>
      <PageCheckLine />
    </aside>
  )
}

/** What the page check has found so far, across every walk. The number is the proof; the link is the list. */
function PageCheckLine() {
  const [a, set] = useState<Audit | null>(null)
  useEffect(() => {
    const ctl = new AbortController()
    api.audit(ctl.signal).then(set, () => undefined)
    return () => ctl.abort()
  }, [])
  return (
    <Link href="/audit" className="hops__audit">
      <span>
        {a && a.claims > 0 ? (
          <>
            <b className="num">{a.confirmed}</b> of <b className="num">{a.claims}</b> lead claims confirmed word for word
            {a.corrected > 0 && <>, <b className="num">{a.corrected}</b> corrected</>}
          </>
        ) : (
          'What the pages say'
        )}
      </span>
      <Icon name="arrow" size={14} />
    </Link>
  )
}

function Recent() {
  const [runs] = useState(recentRuns)
  if (!runs.length) return null
  return (
    <section className="home__list" aria-label="Your recent walks">
      <h2>Your recent walks</h2>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <Link href={`/r/${r.id}`} className="pick">
              <span className="pick__name truncate">{r.names.join(' + ')}</span>
              <span className="pick__blurb truncate">
                {[r.stage, r.leads ? plural(r.leads, 'lead') : 'no lead found'].filter(Boolean).join(', ')}
              </span>
              <Icon name="arrow" size={14} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function start(soft: SoftInput[], stage: StageId | null, company: CompanyRef | null, navigate: (to: string) => void) {
  void walkStore.start({ soft_yeses: soft, stage, company })
  navigate('/r/live')
}

// ------------------------------------------------------------------------------------- soft yes

function SoftYesAsk({ config }: { config: Config | null }) {
  const [, navigate] = useLocation()
  const [tokens, setTokens] = useSessionState<Token[]>('softyes:tokens', [])
  const [stage, setStage] = useSessionState<StageId | 'ANY'>('softyes:stage', 'ANY')
  const [company, setCompany] = useSessionState<CompanyRef | null>('softyes:company', null)
  // Whose investors the form was filled from, so a trip to the result and back does not fill it twice.
  const [filled, setFilled] = useSessionState<string | null>('softyes:filled', null)
  const examples = useExamples()
  const co = useTask<Company>()
  const loaded = useRef<string | null>(null)

  useEffect(() => {
    if (!company || loaded.current === company.id) return
    loaded.current = company.id
    // Reading the company also starts its walk on the server, so the answer is close when it is asked for.
    co.run((signal) => api.company(company.ids?.length ? company.ids : company.id, signal))
    // one read per company picked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  const data = co.data && company && (co.data.id === company.id || company.ids?.includes(co.data.id)) ? co.data : null
  const stages = [{ id: 'ANY' as const, name: 'Any stage' }, ...(config?.stages ?? [])]

  // The company's own investors start the walk: the founder takes out anyone who will not follow.
  useEffect(() => {
    if (!data || !company || filled === company.id) return
    setFilled(company.id)
    const softs = new Set(data.softs ?? [])
    const mine = data.investors.filter((i) => softs.has(i.key)).map((i) => ({ key: i.key, name: i.name, ids: i.ids, kind: i.kind }))
    if (mine.length && !tokens.length) setTokens(mine)
    if (stage === 'ANY' && data.next_stage && config?.stages.some((s) => s.id === data.next_stage)) setStage(data.next_stage as StageId)
    // once per company
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, company?.id])

  const clear = () => {
    setCompany(null)
    setFilled(null)
    loaded.current = null
    co.reset()
  }

  const submit = () => {
    if (!tokens.length) return
    start(tokens.map((t) => ({ name: t.name, ids: t.ids, kind: t.kind })), stage === 'ANY' ? null : stage, company, navigate)
    // The walk has what it needs. Coming back to this page starts from an empty form.
    setTokens([])
    setStage('ANY')
    clear()
  }
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        submitRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const taken = new Set(tokens.map((t) => t.key))
  const rest = data ? data.investors.filter((i) => !taken.has(i.key)) : []
  const fromCompany = !!data && !!company && filled === company.id && tokens.some((t) => data.investors.some((i) => i.key === t.key))
  const stageNow = data?.stage ? config?.stages.find((s) => s.id === data.stage)?.name ?? null : null
  const fact = data
    ? [stageNow, data.hq?.split(',').slice(-2).join(',').trim() || null, data.investors.length ? plural(data.investors.length, 'investor') + ' in Cala' : null]
        .filter(Boolean).join(' · ')
    : ''

  return (
    <main className="page home">
      <div className="home__main">
        <h1>
          They said yes.
          <br />
          If you find a lead.
        </h1>
        <p className="home__lede">
          Type your company. Soft Yes starts from the investors you already have, walks Cala’s funding graph to the investors who
          led the rounds they joined, and checks which of those still lead.
        </p>
        <CreditNote config={config} />

        <form
          className="home__form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="field">
            <span className="field-label">Your company</span>
            {company ? (
              <div className="company">
                <span className="company__head">
                  <span className="token token--plain">
                    <span className="truncate" title={company.name}>{company.name}</span>
                    <button type="button" aria-label={`Remove ${company.name}`} onClick={clear}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                  {fact && <span className="company__fact">{fact}</span>}
                </span>
                {co.status === 'loading' && (
                  <span className="company__row" aria-label="Reading its investors in Cala">
                    <i className="skel" style={{ width: 84, height: 24 }} />
                    <i className="skel" style={{ width: 112, height: 24 }} />
                    <i className="skel" style={{ width: 68, height: 24 }} />
                  </span>
                )}
                {co.status === 'error' && <span className="faint">Cala could not open it: {co.error}</span>}
                {data && data.investors.length === 0 && (
                  <span className="faint">Cala lists no investors for {company.name} yet. Name the ones who said yes below.</span>
                )}
                {rest.length > 0 && (
                  <div className="company__inv">
                    <span className="faint">Also in {company.name}, by Cala’s record. Add anyone who said yes:</span>
                    <span className="company__row">
                      {rest.slice(0, 12).map((i) => (
                        <button
                          key={i.key}
                          type="button"
                          className="chip"
                          disabled={tokens.length >= 6}
                          onClick={() => setTokens([...tokens, { key: i.key, name: i.name, ids: i.ids, kind: i.kind }])}
                        >
                          <Icon name="plus" size={12} />
                          <span className="truncate">{i.name}</span>
                        </button>
                      ))}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <SingleField
                label="Your company"
                company
                large
                autoFocus
                placeholder="Type your company’s name"
                emptyHint="Not in Cala yet? Name your investors below."
                onPick={(s) => setCompany({ id: s.ids[0], name: s.name, ids: s.ids })}
              />
            )}
          </div>

          <div className="field">
            <span className="field-label">
              Who said they’d follow?{!company && <small>or start here, without a company</small>}
            </span>
            <TokenField tokens={tokens} onChange={setTokens} label="Who said they’d follow?" placeholder="Type an investor’s name" />
            <div className="field-hint" data-on={fromCompany || tokens.length === 1 || undefined} aria-hidden={!(fromCompany || tokens.length === 1)}>
              {fromCompany && company ? (
                <p>Your investors in Cala. Take out anyone who won’t follow this time.</p>
              ) : (
                <p>
                  Have a second one? Add it. On past rounds, two followers found the real lead far more often than one.{' '}
                  <Link href="/audit#backtest" tabIndex={tokens.length === 1 ? undefined : -1}>See the test</Link>
                </p>
              )}
            </div>
          </div>

          <div className="field">
            <span className="field-label">
              Stage you are raising <small>{fromCompany && stageNow && stage !== 'ANY' ? `the round after your ${stageNow.toLowerCase()}` : 'optional'}</small>
            </span>
            <Segmented options={stages} value={stage} onChange={setStage} label="Stage you are raising" />
          </div>

          <div className="home__go">
            <button type="submit" className="btn btn--primary btn--lg" disabled={!tokens.length}>
              Find the lead
              <span className="home__keys" aria-hidden="true">
                <kbd className="kbd">{isMac ? '⌘' : 'Ctrl'}</kbd>
                <kbd className="kbd">Enter</kbd>
              </span>
            </button>
            <span className="faint">
              {tokens.length
                ? `Walks every round ${listAnd(tokens.map((t) => t.name))} joined in Cala`
                : company && co.status === 'loading' ? 'Reading its investors in Cala' : 'Pick your company or add an investor to start'}
            </span>
          </div>
        </form>

        {examples === null ? (
          <section className="home__list" aria-label="Examples">
            <h2>Or open a real one</h2>
            <div className="home__skel">
              <i className="skel" style={{ height: 40 }} />
              <i className="skel" style={{ height: 40 }} />
            </div>
          </section>
        ) : (
          <>
            {examples.real.length > 0 && (
              <section className="home__list" aria-label="Real companies">
                <h2>Or open a real one, from the investors Cala lists in it</h2>
                <ul>
                  {examples.real.map((ex) => (
                    <li key={ex.id}>
                      <button type="button" className="pick" onClick={() => start(ex.soft_yeses, ex.stage, ex.company ?? null, navigate)}>
                        <span className="pick__name truncate">{ex.title}</span>
                        <span className="pick__blurb truncate">
                          {[ex.stage ? config?.stages.find((st) => st.id === ex.stage)?.name : null, ex.blurb].filter(Boolean).join('. ')}
                        </span>
                        <Icon name="arrow" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="home__list" aria-label="Examples">
              <h2>{examples.real.length > 0 ? 'Or from two investors who said yes' : 'Or start from one of these'}</h2>
              {examples.examples.length === 0 ? (
                <p className="faint">The examples could not be loaded. Type an investor’s name above.</p>
              ) : (
                <ul>
                  {examples.examples.map((ex) => (
                    <li key={ex.id}>
                      <button type="button" className="pick" onClick={() => start(ex.soft_yeses, ex.stage, null, navigate)}>
                        <span className="pick__name truncate">{ex.title}</span>
                        <span className="pick__blurb truncate">{ex.blurb}</span>
                        <Icon name="arrow" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <Recent />
      </div>

      <div className="home__side">
        <HowItWalks />
        <p className="home__principle">
          Every fact comes from Cala with its source. No language model states a fact. One only phrases the messages, and each draft
          is checked against the facts it was handed.
        </p>
        {config?.mcp && (
          <div className="home__mcp">
            <p>Use it inside Claude. Add this address as a custom connector (Customize, Connectors) and ask which investors fit your round, or who could lead it. The answer draws in your chat.</p>
            <div className="copyfield">
              <code className="truncate" title={config.mcp}>{config.mcp}</code>
              <CopyButton text={config.mcp} label="Copy" className="btn btn--ghost btn--sm" />
            </div>
            <p>
              <a className="link" href="/chat">See it without Claude</a> · <a className="link" href="/film.mp4">Watch the film (1:56)</a>
            </p>
          </div>
        )}
      </div>
    </main>
  )
}

// ------------------------------------------------------------------------------- investor check

function InvestorAsk({ config, findHref }: { config: Config | null; findHref: string }) {
  const [, navigate] = useLocation()
  const examples = useExamples()
  const known = new Map<string, SoftInput>()
  for (const ex of examples?.examples ?? []) for (const s of ex.soft_yeses) known.set(s.name, s)
  return (
    <main className="page home home--check">
      <div className="home__main">
        <h1>
          Will this investor lead,
          <br />
          or wait for one?
        </h1>
        <p className="home__lede">
          Name an investor. Soft Yes reads its funding rounds in Cala: how many it led, how many it followed, and who led when it
          followed.
        </p>
        <CreditNote config={config} />
        <div className="home__form">
          <div className="field">
            <span className="field-label">Which investor?</span>
            <SingleField
              large
              autoFocus
              label="Which investor?"
              placeholder="Type an investor’s name"
              emptyHint="Try the fund’s full name."
              onPick={(s) => navigate(investorHref(s.ids, s.name))}
            />
          </div>
          {known.size > 0 && (
            <p className="home__try">
              <span className="faint">Try</span>
              {Array.from(known.values()).slice(0, 5).map((s) => (
                <Link key={s.name} className="chip" href={investorHref(s.ids, s.name)}>
                  <span className="truncate">{s.name}</span>
                </Link>
              ))}
            </p>
          )}
        </div>
        <p className="home__alt">
          Already have investors who said they will follow?{' '}
          <Link className="link" href={findHref}>Find the lead for that round</Link>
        </p>
      </div>
      <div className="home__side">
        <p className="home__principle">
          Every count comes from Cala and every round links to the page that reported it. No language model states a fact.
        </p>
      </div>
    </main>
  )
}

/** `/?fresh=1` opens the page as a first visitor sees it: no half-filled form, no recent walks, no saved pitch. */
function startFresh() {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('fresh')) return
  try {
    for (const store of [sessionStorage, localStorage]) {
      for (const key of Object.keys(store)) if (key.startsWith('softyes:')) store.removeItem(key)
    }
  } catch {
    // storage is off: there is nothing to clear
  }
  history.replaceState(null, '', location.pathname)
}

/** `mode` is set by the route; without it the deployment's framing decides what the front page asks. */
export function Home({ mode }: { mode?: 'find' | 'check' }) {
  useState(startFresh)
  const config = useConfig()
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const id = window.setTimeout(() => setWaited(true), 900)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => {
    document.title = 'Soft Yes'
  }, [])
  if (!mode && !config && !waited) return <main className="page home" aria-busy="true" />
  const check = config?.framing === 'investor_check'
  const show = mode ?? (check ? 'check' : 'find')
  if (!mode && !check) return <Front />
  return show === 'check' ? <InvestorAsk config={config} findHref="/find" /> : <SoftYesAsk config={config} />
}
