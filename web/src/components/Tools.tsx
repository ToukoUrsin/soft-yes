import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  api, type AskAnswer, type Conflicts as ConflictsData, type ConflictCompany, type Draft, type DraftKind, type Lead,
  type References as ReferencesData, type Result, type Says, type SlushInfo,
} from '../lib/api'
import { capped, fmtEventTime, fmtMoney, fmtMonth, host, plural, possessive } from '../lib/format'
import { useConfig, useFounder, useSessionState } from '../lib/store'
import { Deal } from './Deal'
import { Markdown } from './Markdown'
import { CopyButton, Icon, N, Segmented, Sources, useCopy } from './ui'

interface Props { lead: Lead; result: Result }

// ------------------------------------------------------------------------------- on-demand fetches
// Slow reads keep going when the founder looks at another lead, and are kept for the session.

const done = new Map<string, unknown>()
const flying = new Map<string, { promise: Promise<unknown>; t0: number }>()

function useOnDemand<T>(key: string, fetcher: () => Promise<T>) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const inflight = flying.get(key)
  useEffect(() => {
    if (!inflight) return
    const id = window.setInterval(bump, 1000)
    inflight.promise.then(
      () => alive.current && bump(),
      (e: Error) => {
        if (!alive.current) return
        setError(e.message || 'Something went wrong.')
        bump()
      },
    )
    return () => clearInterval(id)
  }, [inflight])
  const run = () => {
    if (flying.has(key)) return
    setError(null)
    const promise = fetcher()
      .then((d) => {
        done.set(key, d)
        return d
      })
      .finally(() => flying.delete(key))
    promise.catch(() => undefined)
    flying.set(key, { promise, t0: Date.now() })
    bump()
  }
  const data = done.get(key) as T | undefined
  const status: 'idle' | 'loading' | 'done' | 'error' = data !== undefined ? 'done' : inflight ? 'loading' : error ? 'error' : 'idle'
  return { status, data: data ?? null, error, seconds: inflight ? Math.round((Date.now() - inflight.t0) / 1000) : 0, run }
}

function Working({ seconds, steps, hint }: { seconds: number; steps: [number, string][]; hint: string }) {
  const step = [...steps].reverse().find(([from]) => seconds >= from) ?? steps[0]
  return (
    <div className="working" role="status" aria-live="polite">
      <i className="working__bar" aria-hidden="true" />
      <p className="working__now">
        <i className="spinner" aria-hidden="true" />
        <span>{step[1]}</span>
        <span className="num faint">{seconds} s</span>
      </p>
      <p className="faint">{hint}</p>
    </div>
  )
}

function Start({ children, action, onRun, time }: { children: ReactNode; action: string; onRun: () => void; time: string }) {
  return (
    <div className="ondemand">
      <p>{children}</p>
      <div className="ondemand__go">
        <button type="button" className="btn" onClick={onRun}>{action}</button>
        <span className="faint">{time}</span>
      </div>
    </div>
  )
}

function Failed({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <strong>That did not work.</strong>
      <span>{error}</span>
      <button type="button" className="btn" onClick={onRetry}>Try again</button>
    </div>
  )
}

// ------------------------------------------------------------------------------------------ drafts

const KINDS: { id: DraftKind; name: string }[] = [
  { id: 'intro_ask', name: 'Intro ask' },
  { id: 'direct', name: 'Direct' },
  { id: 'slush', name: 'Slush note' },
]

const drafts = new Map<string, { draft: Draft; final: boolean }>()

function useDebounced<T>(value: T, ms: number): T {
  const [v, set] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => set(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/** Template blanks like [your company] stand out until the founder fills the fields. */
function WithBlanks({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]\n]{2,40}\])/g)
  return <>{parts.map((p, i) => (/^\[[^\]]+\]$/.test(p) ? <mark key={i} className="blank">{p.slice(1, -1)}</mark> : p))}</>
}

function FounderFields({ result }: { result: Result }) {
  const [founder, update] = useFounder()
  const stage = result.input.stage_name
  useEffect(() => {
    const name = result.input.company?.name
    if (name && !founder.company) update({ company: name })
    // only when the run changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.run_id])
  return (
    <div className="founder">
      <label>
        <span className="field-label">Your company</span>
        <input name="company" className="input" value={founder.company} onChange={(e) => update({ company: e.target.value })} placeholder="Company name" maxLength={80} autoComplete="organization" />
      </label>
      <label>
        <span className="field-label">What you do, in one line</span>
        <input name="one_liner" className="input" value={founder.one_liner} onChange={(e) => update({ one_liner: e.target.value })} placeholder="We make planning software for bulk shipping" maxLength={200} autoComplete="off" />
      </label>
      <label>
        <span className="field-label">What you are raising</span>
        <input name="raising" className="input" value={founder.raising} onChange={(e) => update({ raising: e.target.value })} placeholder={stage ? `a €4M ${stage}` : 'a €2M seed'} maxLength={80} autoComplete="off" />
      </label>
    </div>
  )
}

export function DraftPane({ lead, result, kind }: Props & { kind: DraftKind }) {
  const [founder] = useFounder()
  const config = useConfig()
  const settled = useDebounced(founder, 700)
  const key = `${result.run_id}:${lead.key}:${kind}:${settled.company}|${settled.one_liner}|${settled.raising}`
  const [state, setState] = useState<{ draft: Draft | null; phrasing: boolean; error: string | null }>({
    draft: drafts.get(key)?.draft ?? null, phrasing: false, error: null,
  })
  const [attempt, retry] = useReducer((n: number) => n + 1, 0)
  const gemini = config?.gemini
  const [subjectCopied, copySubject] = useCopy()

  useEffect(() => {
    if (gemini == null) return
    const hit = drafts.get(key)
    if (hit?.final) {
      setState({ draft: hit.draft, phrasing: false, error: null })
      return
    }
    const ctl = new AbortController()
    let live = true
    setState((s) => ({ draft: hit?.draft ?? (s.draft?.kind === kind ? s.draft : null), phrasing: false, error: null }))
    const body = { run_id: result.run_id, lead_key: lead.key, kind, founder: settled }
    ;(async () => {
      try {
        const template = hit?.draft ?? (await api.draft({ ...body, llm: false }, ctl.signal))
        if (!live) return
        drafts.set(key, { draft: template, final: !gemini })
        setState({ draft: template, phrasing: gemini, error: null })
        if (!gemini) return
        const phrased = await api.draft({ ...body, llm: true }, ctl.signal)
        if (!live) return
        drafts.set(key, { draft: phrased, final: true })
        setState({ draft: phrased, phrasing: false, error: null })
      } catch (e) {
        if (!live || (e as Error).name === 'AbortError') return
        // If only the phrasing failed, the template stays: it is already a complete, checked draft.
        setState((s) => ({ draft: s.draft, phrasing: false, error: s.draft ? null : (e as Error).message }))
      }
    })()
    return () => {
      live = false
      ctl.abort()
    }
    // founder fields are part of `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gemini, attempt])

  const d = state.draft
  if (state.error && !d) return <Failed error={state.error} onRetry={retry} />
  if (!d) {
    return (
      <div className="draft draft--loading" aria-label="Writing the draft" role="status">
        <i className="skel" style={{ width: '38%', height: 14 }} />
        <i className="skel" style={{ width: '92%', height: 14 }} />
        <i className="skel" style={{ width: '84%', height: 14 }} />
        <i className="skel" style={{ width: '61%', height: 14 }} />
      </div>
    )
  }
  const limit = kind === 'slush' ? 300 : null
  const over = limit != null && d.chars > limit
  // What is still a blank in the text. Until the founder fills them in, there is nothing to copy.
  const open = d.placeholders ?? Array.from(new Set(`${d.subject} ${d.body}`.match(/\[[^\]\n]{2,40}\]/g) ?? []))
  const blanks = open.length > 0
  const inSubject = open.some((b) => d.subject.includes(b))
  const yours = d.yours ?? []
  return (
    <div className="draft">
      <div className="draft__paper" key={`${d.model ?? 'template'}:${d.body.length}`}>
        {d.subject && (
          <p className="draft__subject">
            <span className="faint">Subject</span>
            <span className="draft__subject-text"><WithBlanks text={d.subject} /></span>
            {!inSubject && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => copySubject(d.subject)} aria-label="Copy the subject">
                <Icon name={subjectCopied ? 'check' : 'copy'} size={13} />
                {subjectCopied ? 'Copied' : 'Copy'}
              </button>
            )}
          </p>
        )}
        <div className="draft__body"><WithBlanks text={d.body} /></div>
        <div className="draft__foot">
          <span className="draft__status">
            {state.phrasing ? (
              <>
                <i className="spinner" aria-hidden="true" />
                Gemini is rephrasing this. The checked template is shown meanwhile.
              </>
            ) : (
              <>
                <Icon name="check" size={14} />
                {d.checked ? 'Checked against the facts. ' : ''}
                {d.note}
              </>
            )}
          </span>
          {limit != null && (
            <span className={`draft__count num${over ? ' is-over' : ''}`} title={`Slush's meeting tool takes ${limit} characters`}>
              {d.chars} / {limit}
            </span>
          )}
          {blanks ? (
            <span className="draft__fill">
              Fill in {open.map((b, i) => (
                <span key={b}>
                  {i > 0 && (i === open.length - 1 ? ' and ' : ', ')}
                  <mark className="blank">{b.slice(1, -1)}</mark>
                </span>
              ))} to copy
            </span>
          ) : (
            <CopyButton text={d.body} label={kind === 'slush' ? 'Copy note' : 'Copy message'} className="btn btn--primary" />
          )}
        </div>
      </div>
      <div className="draft__facts">
        <h4>
          <Icon name="check" size={13} />
          From Cala, checked<N>{d.facts.length}</N>
        </h4>
        <ol>
          {d.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ol>
        {yours.length > 0 && (
          <>
            <h4 className="draft__yours">
              <i aria-hidden="true" />
              Your own words, not checked<N>{yours.length}</N>
            </h4>
            <ol className="draft__yourslist">
              {yours.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ol>
          </>
        )}
        <p className="faint">
          The draft may use these lines and nothing else. One that adds a name, number or date is thrown away.
        </p>
      </div>
    </div>
  )
}

export function Drafts({ lead, result }: Props) {
  const [stored, setKind] = useSessionState<DraftKind>('softyes:draftkind', 'intro_ask')
  const kind = stored === 'intro_ask' && !lead.ask ? 'direct' : stored
  return (
    <div className="drafts">
      <FounderFields result={result} />
      <div className="drafts__kinds">
        <Segmented options={KINDS} value={kind} onChange={setKind} label="Kind of message" />
        <span className="faint">
          {kind === 'intro_ask'
            ? `To ${lead.ask?.name ?? 'your soft yes'}, asking for the introduction`
            : kind === 'direct'
              ? `To ${lead.name}, citing the shared deal`
              : 'For the Slush meeting tool, 300 characters at most'}
        </span>
      </div>
      <DraftPane lead={lead} result={result} kind={kind} />
    </div>
  )
}

// ------------------------------------------------------------------------------------- says vs did

const TOPIC: Record<string, string> = { leads: 'Leading', stage: 'Stage', cheque: 'Cheque size', sector: 'Sector', geography: 'Geography' }

function pagePath(url: string): string {
  try {
    const u = new URL(url)
    const p = u.pathname.replace(/\/$/, '')
    return `${u.hostname.replace(/^www\./, '')}${p}`
  } catch {
    return url
  }
}

function Did({ says, lead }: { says: Says; lead: Lead }) {
  const d = says.did
  return (
    <div className="says__col">
      <h4>What it did, in Cala</h4>
      {d.rounds == null ? (
        <p className="muted">This walk did not read {possessive(lead.name)} own record.</p>
      ) : (
        <dl className="facts facts--stack">
          <div>
            <dt>Rounds led</dt>
            <dd className="num">
              <b>{d.led ?? 0}</b> of {capped(d.rounds, lead.pulse?.capped)}
            </dd>
          </div>
          <div>
            <dt>Last {d.recent_months ?? 24} months</dt>
            <dd className="num">
              <b>{d.led_recent ?? 0}</b> led
            </dd>
          </div>
          {d.led_stages.length > 0 && (
            <div>
              <dt>Stages it led</dt>
              <dd>
                {d.led_stages.map((s, i) => (
                  <span key={s.stage}>
                    {i > 0 && ', '}
                    {s.stage} <span className="num faint">{s.n}</span>
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      {d.last_led && (
        <>
          <h5>Most recent round it led</h5>
          <ul className="deals deals--tight">
            <Deal round={d.last_led} sources={d.last_led.sources} check={d.last_led.check} who={lead.name} />
          </ul>
        </>
      )}
    </div>
  )
}

export function SaysDid({ lead, result }: Props) {
  const od = useOnDemand<Says>(`says:${result.run_id}:${lead.key}`, () => api.says(result.run_id, lead.key))
  if (od.status === 'idle') {
    return (
      <Start action="Read its website" onRun={od.run} time="5 to 40 seconds the first time">
        Funds describe themselves one way and invest another. This reads {possessive(lead.name)} own website and sets what it says about
        leading, stage and cheque size next to what it did in Cala. Quotes are copied word for word and checked to be on the page.
      </Start>
    )
  }
  if (od.status === 'loading') {
    return (
      <Working
        seconds={od.seconds}
        steps={[[0, 'Finding its website in Cala'], [4, 'Reading its pages'], [14, 'Picking out what it says about how it invests'], [32, 'Still reading. Some sites are slow.']]}
        hint="You can look at another lead meanwhile. This keeps going."
      />
    )
  }
  if (od.status === 'error' || !od.data) return <Failed error={od.error} onRetry={od.run} />
  const s = od.data
  return (
    <div className="says">
      <div className="says__col">
        <h4>
          What it says
          {s.website && (
            <a className="src" href={/^https?:/.test(s.website) ? s.website : `https://${s.website}`} target="_blank" rel="noopener noreferrer">
              <span>{host(/^https?:/.test(s.website) ? s.website : `https://${s.website}`)}</span>
              <Icon name="out" size={11} />
            </a>
          )}
        </h4>
        {s.quotes.length > 0 ? (
          <ul className="quotes">
            {s.quotes.map((q) => (
              <li key={q.text}>
                <blockquote>{q.text}</blockquote>
                <p>
                  <span className="tag">{TOPIC[q.topic] ?? 'Stage'}</span>
                  <a className="src" href={q.url} target="_blank" rel="noopener noreferrer" title={q.url}>
                    <span>{pagePath(q.url)}</span>
                    <Icon name="out" size={11} />
                  </a>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{s.reason ?? 'Nothing quotable about how it invests was found on its site.'}</p>
        )}
        {s.pages.length > 0 && (
          <p className="faint says__pages">
            Read {plural(s.pages.length, 'page')} of its site. Quotes are word for word.
          </p>
        )}
      </div>
      <Did says={s} lead={lead} />
    </div>
  )
}

// --------------------------------------------------------------------------------------- conflicts

/** Cala's stage ids read as enums ("SERIES_A"); say them the way a founder would. */
function stageWord(id: string): string {
  const w = id.toLowerCase().replace(/_/g, ' ')
  return w === 'pre seed' ? 'Pre-seed' : w.replace(/^./, (c) => c.toUpperCase()).replace(/ ([a-z])$/, (_, c: string) => ` ${c.toUpperCase()}`)
}

function Company({ c }: { c: ConflictCompany }) {
  return (
    <li className="co">
      <div className="co__head">
        <span className="co__name">{c.name}</span>
        {c.stage && <span className="faint">{stageWord(c.stage)}</span>}
        <Sources sources={c.sources} max={2} />
      </div>
      {c.description && <p className="muted">{c.description}</p>}
      {(c.shared_industries.length > 0 || c.industries.length > 0) && (
        <p className="co__tags">
          {c.shared_industries.map((i) => (
            <span key={i} className="tag tag--warn" title="An industry Cala lists for your company too">{i}</span>
          ))}
          {c.industries.filter((i) => !c.shared_industries.includes(i)).slice(0, 4).map((i) => (
            <span key={i} className="tag">{i}</span>
          ))}
        </p>
      )}
    </li>
  )
}

export function Conflicts({ lead, result }: Props) {
  const [founder] = useFounder()
  const company = result.input.company?.id ? result.input.company : null
  const [about, setAbout] = useState(founder.one_liner)
  const [asked, setAsked] = useSessionState<string>(`softyes:conflict:${result.run_id}:${lead.key}`, '')
  const subject = company?.id ?? asked
  const od = useOnDemand<ConflictsData>(`conflicts:${result.run_id}:${lead.key}:${subject}`, () =>
    api.conflicts(result.run_id, lead.key, company?.id ?? null, company ? '' : subject),
  )
  // The check goes through the companies the walk listed, so that is the number it states.
  const size = lead.portfolio.length || (lead.pulse?.portfolio_size ?? 0)
  useAutoRun(od, !company && !!asked)

  if (!size) {
    return <p className="state">Cala lists no portfolio companies for {lead.name}, so there is nothing to check against.</p>
  }
  if (od.status === 'loading') {
    return (
      <Working
        seconds={od.seconds}
        steps={[[0, `Going through ${plural(size, 'portfolio company', 'portfolio companies')}`], [5, 'Opening the ones closest to you in Cala'], [20, 'Still opening them']]}
        hint="Descriptions and industries come from Cala. Gemini only picks which companies to open."
      />
    )
  }
  if (od.status === 'error') return <Failed error={od.error} onRetry={od.run} />
  if (od.status === 'done' && od.data) {
    const c = od.data
    const rest = c.checked.filter((x) => !c.overlaps.some((o) => o.id === x.id))
    return (
      <div className="conf">
        {!c.available ? (
          <p className="state">{c.reason}</p>
        ) : c.overlaps.length > 0 ? (
          <>
            <p className="conf__lede">
              <b>{plural(c.overlaps.length, 'portfolio company', 'portfolio companies')}</b> of {lead.name} {c.overlaps.length === 1 ? 'shares' : 'share'} an
              industry with {c.company?.name ?? 'your company'} in Cala. Worth raising before you pitch.
            </p>
            <ul className="cos">{c.overlaps.map((x) => <Company key={x.id} c={x} />)}</ul>
          </>
        ) : !c.company && c.checked.length > 0 ? (
          <p className="conf__lede">
            <b>{plural(c.checked.length, 'portfolio company', 'portfolio companies')}</b> of {lead.name} {c.checked.length === 1 ? 'looks' : 'look'} closest
            to what you described. <span className="muted">Read {c.checked.length === 1 ? 'it' : 'them'} and judge: a description alone gives Cala no industry to match on.</span>
          </p>
        ) : (
          <p className="conf__lede">
            {c.checked.length > 0
              ? `Cala lists no shared industry between ${c.company?.name ?? 'your company'} and the ${plural(c.checked.length, 'portfolio company', 'portfolio companies')} opened.`
              : (c.reason ?? 'No portfolio company looked close enough to open.')}{' '}
            <span className="muted">That is not proof there is no competitor: Cala lists {plural(c.portfolio_size, 'company', 'companies')} for {lead.name}.</span>
          </p>
        )}
        {rest.length > 0 && (
          <>
            <h4>{c.overlaps.length ? 'Also opened, no shared industry' : c.company ? 'The closest ones, opened' : 'Opened in Cala'}</h4>
            <ul className="cos">{rest.map((x) => <Company key={x.id} c={x} />)}</ul>
          </>
        )}
        {c.note && <p className="faint conf__note">{c.note}</p>}
        {!company && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsked('')}>
            Check a different description
          </button>
        )}
      </div>
    )
  }
  if (company) {
    return (
      <Start action={`Check against ${company.name}`} onRun={od.run} time="About 10 seconds">
        Does {lead.name} already back someone in your space? This goes through its {plural(size, 'portfolio company', 'portfolio companies')} in
        Cala and opens the ones closest to {company.name}.
      </Start>
    )
  }
  const submit = () => {
    const text = about.trim()
    if (text.length < 8) return
    setAsked(text)
  }
  return (
    <form
      className="ondemand"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <p>
        Does {lead.name} already back someone in your space? Say what your company does and this goes through its{' '}
        {plural(size, 'portfolio company', 'portfolio companies')} in Cala.
      </p>
      <label>
        <span className="field-label">What your company does</span>
        <input name="about" className="input" value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Planning software for bulk shipping" maxLength={240} />
      </label>
      <div className="ondemand__go">
        <button type="submit" className="btn" disabled={about.trim().length < 8}>Check its portfolio</button>
        <span className="faint">About 10 seconds. Pick your company on the start page to match on Cala’s own industries.</span>
      </div>
    </form>
  )
}

/** The form sets what to ask; the fetch starts once there is something to ask about. */
function useAutoRun(od: { status: string; run: () => void }, when: boolean) {
  useEffect(() => {
    if (when && od.status === 'idle') od.run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [when, od.status])
}

// -------------------------------------------------------------------------------------- references

export function References({ lead, result }: Props) {
  const od = useOnDemand<ReferencesData>(`refs:${result.run_id}:${lead.key}`, () => api.references(result.run_id, lead.key))
  if (od.status === 'idle') {
    return (
      <Start action="Find founders to call" onRun={od.run} time="A few seconds">
        Before you take a lead’s money, talk to founders it has already led. This looks up who founded or runs the companies
        behind {possessive(lead.name)} latest led rounds, each with the page that names them.
      </Start>
    )
  }
  if (od.status === 'loading') {
    return <Working seconds={od.seconds} steps={[[0, 'Opening the companies it led most recently'], [8, 'Reading who founded them']]} hint="Names come from Cala with their source." />
  }
  if (od.status === 'error' || !od.data) return <Failed error={od.error} onRetry={od.run} />
  const r = od.data
  if (!r.references.length) {
    return (
      <p className="state">
        Cala names no founder or chief executive for the {plural(r.companies_checked, 'company', 'companies')} {lead.name} led most recently
        {r.unnamed.length ? ` (${r.unnamed.join(', ')})` : ''}.
      </p>
    )
  }
  return (
    <div className="refs">
      <p className="conf__lede">
        {plural(r.people, 'founder')} at {plural(r.references.length, 'company', 'companies')} {lead.name} led. Ask them how it behaves after the round closes.
      </p>
      <ul className="refs__list">
        {r.references.map((x) => (
          <li key={x.company.id}>
            <div className="refs__co">
              <span className="co__name">{x.company.name}</span>
              <span className="muted">
                {[x.round.stage_name && x.round.stage_name !== 'Round' ? x.round.stage_name : '', fmtMoney(x.round.amount, x.round.currency), fmtMonth(x.round.date)].filter(Boolean).join(', ')}
              </span>
              <Sources sources={x.round_sources} max={1} />
            </div>
            <ul className="refs__people">
              {x.people.map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <span className="faint">{p.role}</span>
                  <Sources sources={p.sources} max={1} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {r.unnamed.length > 0 && <p className="faint">Cala names nobody at {r.unnamed.join(', ')}.</p>}
    </div>
  )
}

// ------------------------------------------------------------------------------------------- slush

export function Slush({ lead, result }: Props) {
  const od = useOnDemand<SlushInfo>(`slush:${result.run_id}:${lead.key}`, () => api.slush(result.run_id, lead.key))
  useAutoRun(od, true)
  if (od.status === 'error') return <Failed error={od.error} onRetry={od.run} />
  if (od.status !== 'done' || !od.data) {
    return <Working seconds={od.seconds} steps={[[0, 'Checking who is registered and the side events']]} hint="From the Slush attendee directory and the public side-event listings." />
  }
  const s = od.data
  const days = s.slush.days_away
  const when = days > 1 ? `Slush starts in ${days} days` : days === 1 ? 'Slush starts tomorrow' : days === 0 ? 'Slush starts today' : days >= -1 ? 'Slush is on now' : 'Slush 2026 is over'
  const at = s.attending
  return (
    <div className="slush">
      <div className="slush__top">
        <p className="conf__lede">
          {at ? (
            <>
              <b>{plural(at.people, 'person', 'people')}</b> from {at.firm} {at.people === 1 ? 'is' : 'are'} registered for Slush
              {at.titles.length ? `: ${at.titles.join(', ')}` : ''}.
            </>
          ) : s.directory?.connected ? (
            <>Nobody from {lead.name} is in the Slush attendee directory under that name.</>
          ) : (
            <>The Slush attendee directory is not connected, so this shows side events only.</>
          )}{' '}
          <span className="muted">{when}.</span>
        </p>
        {s.directory?.connected && (
          <p className="faint">
            Checked against {s.directory.people.toLocaleString('en-GB')} registered investors at {s.directory.firms.toLocaleString('en-GB')} firms. Head counts and job titles only.
          </p>
        )}
      </div>

      <h4>
        Side events it hosts or is named in<N>{s.events.length}</N>
      </h4>
      {s.events.length > 0 ? (
        <ul className="events">
          {s.events.map((e) => (
            <li key={e.id}>
              <time className="events__when">{fmtEventTime(e.start, e.end)}</time>
              <div className="events__what">
                <p className="events__title">
                  {e.title ?? 'Untitled event'}
                  <span className={e.role === 'host' ? 'tag tag--accent' : 'tag'}>{e.role === 'host' ? 'Hosts it' : 'Named in it'}</span>
                </p>
                <p className="muted">{[e.host ? `Hosted by ${e.host}` : '', e.venue].filter(Boolean).join(' · ')}</p>
                {e.snippet && <p className="faint events__snip">{e.snippet}</p>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None of the {s.events_checked} public side events names {lead.name}.</p>
      )}
      {s.source && (
        <p className="faint slush__src">
          {s.events_checked} listings checked, times in Helsinki.
          <a className="src" href={s.source.url} target="_blank" rel="noopener noreferrer">
            <span>{s.source.publisher}</span>
            <Icon name="out" size={11} />
          </a>
        </p>
      )}

    </div>
  )
}

// ---------------------------------------------------------------------------------------- ask cala

export function AskCala({ lead, result }: Props) {
  const stage = result.input.stage_name
  const suggestions = [
    `Which funding rounds has ${lead.name} led most recently?`,
    stage ? `Does ${lead.name} lead ${stage} rounds, and how large are they?` : `What stage does ${lead.name} usually lead at?`,
    `Who are the partners at ${lead.name}?`,
  ]
  const [q, setQ] = useState('')
  const [asked, setAsked] = useSessionState<string>(`softyes:ask:${result.run_id}:${lead.key}`, '')
  const od = useOnDemand<AskAnswer>(`ask:${result.run_id}:${lead.key}:${asked}`, () => api.ask(result.run_id, lead.key, asked))
  useAutoRun(od, !!asked)
  const ask = (text: string) => {
    const t = text.trim()
    if (t.length < 6) return
    setQ(t)
    setAsked(t)
  }
  const a = od.data
  return (
    <div className="ask">
      <form
        className="ask__form"
        onSubmit={(e) => {
          e.preventDefault()
          ask(q)
        }}
      >
        <label className="sr-only" htmlFor="ask-q">Ask Cala about {lead.name}</label>
        <input id="ask-q" name="question" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask Cala about ${lead.name}`} maxLength={300} autoComplete="off" />
        <button type="submit" className="btn" disabled={q.trim().length < 6 || od.status === 'loading'}>Ask</button>
      </form>
      {od.status !== 'loading' && (
        <ul className="ask__ideas">
          {suggestions.filter((s) => s !== asked).map((s) => (
            <li key={s}>
              <button type="button" onClick={() => ask(s)}>
                <span>{s}</span>
                <Icon name="arrow" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!asked && (
        <p className="faint ask__note">
          Cala answers from its own graph and shows the steps and sources behind the answer. It takes 10 to 50 seconds.
        </p>
      )}
      {asked && od.status === 'loading' && (
        <Working
          seconds={od.seconds}
          steps={[[0, 'Cala is searching its graph'], [12, 'Cala is reasoning over what it found'], [35, 'Still working. Long answers take up to a minute.']]}
          hint={asked}
        />
      )}
      {asked && od.status === 'error' && <Failed error={od.error} onRetry={od.run} />}
      {asked && od.status === 'done' && a && (
        <div className="ask__answer">
          <p className="ask__q">{a.question}</p>
          {!a.available || !a.answer ? (
            <p className="state">{a.reason ?? 'Cala gave no answer to that.'}</p>
          ) : (
            <>
              <Markdown text={a.answer} />
              {a.steps && a.steps.length > 0 && (
                <details className="ask__steps" open={a.steps.length <= 4}>
                  <summary>
                    <Icon name="chevron" size={14} />
                    How Cala got there
                    <span className="count num">{plural(a.steps.length, 'step')}{a.facts ? `, ${plural(a.facts, 'fact')}` : ''}</span>
                  </summary>
                  <ol>
                    {a.steps.map((s, i) => (
                      <li key={i}>
                        {s.content && <Markdown text={s.content} />}
                        {s.facts.length > 0 && (
                          <ul className="ask__facts">
                            {s.facts.map((f, j) => (
                              <li key={f.id ?? j}>
                                <span>{f.content}</span>
                                <Sources sources={f.origins.map((o) => ({ publisher: o.publisher, url: o.url }))} max={2} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              <p className="faint ask__note">This answer and its sources are Cala’s own. Soft Yes adds nothing to it.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
