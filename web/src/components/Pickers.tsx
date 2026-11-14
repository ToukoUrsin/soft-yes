import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, type Suggestion } from '../lib/api'
import { plural } from '../lib/format'
import { Icon } from './ui'

interface SuggestState {
  items: Suggestion[]
  source: 'index' | 'cala' | 'none'
  loading: boolean
  error: string | null
  /** the query the items answer */
  for: string
}

const EMPTY: SuggestState = { items: [], source: 'none', loading: false, error: null, for: '' }

/** Debounced (250 ms), 2+ characters, stale requests aborted. */
function useSuggest(query: string): SuggestState {
  const [state, setState] = useState<SuggestState>(EMPTY)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setState(EMPTY)
      return
    }
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    const timer = window.setTimeout(() => {
      api.suggest(q, ctl.signal).then(
        (r) => setState({ items: r.items, source: r.source, loading: false, error: null, for: q }),
        (e: Error) => {
          if (e.name === 'AbortError') return
          setState({ items: [], source: 'none', loading: false, error: e.message, for: q })
        },
      )
    }, 250)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [query])
  return state
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

function typeLabel(s: Suggestion): string {
  if (s.type === 'Person' || s.kind === 'person') return 'Person'
  if (s.known_rounds > 0) return 'Investor'
  return s.type === 'Company' ? 'Company' : 'Organisation'
}

function roundsLabel(s: Suggestion): string {
  return s.known_rounds > 0 ? `${plural(s.known_rounds, 'round')} in Cala` : 'No rounds in Cala yet'
}

/** One line a screen reader or an agent can tell two similar names apart by. */
function optionLabel(s: Suggestion, off: boolean | undefined): string {
  return [s.name, s.did_you_mean ? 'closest name in Cala' : typeLabel(s), off ? 'already added' : roundsLabel(s), s.description]
    .filter(Boolean)
    .join(', ')
}

interface ListProps {
  id: string
  state: SuggestState
  query: string
  active: number
  setActive: (i: number) => void
  onPick: (s: Suggestion) => void
  disabledKeys?: Set<string>
  emptyHint: string
}

function SuggestList({ id, state, query, active, setActive, onPick, disabledKeys, emptyHint }: ListProps) {
  const q = query.trim()
  const fresh = state.for === q
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div className="pop" role="presentation" onMouseDown={(e) => e.preventDefault()}>
      {state.loading && <i className="pop__bar" aria-hidden="true" />}
      {state.error ? (
        <p className="pop__msg pop__msg--error">{state.error}</p>
      ) : state.items.length ? (
        <ul className="pop__list" role="listbox" id={id} ref={listRef}>
          {state.items.map((s, i) => {
            const off = disabledKeys?.has(s.key)
            return (
              <li
                key={s.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === Math.max(active, 0)}
                aria-disabled={off || undefined}
                aria-label={optionLabel(s, off)}
                className={`opt${active < 0 && i === 0 ? ' opt--top' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => !off && onPick(s)}
              >
                <span className="opt__main">
                  <span className="opt__name truncate"><Highlight text={s.name} q={q} /></span>
                  <span className="opt__type">{s.did_you_mean ? 'Closest name in Cala' : typeLabel(s)}</span>
                </span>
                <span className={`opt__side num${!off && !s.known_rounds ? ' opt__side--none' : ''}`}>
                  {off ? 'Added' : roundsLabel(s)}
                  {active < 0 && i === 0 && !off && <kbd className="kbd opt__enter">Enter</kbd>}
                </span>
                {s.description && <span className="opt__desc truncate">{s.description}</span>}
              </li>
            )
          })}
        </ul>
      ) : fresh && !state.loading ? (
        <p className="pop__msg">Nothing in Cala matches “{q}”. {emptyHint}</p>
      ) : (
        <div className="pop__skel" aria-label="Searching">
          <i className="skel" style={{ width: '46%' }} />
          <i className="skel" style={{ width: '62%' }} />
          <i className="skel" style={{ width: '38%' }} />
        </div>
      )}
      {state.items.length > 0 && (
        <p className="pop__foot">
          <span>{state.source === 'cala' ? 'Searched Cala' : 'From what Cala has already returned'}</span>
          <span className="pop__keys"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move <kbd className="kbd">Enter</kbd> add</span>
        </p>
      )}
    </div>
  )
}

/**
 * Nothing is chosen until an arrow key is pressed: the first Down lands on the first row, and Enter on its own takes
 * the first row too. So "type, Down, Enter" and "type, Enter" both give the top match, never the second.
 */
function useListNav(count: number, open: boolean, key: string) {
  const [active, setActive] = useState(-1)
  useEffect(() => setActive(-1), [count, open, key])
  const onKey = (e: KeyboardEvent): boolean => {
    if (!open || !count) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % count); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? count - 1 : a - 1)); return true }
    return false
  }
  return { active, setActive, onKey }
}

/**
 * Enter pressed while the list still answers an older query ("EI" on screen, "EIC" typed) must not take a row from
 * the old list. It waits for the answer to what is typed and takes the top match then.
 */
function useEnter(state: SuggestState, q: string, active: number, pick: (s: Suggestion) => void) {
  const [waiting, setWaiting] = useState(false)
  const fresh = state.for === q.trim() && !state.loading
  useEffect(() => {
    if (!waiting) return
    if (!q.trim()) setWaiting(false)
    else if (fresh) {
      setWaiting(false)
      if (state.items[0]) pick(state.items[0])
    }
    // pick is recreated every render; only the answer arriving matters here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, fresh, q])
  return () => {
    if (!fresh) setWaiting(true)
    else if (state.items[Math.max(active, 0)]) pick(state.items[Math.max(active, 0)])
  }
}

// ----------------------------------------------------------------------------------- token field

export interface Token { key: string; name: string; ids: string[]; kind: 'fund' | 'person' }

export function TokenField({
  tokens, onChange, placeholder, label, autoFocus, max = 6, footer,
}: {
  tokens: Token[]
  onChange: (t: Token[]) => void
  placeholder: string
  label: string
  autoFocus?: boolean
  max?: number
  footer?: ReactNode
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const state = useSuggest(q)
  const open = focus && q.trim().length >= 2
  const { active, setActive, onKey } = useListNav(state.items.length, open, state.for)
  const taken = new Set(tokens.map((t) => t.key))
  const full = tokens.length >= max

  const add = (s: Suggestion) => {
    if (taken.has(s.key) || full) return
    onChange([...tokens, { key: s.key, name: s.name, ids: s.ids, kind: s.kind }])
    setQ('')
    input.current?.focus()
  }
  const enter = useEnter(state, q, active, add)

  return (
    <div className="picker">
      <div className={`tokens${focus ? ' is-focus' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus() } }}>
        {tokens.map((t) => (
          <span key={t.key} className="token">
            <i className="token__ring" aria-hidden="true" />
            <span className="truncate" title={t.name}>{t.name}</span>
            <button type="button" aria-label={`Remove ${t.name}`} onClick={() => { onChange(tokens.filter((x) => x.key !== t.key)); input.current?.focus() }}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          name="investor"
          className="tokens__input"
          value={q}
          autoFocus={autoFocus}
          disabled={full}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          placeholder={full ? `${max} is the most one walk takes` : tokens.length ? 'Add another' : placeholder}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={open && state.items.length ? `${id}-${Math.max(active, 0)}` : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onKeyDown={(e) => {
            if (onKey(e)) return
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              if (open) { e.preventDefault(); enter() }
            } else if (e.key === 'Escape' && q) {
              e.preventDefault(); e.stopPropagation(); setQ('')
            } else if (e.key === 'Backspace' && !q && tokens.length) {
              onChange(tokens.slice(0, -1))
            }
          }}
        />
      </div>
      {open && (
        <SuggestList id={id} state={state} query={q} active={active} setActive={setActive} onPick={add} disabledKeys={taken}
          emptyHint="Try the fund's full name." />
      )}
      {footer}
    </div>
  )
}

// ---------------------------------------------------------------------------------- single field

export function SingleField({
  onPick, placeholder, label, autoFocus, large, emptyHint,
}: {
  onPick: (s: Suggestion) => void
  placeholder: string
  label: string
  autoFocus?: boolean
  large?: boolean
  emptyHint: string
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState(false)
  const state = useSuggest(q)
  const open = focus && q.trim().length >= 2
  const { active, setActive, onKey } = useListNav(state.items.length, open, state.for)
  const pick = (s: Suggestion) => { setQ(''); onPick(s) }
  const enter = useEnter(state, q, active, pick)
  return (
    <div className="picker">
      <input
        name="search"
        className={`input${large ? ' input--lg' : ''}`}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={placeholder}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-autocomplete="list"
        aria-activedescendant={open && state.items.length ? `${id}-${Math.max(active, 0)}` : undefined}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onKeyDown={(e) => {
          if (onKey(e)) return
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && open) { e.preventDefault(); enter() }
          else if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ('') }
        }}
      />
      {open && <SuggestList id={id} state={state} query={q} active={active} setActive={setActive} onPick={pick} emptyHint={emptyHint} />}
    </div>
  )
}
