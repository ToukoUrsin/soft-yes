import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { api, type Draft, type DraftKind, type Lead, type Result, type Says, type SlushInfo } from '../lib/api'
import { capped, fmtEventTime, host, plural, possessive } from '../lib/format'
import { useConfig, useFounder, useSessionState } from '../lib/store'
import { Deal } from './Deal'
import { CopyButton, Icon, N, Segmented, useCopy } from './ui'

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

/** The founder's lines, with the company the walk was started for filled in once. */
export function useRunFounder(result: Result) {
  const [founder, update] = useFounder()
  useEffect(() => {
    const name = result.input.company?.name
    if (name && !founder.company) update({ company: name })
    // only when the run changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.run_id])
  return [founder, update] as const
}

function FounderFields({ result }: { result: Result }) {
  const [founder, update] = useRunFounder(result)
  const stage = result.input.stage_name
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

/**
 * One draft. With `onChange` it is the short form the result page opens on: the message, its note and Copy, with a way
 * into the form. `wait` holds the fetch while the walk may still change who the message is about.
 */
export function DraftPane({
  lead, result, kind, onChange, wait = false,
}: Props & { kind: DraftKind; onChange?: () => void; wait?: boolean }) {
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
    if (gemini == null || wait) return
    const hit = drafts.get(key)
    if (hit?.final) {
      setState({ draft: hit.draft, phrasing: false, error: null })
      return
    }
    const ctl = new AbortController()
    let live = true
    // Never the last draft under new inputs: a reader takes whatever text is on the page as the answer.
    setState({ draft: hit?.draft ?? null, phrasing: false, error: null })
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
  }, [key, gemini, attempt, wait])

  // Typed, not yet sent: what is on the page was written for the old words.
  const typing = founder.company !== settled.company || founder.one_liner !== settled.one_liner || founder.raising !== settled.raising
  const d = typing ? null : state.draft
  if (state.error && !d && !typing) return <Failed error={state.error} onRetry={retry} />
  if (!d) {
    const yours = founder.company || founder.one_liner || founder.raising
    return (
      <div className="draft draft--loading" role="status" aria-live="polite">
        <p className="draft__writing">
          <i className="spinner" aria-hidden="true" />
          {wait
            ? 'Still reading. The message is written when the shortlist has settled.'
            : yours ? `Writing ${kind === 'slush' ? 'the note' : 'the message'} with what you typed` : `Writing ${kind === 'slush' ? 'the note' : 'the message'} from Cala’s facts`}
        </p>
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
  // The model's first try, when code threw it out: the sentence about it leaves the note and gets its own line.
  const rejected = d.rejected ?? []
  const at = rejected.length ? d.note.indexOf('dropped: it added') : -1
  const cut = at >= 0 ? d.note.lastIndexOf('. ', at) + 1 : -1
  const whole = cut >= 0 ? d.note.slice(0, cut).trim() : d.note
  // The server's note points at the fact lines "below"; the short form does not list them.
  const note = onChange ? whole.replace(/ below\b/g, '') : whole
  const droppedLead = at >= 0 ? d.note.slice(cut, at + 'dropped: it added'.length).trim() : 'A draft was dropped: it added'
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
                {note}
              </>
            )}
          </span>
          {limit != null && (
            <span className={`draft__count num${over ? ' is-over' : ''}`} title={`Slush's meeting tool takes ${limit} characters`}>
              {d.chars} / {limit}
            </span>
          )}
          {onChange && (
            <button type="button" className="link draft__change" onClick={onChange}>
              Change it
            </button>
          )}
          {onChange ? (
            <CopyButton text={d.body} label="Copy message" className={blanks ? 'btn' : 'btn btn--primary'} />
          ) : blanks ? (
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
      {rejected.length > 0 && !state.phrasing && (
        <p className="draft__dropped">
          <Icon name="x" size={13} />
          <span>
            {droppedLead}{' '}
            {rejected.map((w, i) => (
              <span key={w}>
                {i > 0 && ', '}
                <mark>{w}</mark>
              </span>
            ))}
            . <span className="faint">{onChange ? 'Code caught it, not a model.' : 'Code caught it, not a model: none of that is in the lines below.'}</span>
          </span>
        </p>
      )}
      {!onChange && <div className="draft__facts">
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
      </div>}
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
          {d.led_read ? (
            <div>
              <dt>Pages read</dt>
              <dd className="num">
                <b>{d.led_on_page ?? 0}</b> of {d.led_read} say it led
              </dd>
            </div>
          ) : null}
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

/** The form sets what to ask; the fetch starts once there is something to ask about. */
function useAutoRun(od: { status: string; run: () => void }, when: boolean) {
  useEffect(() => {
    if (when && od.status === 'idle') od.run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [when, od.status])
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
        <p className="slush__lede">
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
