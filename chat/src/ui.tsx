import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { openLink } from './bridge'
import { reduced, spellings } from './lib'

const PATHS: Record<string, string> = {
  // where a fact comes from
  cala: 'M8 2.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM3.5 10a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM12.5 10a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM7 6.3 4.4 10.2M9 6.3l2.6 3.9',
  page: 'M4 2.5h5.5L12.5 5.5v8H4zM9.5 2.5v3h3M6 8.5h4.5M6 11h3',
  inbox: 'M2.5 4h11v8.5h-11zM2.5 4.5 8 9l5.5-4.5',
  model: 'M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M4.2 11.8l1.4-1.4M10.4 5.6l1.4-1.4',
  typed: 'M3 4.5h10v7H3zM5.5 7h.01M8 7h.01M10.5 7h.01M5.5 9.3h5',
  // marks
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  x: 'M4 4l8 8M12 4l-8 8',
  out: 'M6 3.5h6.5V10M12.5 3.5 4 12',
  expand: 'M9.5 3h3.5v3.5M6.5 13H3V9.5M13 3 9 7M3 13l4-4',
  replay: 'M3.2 8a4.8 4.8 0 1 1 1.5 3.5M3 12.5V9.5h3',
  right: 'M6 3.5 10.5 8 6 12.5',
  down: 'M3.5 6 8 10.5 12.5 6',
  back: 'M10 3.5 5.5 8 10 12.5',
  door: 'M4.5 13.5v-11h7v11M3 13.5h10M9 8h.01',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  mail: 'M2.5 4h11v8.5h-11zM2.5 4.5 8 9l5.5-4.5',
  flag: 'M4 13.5v-11M4 3h7.5l-1.5 2.5L11.5 8H4',
  dot: 'M8 8h.01',
  hop: 'M3 8h7M7.5 5 10.5 8l-3 3M13 3.5v9',
  net: 'M4 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5.4 3.7l5.2 2.6M5.4 12.3l5.2-4.6',
}

export function Icon({ name, size = 16, class: cls }: { name: string; size?: number; class?: string }) {
  return (
    <svg class={`ic${cls ? ` ${cls}` : ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.dot} />
    </svg>
  )
}

/** The mark of where a fact comes from. Cala's is the one filled in: it is the ground everything stands on. */
export function Src({ kind, label }: { kind: 'cala' | 'page' | 'inbox' | 'typed' | 'model'; label?: string }) {
  const word = label ?? { cala: 'Cala', page: 'Page Cala cites', inbox: 'Your inbox', typed: 'You', model: 'Language model' }[kind]
  return (
    <span class={`src src--${kind}`}>
      <Icon name={kind} size={12} />
      {word}
    </span>
  )
}

export function Mark() {
  return (
    <span class="mark" aria-label="Soft Yes">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="4" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3" />
        <circle cx="10" cy="7" r="2.6" fill="currentColor" />
      </svg>
      Soft Yes
    </span>
  )
}

export function Link({ href, children, class: cls }: { href?: string | null; children: ComponentChildren; class?: string }) {
  if (!href) return <span class={cls}>{children}</span>
  return (
    <a class={`lnk${cls ? ` ${cls}` : ''}`} href={href} target="_blank" rel="noopener noreferrer"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLink(href) }}>
      {children}
      <Icon name="out" size={11} />
    </a>
  )
}

/** A sentence from a page: the lead's name marked, a name the page does not bear out struck, another name underlined. */
export function Quote({ text, names, struck, also }: { text: string; names: string[]; struck?: string[]; also?: string[] }) {
  const low = text.toLowerCase()
  const find = (ns?: string[]): [number, number] | null => {
    for (const n of ns || []) for (const sp of spellings(n)) {
      const at = low.indexOf(sp.toLowerCase())
      if (at >= 0) return [at, at + sp.length]
    }
    return null
  }
  const hits = ([[find(names), 'mark'], [find(struck), 's'], [find(also), 'u']] as [[number, number] | null, string][])
    .filter((h): h is [[number, number], string] => !!h[0]).sort((a, b) => a[0][0] - b[0][0])
  const out: ComponentChildren[] = []
  let at = 0
  for (const [[from, to], tag] of hits) {
    if (from < at) continue
    out.push(text.slice(at, from))
    const word = text.slice(from, to)
    out.push(tag === 'mark' ? <mark>{word}</mark> : tag === 's' ? <s>{word}</s> : <u>{word}</u>)
    at = to
  }
  out.push(text.slice(at))
  return <blockquote class="q">{out}</blockquote>
}

export function Btn({ children, onClick, kind = 'quiet', icon, busy, disabled, title }: {
  children: ComponentChildren; onClick: () => void; kind?: 'main' | 'quiet' | 'bare'; icon?: string; busy?: boolean; disabled?: boolean; title?: string
}) {
  return (
    <button type="button" class={`btn btn--${kind}${busy ? ' is-busy' : ''}`} onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={disabled || busy} title={title} aria-busy={busy || undefined}>
      {icon && <Icon name={icon} size={14} />}
      <span>{children}</span>
    </button>
  )
}

export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div class="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={o.id === value} class={o.id === value ? 'is-on' : ''}
          onClick={() => onChange(o.id)}>
          {o.label}
          {o.count != null && <i class="num">{o.count}</i>}
        </button>
      ))}
    </div>
  )
}

/** A number that counts up to its value when `run` turns true. */
export function Count({ to, run, ms = 900 }: { to: number; run: boolean; ms?: number }) {
  const [n, set] = useState(run && reduced() ? to : 0)
  const from = useRef(0)
  useEffect(() => {
    if (!run) { set(0); from.current = 0; return }
    if (reduced()) { set(to); return }
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      const v = Math.round(a + (to - a) * eased)
      set(v)
      if (k < 1) raf = requestAnimationFrame(tick)
      else from.current = to
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to, run, ms])
  return <span class="num">{n.toLocaleString('en')}</span>
}

/** The strip that says where the card's facts come from. The language model's cell always reads 0. */
export function Ledger({ cells }: { cells: { kind: 'cala' | 'page' | 'inbox' | 'typed' | 'model'; label: string; value: ComponentChildren; note?: ComponentChildren }[] }) {
  return (
    <dl class={`ledger ledger--${cells.length}`}>
      {cells.map((c) => (
        <div key={c.label} class={`ledger__cell ledger__cell--${c.kind}`}>
          <dt><Icon name={c.kind} size={13} />{c.label}</dt>
          <dd>
            <b>{c.value}</b>
            {c.note && <span>{c.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Head({ title, sub, right }: { title: ComponentChildren; sub?: ComponentChildren; right?: ComponentChildren }) {
  return (
    <header class="head">
      <div class="head__top">
        <Mark />
        {right && <div class="head__right">{right}</div>}
      </div>
      <h1>{title}</h1>
      {sub && <p class="head__sub">{sub}</p>}
    </header>
  )
}

export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, set] = useState(0)
  const obs = useRef<ResizeObserver | null>(null)
  const ref = (el: T | null) => {
    obs.current?.disconnect()
    if (!el) return
    set(el.clientWidth)
    obs.current = new ResizeObserver(() => set(el.clientWidth))
    obs.current.observe(el)
  }
  return [useRef(ref).current, w]
}
