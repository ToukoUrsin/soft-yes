import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { api, investorHref, type Audit, type Company, type Config, type Example, type SoftInput, type StageId } from '../lib/api'
import { isMac, listAnd, plural } from '../lib/format'
import { recentRuns, useConfig, useSessionState, useTask } from '../lib/store'
import { walkStore } from '../lib/walk'
import { SingleField, TokenField, type Token } from '../components/Pickers'
import { CopyButton, Icon, Segmented } from '../components/ui'

function useExamples(): Example[] | null {
  const [examples, set] = useState<Example[] | null>(null)
  useEffect(() => {
    let live = true
    api.examples().then(
      (r) => live && set(r.examples),
      () => live && set([]),
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

function start(soft: SoftInput[], stage: StageId | null, company: { id: string; name: string } | null, navigate: (to: string) => void) {
  void walkStore.start({ soft_yeses: soft, stage, company })
  navigate('/r/live')
}

// ------------------------------------------------------------------------------------- soft yes

function SoftYesAsk({ config }: { config: Config | null }) {
  const [, navigate] = useLocation()
  const [tokens, setTokens] = useSessionState<Token[]>('softyes:tokens', [])
  const [stage, setStage] = useSessionState<StageId | 'ANY'>('softyes:stage', 'ANY')
  const [company, setCompany] = useSessionState<{ id: string; name: string } | null>('softyes:company', null)
  const examples = useExamples()
  const co = useTask<Company>()
  const loaded = useRef<string | null>(null)

  useEffect(() => {
    if (!company || loaded.current === company.id) return
    loaded.current = company.id
    co.run((signal) => api.company(company.id, signal))
    // one read per company picked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  const submit = () => {
    if (!tokens.length) return
    start(tokens.map((t) => ({ name: t.name, ids: t.ids, kind: t.kind })), stage === 'ANY' ? null : stage, company, navigate)
    // The walk has what it needs. Coming back to this page starts from an empty form.
    setTokens([])
    setStage('ANY')
    setCompany(null)
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

  const stages = [{ id: 'ANY' as const, name: 'Any stage' }, ...(config?.stages ?? [])]
  const taken = new Set(tokens.map((t) => t.key))
  const investors = co.data && company && co.data.id === company.id ? co.data.investors : null

  return (
    <main className="page home">
      <div className="home__main">
        <h1>
          They said yes.
          <br />
          If you find a lead.
        </h1>
        <p className="home__lede">
          Name the investors who will follow. Soft Yes walks Cala’s funding graph from them to the investors who led the rounds
          they joined, and checks which of those still lead.
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
            <span className="field-label">Who said they’d follow?</span>
            <TokenField tokens={tokens} onChange={setTokens} label="Who said they’d follow?" placeholder="Type an investor’s name" autoFocus />
            {tokens.length === 1 && (
              <p className="field-hint">
                Have a second one? Add it. On past rounds, two followers found the real lead far more often than one.{' '}
                <Link href="/audit#backtest">See the test</Link>
              </p>
            )}
          </div>

          <div className="field">
            <span className="field-label">
              Stage you are raising <small>optional</small>
            </span>
            <Segmented options={stages} value={stage} onChange={setStage} label="Stage you are raising" />
          </div>

          <div className="field">
            <span className="field-label">
              Your company <small>optional, to check leads for competitors</small>
            </span>
            {company ? (
              <div className="company">
                <span className="token token--plain">
                  <span className="truncate" title={company.name}>{company.name}</span>
                  <button type="button" aria-label={`Remove ${company.name}`} onClick={() => { setCompany(null); loaded.current = null; co.reset() }}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
                {co.status === 'loading' && (
                  <span className="company__row" aria-label="Reading its investors in Cala">
                    <i className="skel" style={{ width: 84, height: 24 }} />
                    <i className="skel" style={{ width: 112, height: 24 }} />
                    <i className="skel" style={{ width: 68, height: 24 }} />
                  </span>
                )}
                {co.status === 'error' && <span className="faint">Cala could not open it: {co.error}</span>}
                {investors && investors.length === 0 && <span className="faint">Cala lists no investors for {company.name}.</span>}
                {investors && investors.length > 0 && (
                  <div className="company__inv">
                    <span className="faint">Its investors in Cala. Add the ones who said yes:</span>
                    <span className="company__row">
                      {investors.slice(0, 14).map((i) => {
                        const on = taken.has(i.key)
                        return (
                          <button
                            key={i.key}
                            type="button"
                            className="chip"
                            aria-pressed={on}
                            disabled={!on && tokens.length >= 6}
                            onClick={() =>
                              setTokens(on ? tokens.filter((t) => t.key !== i.key) : [...tokens, { key: i.key, name: i.name, ids: i.ids, kind: i.kind }])
                            }
                          >
                            <Icon name={on ? 'check' : 'plus'} size={12} />
                            <span className="truncate">{i.name}</span>
                          </button>
                        )
                      })}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <SingleField
                label="Your company"
                placeholder="Find your company in Cala"
                emptyHint="You can leave this empty."
                onPick={(s) => setCompany({ id: s.ids[0], name: s.name })}
              />
            )}
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
              {tokens.length ? `Walks every round ${listAnd(tokens.map((t) => t.name))} joined in Cala` : 'Add at least one investor to start'}
            </span>
          </div>
        </form>

        <section className="home__list" aria-label="Examples">
          <h2>Or start from one of these</h2>
          {examples === null ? (
            <div className="home__skel">
              <i className="skel" style={{ height: 40 }} />
              <i className="skel" style={{ height: 40 }} />
            </div>
          ) : examples.length === 0 ? (
            <p className="faint">The examples could not be loaded. Type an investor’s name above.</p>
          ) : (
            <ul>
              {examples.map((ex) => (
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
            <p>Soft Yes is also an MCP server. Add this address to your own assistant and ask it who could lead your round.</p>
            <div className="copyfield">
              <code className="truncate" title={config.mcp}>{config.mcp}</code>
              <CopyButton text={config.mcp} label="Copy" className="btn btn--ghost btn--sm" />
            </div>
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
  for (const ex of examples ?? []) for (const s of ex.soft_yeses) known.set(s.name, s)
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

/** `mode` is set by the route; without it the deployment's framing decides what the front page asks. */
export function Home({ mode }: { mode?: 'find' | 'check' }) {
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
  return show === 'check' ? <InvestorAsk config={config} findHref={check ? '/find' : '/'} /> : <SoftYesAsk config={config} />
}
