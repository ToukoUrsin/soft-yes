import type { SoftYes, Verdict } from '../lib/api'
import { Deal } from './Deal'
import { plural } from '../lib/format'
import { Icon, Investor } from './ui'
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
        const fixed = s.led_corrected ?? []
        return (
          <article key={s.key} className="verdict">
            <div className="verdict__main">
              <header className="verdict__head">
                <h3 className="truncate"><Investor name={s.name} ids={s.ids} /></h3>
                <span className={tag.cls}>{tag.text}</span>
              </header>
              {s.doubt ? (
                <p className="notice verdict__doubt">
                  <Icon name="alert" size={14} />
                  {s.doubt.text}
                </p>
              ) : (
                <p className="verdict__insight">{s.insight}</p>
              )}
              {s.pulse?.by_year?.length ? (
                <div className="verdict__chart">
                  <YearBars data={s.pulse.by_year} variant="card" label={`${s.name}, rounds per year`} />
                  <p className="verdict__key">
                    <span><i className="ybars__key ybars__key--led" />led</span>
                    <span><i className="ybars__key ybars__key--fol" />joined without leading</span>
                  </p>
                </div>
              ) : null}
              {!!s.reports && (
                <p className="faint verdict__reports">
                  {plural(s.reports, 'round')} here {s.reports === 1 ? 'comes' : 'come'} from reports Cala read, not from its graph.
                </p>
              )}
              {s.usual_leads?.length > 0 && (
                <div className="verdict__block verdict__usualblock">
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
            </div>
            {(lastLed || fixed.length > 0) && (
              <div className="verdict__proof">
                {lastLed && (
                  <div className="verdict__block">
                    <h4>Last round it led</h4>
                    <ul className="deals deals--tight">
                      <Deal round={lastLed} sources={lastLed.sources} check={lastLed.check} who={s.name} stagePage={lastLed.stage_page} />
                    </ul>
                  </div>
                )}
                {fixed.length > 0 && (
                  <div className="verdict__block">
                    <h4>Cala says it led {fixed.length === 1 ? 'this' : `these ${fixed.length}`}. The page names another lead</h4>
                    <ul className="deals deals--tight">
                      {fixed.slice(0, 2).map((r) => (
                        <Deal key={r.id} round={r} sources={r.sources} check={r.check} who={s.name} />
                      ))}
                    </ul>
                    {fixed.length > 2 && <p className="faint">And {plural(fixed.length - 2, 'more round')}, counted as followed.</p>}
                  </div>
                )}
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}
