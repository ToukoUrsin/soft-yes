// The smaller cards: the intro ask, where the round stands, and a claim checked against its page.

import { useEffect, useState } from 'preact/hooks'
import { callTool, openLink, say, tell } from './bridge'
import { type ClaimData, type DraftData, type TrackerData, STATUS_WORD, day, listAnd, money, month, num, ok, plural, roundName, wrong } from './lib'
import { Btn, Head, Icon, Ledger, Link, Quote, Src } from './ui'

// ---------------------------------------------------------------------------------------------- the ask

/** Has the connector write the ask from the run's checked facts; null when the chat does not let a card call tools. */
export async function writeAsk(args: { run_id: string; lead: string; kind?: string; company?: string | null; raising?: string | null }): Promise<DraftData | null> {
  try {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v))
    const r = await callTool('draft_intro', clean, 60_000)
    return !r.isError && r.structuredContent?.view === 'draft' ? (r.structuredContent as DraftData) : null
  } catch {
    return null
  }
}

function askTitle(d: DraftData) {
  const to = d.to.name ? `${d.to.name}${d.to.fund ? `, ${d.to.fund}` : ''}` : d.to.fund || d.lead.name
  const kind = d.kind === 'intro_ask' ? 'Intro ask' : d.kind === 'direct' ? 'Note to the lead' : 'Slush meeting note'
  return { to, kind }
}

/** The ask itself: the mail, every fact in it with its source, and the ways out. `onClose` when it sits inside another card. */
export function DraftBody({ data: d, onClose, proofAbove }: { data: DraftData; onClose?: () => void; proofAbove?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const { to, kind } = askTitle(d)
  const text = (d.subject ? `Subject: ${d.subject}\n\n` : '') + d.body

  const gmail = () => {
    const q = [d.to.email ? `to=${encodeURIComponent(d.to.email)}` : '', d.subject ? `su=${encodeURIComponent(d.subject)}` : '', `body=${encodeURIComponent(d.body)}`]
    openLink(`https://mail.google.com/mail/?view=cm&fs=1&${q.filter(Boolean).join('&')}`)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      const done = document.execCommand('copy')
      ta.remove()
      setState(done ? 'copied' : 'failed')
    }
  }
  useEffect(() => {
    tell(`The Soft Yes ${kind.toLowerCase()} to ${to} about ${d.lead.name} is on screen, written from checked facts only. If asked to save it as a mail draft, save exactly this and do not send it:\n\n${text}`)
  }, [d])

  return (
    <>
      {onClose && (
        <div class="ask__top">
          <p><b>{kind} to {to}</b><span>Written only from the facts below. You send it.</span></p>
          <button type="button" class="tool" onClick={onClose}><Icon name="x" size={13} />Close</button>
        </div>
      )}
      <article class="mail">
        {d.to.email && <p class="mail__row"><span>To</span><b>{d.to.email}</b></p>}
        {d.subject && <p class="mail__row"><span>Subject</span><b>{d.subject}</b></p>}
        <div class="mail__body">{d.body.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>
        {d.placeholders.length > 0 && <p class="mail__gap">Still yours to fill in: {d.placeholders.join(', ')}</p>}
      </article>

      <section class="facts">
        <h2>Every fact in it, and where it is from</h2>
        <ul>
          {d.facts.map((f) => <li key={f}><Src kind="cala" /><span>{f}</span></li>)}
          {d.yours.map((f) => <li key={f}><Src kind="typed" label="You" /><span>{f}</span></li>)}
        </ul>
        {d.proof[0]?.quote && !proofAbove && (
          <figure class="proof">
            <Quote text={d.proof[0].quote} names={[d.lead.name]} />
            <figcaption><Src kind="page" label="The page says it led" /><Link href={d.proof[0].url}>{d.proof[0].publisher || 'source'}</Link></figcaption>
          </figure>
        )}
        <p class="facts__note">
          {d.written_by ? 'Worded by a language model, then checked: every name and number in it is in the facts above.' : 'Assembled from the facts above without a language model.'}
          {d.dropped.length > 0 && <> A first version was thrown out for adding: {d.dropped.slice(0, 3).join(', ')}.</>}
        </p>
      </section>

      <div class="acts">
        {d.kind !== 'slush' && <Btn kind="main" icon="mail" onClick={gmail}>Open in Gmail</Btn>}
        <Btn kind={d.kind === 'slush' ? 'main' : 'quiet'} icon={state === 'copied' ? 'check' : 'copy'} onClick={copy}>{state === 'copied' ? 'Copied' : 'Copy'}</Btn>
      </div>
      {state === 'failed' && <p class="banner">Select the text above and copy it by hand.</p>}
    </>
  )
}

export function Draft({ data: d }: { data: DraftData }) {
  const { to, kind } = askTitle(d)
  return (
    <div class="card card--draft">
      <Head title={`${kind} to ${to}`} sub={<>About <b>{d.lead.name}</b>. Written only from the facts below. You send it.</>} />
      <DraftBody data={d} />
      <footer class="foot"><span /><Link href={d.url} class="foot__r">Every round and source</Link></footer>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------- the round

const ORDER = ['to_ask', 'asked', 'replied', 'meeting', 'leading', 'passed']

export function Tracker({ data }: { data: TrackerData }) {
  const [d, setD] = useState(data)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [asks, setAsks] = useState<Record<string, DraftData>>({})
  useEffect(() => setD(data), [data])

  const lead = d.leads.find((l) => l.status === 'leading')
  const cur = d.target.currency
  const soft = d.softs.reduce((n, s) => n + (s.amount || 0), 0)
  const total = d.target.amount || 0
  const asked = d.leads.filter((l) => l.status !== 'to_ask' && l.status !== 'passed').length

  const set = async (key: string, name: string, status: string) => {
    setBusy(key)
    setErr(null)
    try {
      const r = await callTool('tracker_set', { tracker: d.tracker, investor: name, status }, 30_000)
      if (r.isError || r.structuredContent?.view !== 'tracker') throw new Error(r.content?.[0]?.text || 'not saved')
      setD(r.structuredContent as TrackerData)
      tell(`In the Soft Yes round tracker ${d.tracker}, ${name} is now marked ${d.labels[status] || status}.`)
      setOpen(null)
    } catch (e) {
      setErr(`Could not save that: ${(e as Error).message}`)
    }
    setBusy(null)
  }
  const draft = async (name: string, via?: string | null) => {
    setBusy(name)
    const got = await writeAsk({ run_id: d.run_id, lead: name, company: d.company, raising: d.stage_name })
    if (got) {
      setAsks((a) => ({ ...a, [name]: got }))
      setBusy(null)
      return
    }
    const sent = await say(`Draft the intro ask ${via ? `to ${via} ` : ''}about ${name} with Soft Yes (run ${d.run_id}), and save it to my drafts.`)
    setBusy(null)
    if (!sent) setErr(`Ask in the chat: “Draft the intro ask about ${name}.”`)
  }

  const stage = d.stage_name ? (d.stage_name === 'Seed' || d.stage_name === 'Pre-seed' ? d.stage_name.toLowerCase() : d.stage_name) : 'round'
  return (
    <div class="card card--track">
      <Head
        title={`${d.company ? `${d.company}’s` : 'Your'} ${stage}`}
        sub={lead
          ? <><b>{lead.name}</b> is leading. {listAnd(d.softs.map((s) => s.name))} said they follow.</>
          : <>{listAnd(d.softs.map((s) => s.name))} said yes once there is a lead. <b>{asked}</b> of {d.leads.length} leads asked.</>}
      />
      <div class={`round${lead ? ' has-lead' : ''}`} role="img" aria-label={lead ? `Lead: ${lead.name}` : 'Lead: still open'}>
        <div class="round__slot round__slot--lead" style={total && soft ? { flex: `${Math.max(total - soft, total * 0.25)} 1 0` } : undefined}>
          <span>Lead</span>
          <b>{lead ? lead.name : 'Open'}</b>
          {total > 0 && <i class="num">{money(Math.max(0, total - soft), cur)}{soft ? ' to fill' : ''}</i>}
        </div>
        {d.softs.map((s) => (
          <div key={s.key} class="round__slot" style={total && s.amount ? { flex: `${s.amount} 1 0` } : undefined}>
            <span>Said yes</span>
            <b>{s.name}</b>
            {s.amount ? <i class="num">{money(s.amount, cur)}</i> : null}
          </div>
        ))}
      </div>

      <ul class="trk">
        {d.leads.map((l) => (
          <li key={l.key} class={`trk__row is-${l.status}${open === l.key ? ' is-open' : ''}`}>
            <button type="button" class="trk__head" onClick={() => setOpen(open === l.key ? null : l.key)} aria-expanded={open === l.key}>
              <span class="trk__name">
                <b>{l.name}</b>
                <span>
                  {l.via ? `through ${l.via}` : 'no door yet'}
                  {l.last_led && <> · latest lead in Cala: {roundName(l.last_led)}</>}
                  {l.new && <em class="new">new</em>}
                </span>
              </span>
              <span class={`st st--${l.status}`}>{d.labels[l.status] || l.status}{l.date && l.status !== 'to_ask' ? <i> {day(l.date)}</i> : null}</span>
            </button>
            {open === l.key && (
              <div class="trk__body">
                <div class="seg seg--wrap" role="radiogroup" aria-label={`Status of ${l.name}`}>
                  {ORDER.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={l.status === s} class={l.status === s ? 'is-on' : ''}
                      disabled={busy === l.key} onClick={() => l.status !== s && set(l.key, l.name, s)}>
                      {d.labels[s] || s}
                    </button>
                  ))}
                </div>
                {l.status === 'to_ask' && !asks[l.name] && <Btn kind="main" icon="mail" busy={busy === l.name} onClick={() => draft(l.name, l.via)}>Draft the ask</Btn>}
                {asks[l.name] && <div class="ask"><DraftBody data={asks[l.name]} onClose={() => setAsks(({ [l.name]: _, ...rest }) => rest)} /></div>}
              </div>
            )}
          </li>
        ))}
      </ul>
      {err && <p class="banner">{err}</p>}
      <footer class="foot">
        <span class="foot__n"><Src kind="cala" /> Each lead’s latest round is read from Cala when this opens.</span>
        <Link href={d.url} class="foot__r">Every round and source</Link>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------- a claim

export function Claim({ data: d }: { data: ClaimData }) {
  const [sent, setSent] = useState<Record<string, 'busy' | 'done' | 'failed'>>({})
  const flag = async (id: string, round: ClaimData['rounds'][0], inv: ClaimData['rounds'][0]['investors'][0]) => {
    setSent((s) => ({ ...s, [id]: 'busy' }))
    try {
      const r = await callTool('flag_claim', { company: d.company, round: [round.stage_name, round.date].filter(Boolean).join(' '), cala: inv.name, page: inv.led_by, quote: inv.quote, url: inv.url }, 30_000)
      setSent((s) => ({ ...s, [id]: r.isError ? 'failed' : 'done' }))
    } catch {
      setSent((s) => ({ ...s, [id]: 'failed' }))
    }
  }
  const none = d.rounds.length === 0
  return (
    <div class="card card--claim">
      <Head
        title={`${d.company}: who led, by the page`}
        sub={none
          ? <>Cala’s graph holds no funding round for {d.company}{d.investors_in_cala ? <>, only {plural(d.investors_in_cala, 'investor')} without their rounds</> : null}.</>
          : <>Each “led” Cala holds for {d.company}, next to the sentence on the page Cala cites for it.</>}
      />
      {!none && (
        <Ledger cells={[
          { kind: 'cala', label: 'Rounds in Cala’s graph', value: <span class="num">{num(d.rounds.length)}</span>, note: 'rounds' },
          { kind: 'page', label: 'Pages Cala cites, read', value: <span class="num">{num(d.pages)}</span>, note: 'pages' },
          { kind: 'page', label: 'Claims that hold', value: <span class="num">{num(d.confirmed)}</span>, note: d.corrected ? <span class="bad">{d.corrected} corrected</span> : 'word for word' },
          { kind: 'model', label: 'From a language model', value: <span class="num">0</span>, note: 'facts' },
        ]} />
      )}
      <ul class="claims">
        {d.rounds.map((r, ri) => (
          <li key={ri} class="claims__round">
            <h2>{[r.stage_name, month(r.date)].filter(Boolean).join(' · ')}{r.amount ? <span class="num"> · {r.amount}</span> : null}</h2>
            {r.investors.length === 0 && <p class="claims__none">Cala names no lead for this round.</p>}
            {r.investors.map((i) => {
              const id = `${ri}:${i.name}`
              const state = ok(i.status) ? 'ok' : wrong(i.status) ? 'wrong' : 'open'
              return (
                <div key={id} class={`claim is-${state}${i.asked ? ' is-asked' : ''}`}>
                  <p class="claim__line">
                    <span class="claim__mark">{state === 'ok' ? <Icon name="check" size={13} /> : state === 'wrong' ? <Icon name="x" size={13} /> : <i class="n__q" />}</span>
                    <span>
                      <Src kind="cala" /> {i.cala_lead ? <>says <b class={state === 'wrong' ? 'struck' : ''}>{i.name}</b> led.</> : <>does not flag <b>{i.name}</b> as lead.</>}{' '}
                      <span class={state === 'ok' ? 'good' : state === 'wrong' ? 'bad' : 'dim'}>
                        {STATUS_WORD[i.status || ''] || 'Not checked'}{state === 'wrong' && i.led_by.length ? `: ${listAnd(i.led_by)}` : ''}.
                      </span>
                    </span>
                  </p>
                  {i.quote && (
                    <figure class="proof">
                      <Quote text={i.quote} names={state === 'wrong' ? i.led_by : [i.name]} struck={state === 'wrong' ? [i.name] : undefined} />
                      <figcaption><Src kind="page" /><Link href={i.url}>{i.publisher || 'source'}</Link></figcaption>
                    </figure>
                  )}
                  {state === 'wrong' && i.cala_lead && (
                    <div class="acts">
                      <Btn icon={sent[id] === 'done' ? 'check' : 'flag'} busy={sent[id] === 'busy'} disabled={sent[id] === 'done'} onClick={() => flag(id, r, i)}>
                        {sent[id] === 'done' ? 'On the list for Cala' : sent[id] === 'failed' ? 'Try again' : 'Send the correction to Cala’s list'}
                      </Btn>
                    </div>
                  )}
                </div>
              )
            })}
            {r.others > 0 && <p class="claims__none">{plural(r.others, 'other investor')} in this round, none flagged as lead.</p>}
          </li>
        ))}
      </ul>
      {none && d.said_on_pages.length > 0 && (
        <section class="facts">
          <h2>What the pages Cala’s search read say about who led</h2>
          {d.said_on_pages.map((q, i) => q.quote ? (
            <figure class="proof" key={i}>
              <Quote text={q.quote} names={d.investor ? [d.investor] : []} />
              <figcaption><Src kind="page" /><Link href={q.url}>{q.publisher || 'source'}</Link></figcaption>
            </figure>
          ) : null)}
        </section>
      )}
      <footer class="foot"><span /><Link href={d.url} class="foot__r">Every claim checked so far</Link></footer>
    </div>
  )
}
