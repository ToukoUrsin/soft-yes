import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { investorHref, type Result, type Source } from '../lib/api'
import { fmtDate, host, listAnd } from '../lib/format'

// ------------------------------------------------------------------------------------------- icons
// One family: 16px box, 1.5px stroke, round joins.

type IconName = 'arrow' | 'out' | 'copy' | 'check' | 'x' | 'link' | 'download' | 'replay' | 'skip' | 'chevron' | 'plus' | 'alert' | 'enter' | 'shuffle' | 'page'

const PATHS: Record<IconName, ReactNode> = {
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  out: <path d="M5 11l6-6M6 5h5v5" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  check: <path d="M3.5 8.5l3 3 6-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  link: (
    <>
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7" />
      <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.7-.7" />
    </>
  ),
  download: <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
  replay: (
    <>
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <path d="M3 2.8v3h3" />
    </>
  ),
  skip: <path d="M3.5 4l4 4-4 4M8.5 4l4 4-4 4" />,
  chevron: <path d="M4 6l4 4 4-4" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  alert: (
    <>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 6.5v3M8 11.3v.2" />
    </>
  ),
  enter: <path d="M12.5 3.5v4a2 2 0 0 1-2 2h-7M6 6.5l-3 3 3 3" />,
  shuffle: (
    <>
      <path d="M2.5 11h2.1c1.2 0 2.3-.7 2.9-1.7l1-1.6C9.1 6.7 10.2 6 11.4 6h2.1M11.8 4.3l1.7 1.7-1.7 1.7" />
      <path d="M2.5 5h2.1c1 0 1.9.4 2.5 1.2M9.4 9.8c.6.8 1.5 1.2 2.5 1.2h1.6M11.8 9.3l1.7 1.7-1.7 1.7" />
    </>
  ),
  page: (
    <>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M6.2 7.5h3.6M6.2 10h3.6" />
    </>
  ),
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

/** The mark is the product: a soft yes (open ring) walked to a lead (solid). */
export function Mark({ size = 22 }: { size?: number }) {
  const h = (size * 12) / 22
  return (
    <svg width={size} height={h} viewBox="0 0 22 12" fill="none" aria-hidden="true">
      <circle cx="5" cy="6" r="3.75" stroke="var(--text)" strokeWidth="1.5" />
      <path d="M9.5 6h4" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="17.5" cy="6" r="4.5" fill="var(--accent)" />
    </svg>
  )
}

// ------------------------------------------------------------------------------------------ sources

export function Sources({ sources, max = 3 }: { sources: Source[] | null | undefined; max?: number }) {
  const [open, setOpen] = useState(false)
  const list = useMemo(() => {
    const seen = new Set<string>()
    const unique = (sources ?? []).filter((s) => s?.url && !seen.has(s.url) && seen.add(s.url))
    // Different publishers first: three chips from one site say less than three sites.
    const hosts = new Set<string>()
    const first: Source[] = []
    const again: Source[] = []
    for (const s of unique) {
      const h = host(s.url)
      if (hosts.has(h)) again.push(s)
      else {
        hosts.add(h)
        first.push(s)
      }
    }
    // Pages cited for a fact on this row come before pages that are only about the round.
    const cited = (s: Source) => (s.backs ? s.backs.length > 0 : true)
    const all = [...first, ...again]
    return [...all.filter(cited), ...all.filter((s) => !cited(s))]
  }, [sources])
  if (!list.length) return null
  const backing = list.filter((s) => !s.backs || s.backs.length > 0).length
  const cut = backing ? Math.min(max, backing) : max
  const shown = open ? list : list.slice(0, cut)
  return (
    <span className="sources">
      {shown.map((s) => {
        const name = (s.publisher || host(s.url)).replace(/^www\./, '')
        const when = fmtDate(s.date)
        const primary = s.rank === 'PRIMARY'
        const backs = s.backs ?? []
        const says = s.backs ? (backs.length ? `Cited for the ${listAnd(backs)}.` : 'About this round, but not cited for a fact shown here.') : ''
        return (
          <a
            key={s.url}
            className={`src${s.backs && !backs.length ? ' src--loose' : ''}`}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`${primary ? 'Primary source. ' : ''}${name}${when ? `, ${when}` : ''}${says ? `\n${says}` : ''}\n${s.url}`}
          >
            {primary && <i className="src__primary" aria-label="primary source" />}
            <span>{name}</span>
            {backs.length > 0 && <em className="src__backs">{backs.join(' · ')}</em>}
            <Icon name="out" size={11} />
          </a>
        )
      })}
      {!open && list.length > cut && (
        <button
          type="button"
          className="src src--more"
          onClick={() => setOpen(true)}
          title={backing && backing <= cut ? 'Other pages about this round' : 'Show every source'}
        >
          +{list.length - cut}
        </button>
      )}
    </span>
  )
}

// ------------------------------------------------------------------------------------- copy button

export function useCopy(): [boolean, (text: string) => void] {
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const copy = (text: string) => {
    const ok = () => {
      setDone(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setDone(false), 1600)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text) && ok())
    } else if (fallbackCopy(text)) ok()
  }
  return [done, copy]
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

export function CopyButton({
  text, label, done = 'Copied', icon = 'copy', className = 'btn',
}: { text: string | (() => string); label: string; done?: string; icon?: 'copy' | 'link'; className?: string }) {
  const [copied, copy] = useCopy()
  return (
    <button type="button" className={className} onClick={() => copy(typeof text === 'function' ? text() : text)} aria-live="polite">
      <Icon name={copied ? 'check' : icon} size={14} />
      {copied ? done : label}
    </button>
  )
}

// --------------------------------------------------------------------------------------- segmented

export function Segmented<T extends string>({
  options, value, onChange, label, role = 'radiogroup',
}: {
  options: { id: T; name: string }[]
  value: T
  onChange: (id: T) => void
  label: string
  role?: 'radiogroup' | 'tablist'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const move = (dir: number) => {
    const i = options.findIndex((o) => o.id === value)
    const next = options[(i + dir + options.length) % options.length]
    onChange(next.id)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)?.focus())
  }
  const tab = role === 'tablist'
  // A row too long for its box scrolls sideways: mark which side has more, so the edge can fade instead of cutting a word.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mark = () => {
      const more = el.scrollWidth - el.clientWidth
      el.dataset.more = more <= 1 ? '' : `${el.scrollLeft > 1 ? 'l' : ''}${el.scrollLeft < more - 1 ? 'r' : ''}`
    }
    mark()
    el.addEventListener('scroll', mark, { passive: true })
    const ro = new ResizeObserver(mark)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', mark)
      ro.disconnect()
    }
  }, [])
  useEffect(() => {
    const el = ref.current
    const on = el?.querySelector<HTMLElement>(`[data-id="${value}"]`)
    if (!el || !on || el.scrollWidth - el.clientWidth <= 1) return
    const box = el.getBoundingClientRect()
    const b = on.getBoundingClientRect()
    const pad = 48
    if (b.left < box.left + pad) el.scrollBy({ left: b.left - box.left - pad, behavior: 'smooth' })
    else if (b.right > box.right - pad) el.scrollBy({ left: b.right - box.right + pad, behavior: 'smooth' })
  }, [value])
  return (
    <div
      ref={ref}
      className="seg"
      role={role}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1) }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1) }
      }}
    >
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            data-id={o.id}
            role={tab ? 'tab' : 'radio'}
            {...(tab ? { 'aria-selected': on } : { 'aria-checked': on })}
            tabIndex={on ? 0 : -1}
            className="seg__opt"
            onClick={() => onChange(o.id)}
          >
            {o.name}
          </button>
        )
      })}
    </div>
  )
}

/** The count beside a heading. The space is a real character, so it survives flex headings and reads "Who could lead 20". */
export function N({ children }: { children: ReactNode }) {
  return (
    <>
      {'\u00A0'}
      <span className="count num">{children}</span>
    </>
  )
}

// ----------------------------------------------------------------------------------- counting number

export function Count({ value }: { value: number | null }) {
  const [shown, setShown] = useState(value ?? 0)
  const from = useRef(value ?? 0)
  useEffect(() => {
    if (value == null) return
    const start = from.current
    if (start === value) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value
      setShown(value)
      return
    }
    const t0 = performance.now()
    const dur = Math.min(420, 120 + Math.abs(value - start) * 6)
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur)
      const v = Math.round(start + (value - start) * (1 - Math.pow(1 - p, 3)))
      from.current = v
      setShown(v)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{value == null ? '…' : shown}</>
}

// --------------------------------------------------------------------------- investor names as links

type NameIndex = Map<string, string[]>
const Names = createContext<NameIndex>(new Map())
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9åäöüéèñøæ]/g, '')

export function NamesProvider({ result, children }: { result: Result | null; children: ReactNode }) {
  const index = useMemo(() => {
    const m: NameIndex = new Map()
    if (result) {
      for (const s of result.soft_yeses) if (s.ids?.length) m.set(norm(s.name), s.ids)
      for (const l of [...result.leads, ...result.second_ring]) if (l.ids?.length) m.set(norm(l.name), l.ids)
    }
    return m
  }, [result])
  return <Names.Provider value={index}>{children}</Names.Provider>
}

/** An investor's name. A link to its investor check wherever Cala gave us its id. */
export function Investor({ name, ids, className }: { name: string; ids?: string[]; className?: string }) {
  const index = useContext(Names)
  const found = ids?.length ? ids : index.get(norm(name))
  if (!found?.length) return <span className={className} title={name}>{name}</span>
  return (
    <Link href={investorHref(found, name)} className={`name-link${className ? ` ${className}` : ''}`} title={`${name}: does it lead or follow?`}>
      {name}
    </Link>
  )
}

export function InvestorList({ names, conj = 'and' }: { names: string[]; conj?: 'and' | 'or' }) {
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && (i === names.length - 1 ? ` ${conj} ` : ', ')}
          <Investor name={n} />
        </span>
      ))}
    </>
  )
}
