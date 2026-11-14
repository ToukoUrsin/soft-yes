import { useState } from 'react'
import type { YearCount } from '../lib/api'
import { plural } from '../lib/format'

/**
 * Rounds per year, split into led (accent, on the baseline) and followed (neutral, stacked above).
 * `spark` is a row-sized glance; `card` adds year ticks; `full` adds counts, a legend and hover.
 */
export function YearBars({
  data, variant = 'card', label,
}: { data: YearCount[] | null | undefined; variant?: 'spark' | 'card' | 'full'; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const years = data ?? []
  if (!years.length) return null
  const max = Math.max(1, ...years.map((y) => y.joined))
  const H = variant === 'spark' ? 22 : variant === 'card' ? 44 : 112
  const unit = H / max
  const minBar = variant === 'spark' ? 2 : 3
  const summary = `${label}: ${years.map((y) => `${y.year} led ${y.led} of ${y.joined}`).join('; ')}`

  return (
    <figure className={`ybars ybars--${variant}`} aria-label={summary} role="img" onMouseLeave={() => setHover(null)}>
      <div className="ybars__plot" style={{ height: H }}>
        {years.map((y, i) => {
          const led = Math.min(y.led, y.joined)
          const followed = Math.max(0, y.joined - led)
          const ledH = led ? Math.max(minBar, led * unit) : 0
          const folH = followed ? Math.max(minBar, followed * unit) : 0
          const gap = led && followed ? (variant === 'spark' ? 1 : 2) : 0
          const tip = y.joined ? `${y.year}: led ${led} of ${plural(y.joined, 'round')}` : `${y.year}: no rounds in Cala`
          return (
            <div
              key={y.year}
              className={`ybars__col${hover === i ? ' is-hover' : ''}`}
              title={variant === 'spark' ? undefined : tip}
              onMouseEnter={() => variant !== 'spark' && setHover(i)}
            >
              {variant === 'full' && y.joined > 0 && <span className="ybars__n num">{y.joined}</span>}
              {y.joined === 0 ? (
                <i className="ybars__zero" />
              ) : (
                <>
                  {followed > 0 && <i className="ybars__fol" style={{ height: Math.max(1, folH - gap) , marginBottom: gap }} />}
                  {led > 0 && <i className={`ybars__led${followed ? '' : ' is-top'}`} style={{ height: ledH }} />}
                </>
              )}
            </div>
          )
        })}
      </div>
      {variant !== 'spark' && (
        <div className="ybars__axis" aria-hidden="true">
          {years.map((y, i) => (
            <span key={y.year} className={`num${hover === i ? ' is-hover' : ''}`}>
              {variant === 'full' ? y.year : `’${String(y.year).slice(2)}`}
            </span>
          ))}
        </div>
      )}
      {variant === 'full' && (
        <figcaption className="ybars__legend">
          <span><i className="ybars__key ybars__key--led" />Led</span>
          <span><i className="ybars__key ybars__key--fol" />Joined without leading</span>
          <span className="ybars__read num" aria-hidden="true">
            {hover != null && years[hover]
              ? years[hover].joined
                ? `${years[hover].year}: led ${Math.min(years[hover].led, years[hover].joined)} of ${years[hover].joined}`
                : `${years[hover].year}: none in Cala`
              : 'By the date each round was first reported'}
          </span>
        </figcaption>
      )}
    </figure>
  )
}
