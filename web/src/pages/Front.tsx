import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { CopyButton } from '../components/ui'
import { useConfig } from '../lib/store'

// The first page is the product as it runs in Claude: the two questions, and the card each one draws.
// The card is the connector's own (served through /chat), fed by the same stored answers Claude gets.
const ASKS = [
  {
    id: 'find',
    tab: 'Which investors fit us?',
    sub: 'Pre-seed, AI, Europe',
    say: 'We’re building in artificial intelligence in Europe and raising a pre-seed round. Use Soft Yes to find the investors who fit, and who Cala AI’s investors could introduce us to.',
    tool: 'find_investors',
    args: { sector: 'artificial intelligence', stage: 'pre-seed', place: 'Europe', company: 'Cala AI' },
  },
  {
    id: 'lead',
    tab: 'Who could lead our round?',
    sub: 'Tesi and Innovestor said yes',
    say: 'Tesi and Innovestor said they’re in once we have a lead. Use Soft Yes to find who could lead our Series A.',
    tool: 'find_lead',
    args: { investors: ['Tesi', 'Innovestor'], stage: 'Series A' },
  },
]

export function Front() {
  const config = useConfig()
  const [at, setAt] = useState(0)
  const [height, setHeight] = useState(620)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    document.title = 'Soft Yes'
  }, [])
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return
      if (e.data?.softyes === 'height' && e.data.height > 0) setHeight(Math.ceil(e.data.height))
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  const ask = ASKS[at]
  const mcp = config?.mcp || `${location.origin}/mcp`
  const src = `/chat?embed=1&theme=dark&tool=${ask.tool}&args=${encodeURIComponent(JSON.stringify(ask.args))}`
  // next to the headline on a wide screen, under the card on a phone
  const add = (cls: string) => (
    <aside className={cls} aria-label="Add Soft Yes to Claude">
      <h2>Add it to your Claude</h2>
      <div className="copyfield">
        <code className="truncate" title={mcp}>{mcp}</code>
        <CopyButton text={mcp} label="Copy" className="btn btn--ghost btn--sm" />
      </div>
      <p>In Claude: Customize, Connectors, Add custom connector. No sign-in.</p>
    </aside>
  )
  return (
    <main className="page front">
      <section className="front__top">
        <div>
          <h1>Find your investors in Cala’s graph, in Claude.</h1>
          <p className="front__lede">
            Say what you build and what you’re raising. Soft Yes reads Cala’s graph for companies like yours, their rounds and what
            Cala has on each investor. Before it says a fund led a round, it opens the page Cala cites and checks.
          </p>
        </div>
        {add('front__add front__add--top')}
      </section>

      <div className="front__tabs" role="tablist" aria-label="Two questions to try">
        {ASKS.map((a, i) => (
          <button key={a.id} type="button" role="tab" aria-selected={i === at} className="front__tab" onClick={() => setAt(i)}>
            <b>{a.tab}</b>
            <span>{a.sub}</span>
          </button>
        ))}
      </div>
      <div className="front__say">
        <p>
          <span>Asked in Claude</span>
          {ask.say}
        </p>
        <CopyButton text={ask.say} label="Copy" className="btn btn--ghost btn--sm" />
      </div>
      <iframe key={ask.id} ref={frame} className="front__card" title={`Soft Yes: ${ask.tab}`} src={src} style={{ height }} />

      {add('front__add front__add--below')}
      <p className="front__more">
        <a className="link" href="/film.mp4">Watch the film (69 s)</a>
        <Link className="link" href="/find">Start from your own company</Link>
        <Link className="link" href="/audit">Every “led” we checked</Link>
      </p>
    </main>
  )
}
