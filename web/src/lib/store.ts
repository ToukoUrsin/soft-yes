import { useCallback, useEffect, useState } from 'react'
import { api, type Config, type Founder, type Result } from './api'

function read<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = storage?.getItem(key)
    return raw ? ({ ...(fallback as object), ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}

function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: the page works without it */
  }
}

const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage)
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)

// --- the founder's three lines, remembered for drafts

const FOUNDER_KEY = 'softyes:founder'
const EMPTY_FOUNDER: Founder = { company: '', one_liner: '', raising: '' }
const founderListeners = new Set<() => void>()

export function getFounder(): Founder {
  return read(local(), FOUNDER_KEY, EMPTY_FOUNDER)
}

export function setFounder(next: Founder) {
  write(local(), FOUNDER_KEY, next)
  founderListeners.forEach((fn) => fn())
}

export function useFounder(): [Founder, (patch: Partial<Founder>) => void] {
  const [founder, set] = useState<Founder>(getFounder)
  useEffect(() => {
    const fn = () => set(getFounder())
    founderListeners.add(fn)
    return () => void founderListeners.delete(fn)
  }, [])
  const update = useCallback((patch: Partial<Founder>) => setFounder({ ...getFounder(), ...patch }), [])
  return [founder, update]
}

// --- the home form survives a trip to the results and back

export function useSessionState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, set] = useState<T>(() => {
    try {
      const raw = session()?.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const update = useCallback(
    (v: T) => {
      set(v)
      write(session(), key, v)
    },
    [key],
  )
  return [value, update]
}

// --- recent walks

export interface Recent { id: string; names: string[]; stage: string | null; leads: number; at: number }
const RECENT_KEY = 'softyes:recent'

export function recentRuns(): Recent[] {
  return readList<Recent>(RECENT_KEY).filter((r) => r && typeof r.id === 'string' && Array.isArray(r.names))
}

export function rememberRun(result: Result) {
  const entry: Recent = {
    id: result.run_id,
    names: result.input.soft_yeses.map((s) => s.name),
    stage: result.input.stage_name,
    leads: result.leads.length,
    at: Date.now(),
  }
  // The same question asked again is one entry: the newest answer replaces the older one.
  const same = (r: Recent) => r.id === entry.id || (r.stage === entry.stage && r.names.join('|') === entry.names.join('|'))
  write(local(), RECENT_KEY, [entry, ...recentRuns().filter((r) => !same(r))].slice(0, 5))
}

// --- config, fetched once

let configPromise: Promise<Config> | null = null

export function useConfig(): Config | null {
  const [config, set] = useState<Config | null>(null)
  useEffect(() => {
    let live = true
    configPromise ??= api.config()
    configPromise.then(
      (c) => live && set(c),
      () => {
        configPromise = null
      },
    )
    return () => {
      live = false
    }
  }, [])
  return config
}

export function useMedia(query: string): boolean {
  const [match, set] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const fn = () => set(mq.matches)
    fn()
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [query])
  return match
}

/** Fetch something on demand, with the time it has taken so far. */
export function useTask<T>() {
  const [state, set] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data: T | null; error: string | null; seconds: number }>({
    status: 'idle', data: null, error: null, seconds: 0,
  })
  const [ctl, setCtl] = useState<AbortController | null>(null)

  useEffect(() => {
    if (state.status !== 'loading') return
    const t0 = Date.now()
    const id = window.setInterval(() => set((s) => (s.status === 'loading' ? { ...s, seconds: Math.round((Date.now() - t0) / 1000) } : s)), 1000)
    return () => clearInterval(id)
  }, [state.status])

  useEffect(() => () => ctl?.abort(), [ctl])

  const run = useCallback((fn: (signal: AbortSignal) => Promise<T>) => {
    const next = new AbortController()
    setCtl((prev) => {
      prev?.abort()
      return next
    })
    set({ status: 'loading', data: null, error: null, seconds: 0 })
    fn(next.signal).then(
      (data) => !next.signal.aborted && set({ status: 'done', data, error: null, seconds: 0 }),
      (e: Error) => {
        if (e.name === 'AbortError' || next.signal.aborted) return
        set({ status: 'error', data: null, error: e.message || 'Something went wrong.', seconds: 0 })
      },
    )
  }, [])

  const reset = useCallback(() => {
    setCtl((prev) => {
      prev?.abort()
      return null
    })
    set({ status: 'idle', data: null, error: null, seconds: 0 })
  }, [])

  return { ...state, run, reset }
}
