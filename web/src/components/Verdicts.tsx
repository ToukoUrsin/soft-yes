import type { SoftYes, Verdict } from '../lib/api'
import { Deal } from './Deal'
import { Investor } from './ui'
import { YearBars } from './YearBars'

const TAG: Record<Verdict, { text: string; cls: string }> = {
  follows: { text: 'Follows', cls: 'tag' },
  mixed: { text: 'Leads sometimes', cls: 'tag' },
  leads: { text: 'Leads', cls: 'tag tag--accent' },
  thin: { text: 'Thin record', cls: 'tag tag--warn' },
  unknown: { text: 'No rounds in Cala', cls: 'tag tag--warn' },
}

/** Each soft yes, counted: does it follow by habit, or could it lead? */
export function Verdicts({ softs }: { softs: SoftYes[] }) {
  return (
    <section className="verdicts" aria-label="Do your soft yeses lead or follow?">
      {softs.map((s) => {
        const tag = TAG[s.verdict] ?? TAG.unknown
        const lastLed = s.led_rounds?.[0]
        return (
          <article key={s.key} className="verdict">
            <header className="verdict__head">
              <h3 className="truncate"><Investor name={s.name} ids={s.ids} /></h3>
              <span className={tag.cls}>{tag.text}</span>
            </header>
            <p className="verdict__insight">{s.insight}</p>
            {s.pulse?.by_year?.length ? (
              <div className="verdict__chart">
                <YearBars data={s.pulse.by_year} variant="card" label={`${s.name}, rounds per year`} />
                <p className="verdict__key">
                  <span><i className="ybars__key ybars__key--led" />led</span>
                  <span><i className="ybars__key ybars__key--fol" />joined without leading</span>
                </p>
              </div>
            ) : null}
            {lastLed && (
              <div className="verdict__block">
                <h4>Last round it led</h4>
                <ul className="deals deals--tight">
                  <Deal round={lastLed} sources={lastLed.sources} />
                </ul>
              </div>
            )}
            {s.usual_leads?.length > 0 && (
              <div className="verdict__block">
                <h4>Who led when it followed</h4>
                <p className="verdict__usual">
                  {s.usual_leads.map((u, i) => (
                    <span key={u.name}>
                      {i > 0 && <span className="sep">, </span>}
                      <Investor name={u.name} />
                      {u.deals > 1 && <span className="num faint"> ×{u.deals}</span>}
                    </span>
                  ))}
                </p>
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}
