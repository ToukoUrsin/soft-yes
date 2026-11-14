// The walk: events from POST /api/walk (or rebuilt from a stored result), played at a steady pace
// into a small graph model. One code path for a live walk, a replay and a finished permalink.

import { useSyncExternalStore } from 'react'
import type { Kind, Relation, Result, RoundBrief, SoftInput, StageId, Via } from './api'
import { fmtMonth, listAnd, plural } from './format'

interface Tally { cala_calls?: number; fresh?: number; cached?: number }

export type WalkEvent =
  | { t: 'start'; soft_yeses: { key: string; name: string }[] }
  | ({ t: 'investor'; key: string; name: string; rounds: number; led: number; followed: number; walking: number } & Tally)
  | ({ t: 'round'; soft: string; round: RoundBrief; leads: { key: string; name: string; kind: Kind }[]; others: number; via?: 'round' | 'cap_table' | 'knowledge' } & Tally)
  // The graph walk is in hand; investors with few rounds are now read again through Cala's knowledge search.
  | { t: 'partial'; run_id: string; result: Result; reading: string[] }
  | ({ t: 'knowledge'; soft: string; name: string; state: 'asking' | 'done'; rows?: number; dropped?: number } & Tally)
  | ({ t: 'captable'; soft: string; name: string; companies: number } & Tally)
  | { t: 'leads'; count: number; top: { key: string; name: string }[] }
  | ({ t: 'pulse'; key: string; name: string; rounds: number; led: number } & Tally)
  | ({ t: 'verify'; key: string; round: RoundBrief } & Tally)
  | { t: 'note'; text: string }
  | ({ t: 'ledger' } & Tally)
  | { t: 'done'; run_id: string; result: Result }
  | { t: 'error'; message: string }

export interface GSoft {
  key: string
  name: string
  read: boolean
  rounds: number | null
  led: number | null
  followed: number | null
  walking: number | null
  capped: boolean
}

export interface GRound {
  id: string
  brief: RoundBrief
  softs: string[]
  leads: string[]
  seq: number
  via?: Via
  relation?: Relation
}

export interface GLead {
  key: string
  name: string
  kind: Kind
  rounds: string[]
  seq: number
  pulse: { rounds: number; led: number; capped: boolean } | null
  lastLed: string | null
  rank: number | null
}

export interface GraphModel {
  softs: GSoft[]
  rounds: GRound[]
  leads: GLead[]
  /** true once the walk is finished and leads carry their rank */
  settled: boolean
}

export interface Counters {
  calls: number
  facts: number
  sources: number | null
  fresh: number
  cached: number
}

export interface WalkInputs {
  soft_yeses: SoftInput[]
  stage: StageId | null
  company: { id: string; name: string } | null
}

export type Phase = 'idle' | 'walking' | 'done' | 'error'

export interface WalkState {
  phase: Phase
  mode: 'live' | 'replay' | 'static'
  model: GraphModel
  narration: string
  detail: string
  counters: Counters
  notes: string[]
  result: Result | null
  runId: string | null
  error: string | null
  inputs: WalkInputs | null
  /** set while the second pass (Cala's knowledge search) is still reading; the first result is already shown */
  deep: { reading: string[]; line: string; added: number } | null
  /** how many walks have started; lets views reset per walk */
  generation: number
}

const emptyModel = (): GraphModel => ({ softs: [], rounds: [], leads: [], settled: false })

const initial: WalkState = {
  phase: 'idle',
  mode: 'static',
  model: emptyModel(),
  narration: '',
  detail: '',
  counters: { calls: 0, facts: 0, sources: null, fresh: 0, cached: 0 },
  notes: [],
  result: null,
  runId: null,
  error: null,
  inputs: null,
  deep: null,
  generation: 0,
}

// ------------------------------------------------------------------------------------------- reducer

function roundPhrase(r: RoundBrief): string {
  const who = r.issuer?.name ?? 'A company'
  const stage = r.stage && r.stage_name ? r.stage_name : 'round'
  return `${who}, ${stage.toLowerCase().replace(/series ([a-z])/, (_, c: string) => `Series ${c.toUpperCase()}`)}`
}

function tally(c: Counters, e: Tally): Counters {
  if (e.cala_calls == null) return c
  return { ...c, calls: Math.max(c.calls, e.cala_calls), fresh: e.fresh ?? c.fresh, cached: e.cached ?? c.cached }
}

/** Apply one event. Pure: returns the next slice of state. */
export function applyEvent(s: WalkState, e: WalkEvent): WalkState {
  const m = s.model
  switch (e.t) {
    case 'start': {
      const softs: GSoft[] = e.soft_yeses.map((x) => ({
        key: x.key, name: x.name, read: false, rounds: null, led: null, followed: null, walking: null, capped: false,
      }))
      return {
        ...s,
        model: { softs, rounds: [], leads: [], settled: false },
        narration: `Starting from ${listAnd(softs.map((x) => x.name))}`,
        detail: 'Asking Cala for every funding round each one took part in',
      }
    }
    case 'investor': {
      const softs = m.softs.map((x) =>
        x.key === e.key
          ? { ...x, read: true, rounds: e.rounds, led: e.led, followed: e.followed, walking: e.walking, capped: e.rounds >= 50 }
          : x,
      )
      const none = e.rounds === 0
      return {
        ...s,
        model: { ...m, softs },
        counters: ((c) => ({ ...c, facts: c.facts + e.rounds }))(tally(s.counters, e)),
        narration: none ? `Cala has no funding rounds for ${e.name}` : `Reading ${e.name}'s ${plural(e.rounds, 'round')} in Cala`,
        detail: none ? 'Nothing to walk from it' : `It led ${e.led} and followed in ${e.followed}`,
      }
    }
    case 'round': {
      const soft = m.softs.find((x) => x.key === e.soft)
      let rounds = m.rounds
      const existing = rounds.find((r) => r.id === e.round.id)
      if (existing) {
        rounds = rounds.map((r) => (r === existing && !r.softs.includes(e.soft) ? { ...r, softs: [...r.softs, e.soft] } : r))
      } else {
        rounds = [...rounds, {
          id: e.round.id, brief: e.round, softs: [e.soft], leads: e.leads.map((l) => l.key), seq: rounds.length,
          via: e.via === 'knowledge' ? 'knowledge' : 'graph', relation: e.via === 'cap_table' ? 'cap_table' : 'round',
        }]
      }
      let leads = m.leads
      for (const l of e.leads) {
        const have = leads.find((x) => x.key === l.key)
        if (have) {
          if (!have.rounds.includes(e.round.id)) {
            leads = leads.map((x) => (x === have ? { ...x, rounds: [...x.rounds, e.round.id] } : x))
          }
        } else {
          leads = [
            ...leads,
            { key: l.key, name: l.name, kind: l.kind, rounds: [e.round.id], seq: leads.length, pulse: null, lastLed: null, rank: null },
          ]
        }
      }
      const n = soft?.walking ?? soft?.followed ?? 0
      const c = tally(s.counters, e)
      return {
        ...s,
        model: { ...m, rounds, leads },
        counters: existing ? c : { ...c, facts: c.facts + 3 + e.leads.length + e.others },
        narration: soft ? `Opening the ${plural(n, 'round')} ${soft.name} followed` : 'Opening the rounds they followed',
        detail: e.leads.length
          ? `${roundPhrase(e.round)}: led by ${listAnd(e.leads.map((l) => l.name))}`
          : `${roundPhrase(e.round)}: no outside lead in Cala`,
      }
    }
    case 'leads':
      return {
        ...s,
        narration: e.count ? `${plural(e.count, 'investor')} led those rounds` : 'No outside investor led those rounds',
        detail: e.count ? 'Next: does each one still lead?' : '',
      }
    case 'pulse': {
      const isLead = m.leads.some((l) => l.key === e.key)
      const leads = isLead
        ? m.leads.map((l) => (l.key === e.key ? { ...l, pulse: { rounds: e.rounds, led: e.led, capped: e.rounds >= 50 } } : l))
        : m.leads
      const c = tally(s.counters, e)
      return {
        ...s,
        model: { ...m, leads },
        counters: isLead ? { ...c, facts: c.facts + e.rounds } : c,
        narration: isLead ? "Reading each lead's own record" : 'Reading co-investors who lead elsewhere',
        detail: e.rounds ? `${e.name} led ${e.led} of its ${plural(e.rounds, 'round')} in Cala` : `${e.name}: no rounds under this name in Cala's graph`,
      }
    }
    case 'verify': {
      const lead = m.leads.find((l) => l.key === e.key)
      const leads = lead
        ? m.leads.map((l) => (l === lead && (!l.lastLed || (e.round.date ?? '') > l.lastLed) ? { ...l, lastLed: e.round.date } : l))
        : m.leads
      const when = fmtMonth(e.round.date)
      return {
        ...s,
        model: { ...m, leads },
        counters: tally(s.counters, e),
        narration: 'Checking the latest round each one led',
        detail: `${roundPhrase(e.round)}${when ? `, ${when}` : ''}`,
      }
    }
    case 'note':
      return { ...s, notes: s.notes.includes(e.text) ? s.notes : [...s.notes, e.text] }
    case 'ledger':
      return { ...s, counters: tally(s.counters, e) }
    case 'error':
      return { ...s, phase: 'error', error: e.message }
    case 'done':
      return s
    default:
      // An event this build does not know: the walk goes on.
      return s
  }
}

/**
 * The second pass changes no graph on screen: it reports what it is reading, and the final result replaces the first.
 * Its ledger restarts from zero, so the counters hold at the first result until the final one lands.
 */
function applyDeep(s: WalkState, e: WalkEvent): WalkState {
  const deep = s.deep ?? { reading: [], line: '', added: 0 }
  switch (e.t) {
    case 'knowledge':
      return {
        ...s,
        deep: {
          ...deep,
          line: e.state === 'asking'
            ? `Cala's knowledge search is reading reports that name ${e.name}`
            : e.rows
              ? `${plural(e.rows, 'more round')} for ${e.name} found in reports, each checked against the page that reports it`
              : `No further rounds for ${e.name} in the reports Cala read`,
        },
      }
    case 'captable':
      return {
        ...s,
        deep: { ...deep, line: `Opening ${plural(e.companies, 'company', 'companies')} ${e.name} backs, to see who led their rounds` },
      }
    case 'round':
      return {
        ...s,
        deep: {
          ...deep,
          added: deep.added + 1,
          line: e.leads.length ? `${roundPhrase(e.round)}: led by ${listAnd(e.leads.map((l) => l.name))}` : `${roundPhrase(e.round)}: no outside lead named`,
        },
      }
    case 'note':
    case 'error':
      return applyEvent(s, e)
    default:
      return s
  }
}

// ------------------------------------------------------------------------- from a finished result

export function modelFromResult(result: Result, seqFrom?: GraphModel): GraphModel {
  const softs: GSoft[] = result.soft_yeses.map((x) => ({
    key: x.key,
    name: x.name,
    read: true,
    rounds: x.rounds_in_cala,
    led: x.led,
    followed: x.followed,
    walking: x.walked,
    capped: !!x.capped,
  }))
  const prevRound = new Map(seqFrom?.rounds.map((r) => [r.id, r.seq]))
  const prevLead = new Map(seqFrom?.leads.map((l) => [l.key, l.seq]))
  const rounds: GRound[] = []
  const byId = new Map<string, GRound>()
  for (const s of result.soft_yeses) {
    for (const fr of s.followed_rounds ?? []) {
      const have = byId.get(fr.id)
      if (have) {
        if (!have.softs.includes(s.key)) have.softs.push(s.key)
        continue
      }
      const r: GRound = {
        id: fr.id,
        brief: { id: fr.id, issuer: fr.issuer, stage: fr.stage, stage_name: fr.stage_name, date: fr.date, amount: fr.amount, currency: fr.currency },
        softs: [s.key],
        leads: [],
        seq: prevRound.get(fr.id) ?? rounds.length,
        via: fr.via ?? 'graph',
        relation: fr.relation ?? 'round',
      }
      byId.set(fr.id, r)
      rounds.push(r)
    }
  }
  const leads: GLead[] = result.leads.map((l, i) => {
    const ids: string[] = []
    for (const ev of l.evidence) {
      const r = byId.get(ev.id)
      if (r) {
        if (!r.leads.includes(l.key)) r.leads.push(l.key)
        ids.push(ev.id)
      }
    }
    return {
      key: l.key,
      name: l.name,
      kind: l.kind,
      rounds: ids,
      seq: prevLead.get(l.key) ?? i,
      pulse: l.pulse ? { rounds: l.pulse.rounds, led: l.pulse.led, capped: l.pulse.capped } : null,
      lastLed: l.pulse ? (l.last_led?.date ?? null) : null,
      rank: l.rank ?? i + 1,
    }
  })
  return { softs, rounds, leads, settled: true }
}

/** Rebuild the walk's events from a stored result, so a permalink can replay without calling Cala. */
export function eventsFromResult(result: Result): WalkEvent[] {
  const out: WalkEvent[] = []
  const leadsOf = new Map<string, { key: string; name: string; kind: Kind }[]>()
  const investorsIn = new Map<string, number>()
  for (const l of result.leads) {
    for (const ev of l.evidence) {
      const list = leadsOf.get(ev.id) ?? []
      list.push({ key: l.key, name: l.name, kind: l.kind })
      leadsOf.set(ev.id, list)
      if (ev.investors != null) investorsIn.set(ev.id, ev.investors)
    }
  }
  let calls = 0
  out.push({ t: 'start', soft_yeses: result.soft_yeses.map((s) => ({ key: s.key, name: s.name })) })
  for (const s of result.soft_yeses) {
    calls += Math.max(1, s.ids?.length ?? 1)
    out.push({
      t: 'investor', key: s.key, name: s.name, rounds: s.rounds_in_cala ?? 0, led: s.led ?? 0, followed: s.followed ?? 0,
      walking: Math.max(s.walked ?? 0, s.followed_rounds?.length ?? 0), cala_calls: calls,
    })
  }
  for (const s of result.soft_yeses) {
    for (const fr of s.followed_rounds ?? []) {
      const leads = leadsOf.get(fr.id) ?? []
      calls += 1
      out.push({
        t: 'round', soft: s.key,
        round: { id: fr.id, issuer: fr.issuer, stage: fr.stage, stage_name: fr.stage_name, date: fr.date, amount: fr.amount, currency: fr.currency },
        leads, others: Math.max(0, (investorsIn.get(fr.id) ?? leads.length + 1) - leads.length), cala_calls: calls,
        via: fr.via === 'knowledge' ? 'knowledge' : fr.relation === 'cap_table' ? 'cap_table' : undefined,
      })
    }
  }
  out.push({ t: 'leads', count: result.leads.length, top: result.leads.slice(0, 12).map((l) => ({ key: l.key, name: l.name })) })
  for (const l of [...result.leads, ...result.second_ring]) {
    if (!l.pulse) continue
    calls += 1
    out.push({ t: 'pulse', key: l.key, name: l.name, rounds: l.pulse.rounds, led: l.pulse.led, cala_calls: calls })
  }
  for (const l of [...result.leads.slice(0, 5), ...result.second_ring.slice(0, 2)]) {
    const seen = new Set(l.evidence.map((e) => e.id))
    for (const r of l.recent_leads.filter((x) => !seen.has(x.id)).slice(0, 2)) {
      calls += 1
      out.push({
        t: 'verify', key: l.key, cala_calls: calls,
        round: { id: r.id, issuer: r.issuer, stage: r.stage, stage_name: r.stage_name, date: r.date, amount: r.amount, currency: r.currency },
      })
    }
  }
  for (const text of result.notes ?? []) out.push({ t: 'note', text })
  out.push({ t: 'done', run_id: result.run_id, result })
  return out
}

function finalCounters(result: Result): Counters {
  const l = result.ledger
  return { calls: l.cala_calls, facts: l.facts ?? 0, sources: l.sources ?? null, fresh: l.fresh, cached: l.cached }
}

// --------------------------------------------------------------------------------------------- store

const BASE_DELAY: Record<WalkEvent['t'], number> = {
  start: 420, investor: 560, round: 135, leads: 520, pulse: 105, verify: 180, note: 500, ledger: 0, done: 0, error: 0,
  partial: 0, knowledge: 0, captable: 0,
}
const TARGET_MS = 8200
const SETTLE_MS = 950

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RETRY_MS = [600, 1500, 3000]

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

class WalkStore {
  private state: WalkState = initial
  private listeners = new Set<() => void>()
  private queue: WalkEvent[] = []
  private timer: number | null = null
  private abort: AbortController | null = null
  private flush = false
  private budget = 0
  private played = 0
  private total = 0
  private final: Counters | null = null
  private settle: number | null = null
  /** events that arrived after the first result: the second pass, played as they come */
  private late = new WeakSet<WalkEvent>()
  private gotPartial = false

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  get = () => this.state

  private set(next: WalkState) {
    this.state = next
    this.listeners.forEach((fn) => fn())
  }

  private reset(mode: WalkState['mode'], inputs: WalkInputs | null) {
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
    if (this.settle != null) clearTimeout(this.settle)
    this.settle = null
    this.gotPartial = false
    this.abort?.abort()
    this.abort = null
    this.queue = []
    this.flush = reduceMotion()
    this.budget = 0
    this.played = 0
    this.total = 0
    this.final = null
    this.set({ ...initial, mode, inputs, phase: 'walking', generation: this.state.generation + 1, narration: 'Asking Cala', detail: '' })
  }

  /** A stored run, shown as is. If its second pass is still reading at the server, wait for the final result. */
  show(result: Result) {
    this.reset('static', inputFromResult(result))
    const reading = result.pending ?? []
    this.set({
      ...this.state,
      phase: 'done',
      model: modelFromResult(result),
      counters: finalCounters(result),
      notes: result.notes ?? [],
      result,
      runId: result.run_id,
      narration: '',
      detail: '',
      deep: reading.length ? { reading, line: `Cala's knowledge search is reading reports that name ${listAnd(reading)}`, added: 0 } : null,
    })
    if (reading.length) {
      this.gotPartial = true
      void this.follow(result.run_id, this.state.generation)
    }
  }

  /** Play a stored run again, from its own data. No Cala calls. */
  replay(result: Result) {
    this.reset('replay', inputFromResult(result))
    this.set({ ...this.state, runId: result.run_id })
    this.push(eventsFromResult(result))
  }

  /**
   * A live walk. The server finishes and stores a walk even when the connection to it drops, and Cala's
   * answers are kept, so a drop is not an error: before the first result the walk is asked for again,
   * after it the final result is fetched when it is ready.
   */
  async start(inputs: WalkInputs) {
    this.reset('live', inputs)
    const generation = this.state.generation
    const mine = () => this.state.generation === generation
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController()
      this.abort = abort
      let refused: string | null = null
      try {
        const res = await fetch('/api/walk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ soft_yeses: inputs.soft_yeses, stage: inputs.stage ?? undefined, company: inputs.company ?? undefined }),
          signal: abort.signal,
        })
        if (res.ok && res.body) {
          if (await this.read(res.body, mine)) return
        } else if (res.status < 502 || res.status > 504) {
          let detail = ''
          try {
            detail = (await res.json())?.detail ?? ''
          } catch {
            /* not JSON */
          }
          refused = typeof detail === 'string' && detail ? detail : `The server answered ${res.status}.`
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
      }
      if (!mine()) return
      if (refused) {
        this.push([{ t: 'error', message: refused }])
        return
      }
      if (this.gotPartial && this.state.runId) {
        void this.follow(this.state.runId, generation)
        return
      }
      if (attempt >= RETRY_MS.length) {
        this.push([{ t: 'error', message: 'The connection dropped and did not come back. Try again: what Cala already answered is kept, so it is quick.' }])
        return
      }
      await sleep(RETRY_MS[attempt])
      if (!mine()) return
      this.rewind()
    }
  }

  /** Reads the event stream. True when it ended with a result or an error of its own; false when it was cut. */
  private async read(body: ReadableStream<Uint8Array>, mine: () => boolean): Promise<boolean> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        const batch: WalkEvent[] = []
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              const ev = JSON.parse(line.slice(5).trim()) as WalkEvent
              batch.push(ev)
              if (ev.t === 'done' || ev.t === 'error') finished = true
            } catch {
              /* a broken frame is skipped; the stream goes on */
            }
          }
        }
        if (batch.length && mine()) this.push(batch)
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
    }
    return finished
  }

  /** The same walk asked for again after a cut, before it had a result: start the picture over, quietly. */
  private rewind() {
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
    this.budget = 0
    this.played = 0
    this.total = 0
    this.final = null
    const { inputs, generation, mode } = this.state
    this.set({ ...initial, mode, inputs, generation, phase: 'walking', narration: 'Asking Cala', detail: '' })
  }

  /** The first result is on screen and the stream is gone: the walk goes on at the server, so wait for what it stores. */
  private async follow(runId: string, generation: number) {
    const until = Date.now() + 150_000
    while (Date.now() < until) {
      await sleep(2500)
      if (this.state.generation !== generation) return
      try {
        const res = await fetch(`/api/run/${encodeURIComponent(runId)}`)
        if (res.ok) {
          const result = (await res.json()) as Result
          if (this.state.generation !== generation) return
          if (!result.pending?.length) {
            this.push([{ t: 'done', run_id: result.run_id, result }])
            return
          }
        }
      } catch {
        /* offline for a moment: keep waiting */
      }
    }
    if (this.state.generation === generation) this.set({ ...this.state, deep: null })
  }

  skip() {
    this.flush = true
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = null
    this.drain()
    if (this.settle != null) clearTimeout(this.settle)
    this.settle = null
    // Skipped while the graph was settling: go straight to the results.
    if (this.state.phase === 'walking' && this.state.result) this.set({ ...this.state, phase: 'done', narration: '', detail: '' })
  }

  private push(events: WalkEvent[]) {
    for (const e of events) {
      if (e.t === 'done' || e.t === 'partial') {
        // The run id is known before the walk has finished playing: the page can take its permalink now.
        if (!this.gotPartial) this.final = finalCounters(e.result)
        if (this.state.runId !== e.run_id) this.set({ ...this.state, runId: e.run_id })
      }
      if (this.gotPartial) this.late.add(e)
      else {
        this.budget += BASE_DELAY[e.t] ?? 0
        this.total += 1
      }
      if (e.t === 'partial') this.gotPartial = true
      this.queue.push(e)
    }
    if (this.flush) this.drain()
    else if (this.timer == null) this.step()
  }

  private drain() {
    while (this.queue.length) this.play(this.queue.shift()!, true)
  }

  private step = () => {
    this.timer = null
    const e = this.queue.shift()
    if (!e) return
    this.play(e, false)
    // A long walk is compressed to stay watchable; a short one keeps its natural beat.
    // The beat holds even when nothing is queued yet: an answer Cala already had arrives one event at a
    // time and faster than anyone can read, and the next one must still wait its turn.
    const scale = Math.min(1, Math.max(0.3, TARGET_MS / Math.max(1, this.budget)))
    this.timer = window.setTimeout(this.step, this.late.has(e) ? 16 : Math.max(16, (BASE_DELAY[e.t] ?? 0) * scale))
  }

  private play(e: WalkEvent, instant: boolean) {
    if (e.t === 'partial') {
      this.finish(e.result, instant, e.reading)
      return
    }
    if (e.t === 'done') {
      // After a first result the final one replaces it in place: the reader is already in the shortlist.
      this.finish(e.result, instant || this.late.has(e), null)
      return
    }
    if (this.late.has(e)) {
      this.set(applyDeep(this.state, e))
      return
    }
    this.played += 1
    let next = applyEvent(this.state, e)
    if (this.final && next.phase === 'walking') {
      // The result is already in hand (cached walk or replay): let sources count up with the walk.
      const f = this.played / Math.max(1, this.total)
      // The running tallies are estimates from the events; they never pass the totals the result carries.
      next = {
        ...next,
        counters: {
          ...next.counters,
          calls: Math.min(next.counters.calls, this.final.calls),
          facts: Math.min(next.counters.facts, this.final.facts),
          sources: this.final.sources == null ? null : Math.round(this.final.sources * f),
        },
      }
    }
    this.set(next)
  }

  private finish(result: Result, instant: boolean, reading: string[] | null) {
    const settled = modelFromResult(result, this.state.model)
    const base: WalkState = {
      ...this.state,
      deep: reading?.length
        ? { reading, line: `Cala's knowledge search is reading reports that name ${listAnd(reading)}`, added: 0 }
        : null,
      model: settled,
      counters: finalCounters(result),
      notes: Array.from(new Set([...this.state.notes, ...(result.notes ?? [])])),
      result,
      runId: result.run_id,
    }
    if (this.settle != null) clearTimeout(this.settle)
    this.settle = null
    if (instant) {
      this.set({ ...base, phase: 'done', narration: '', detail: '' })
      return
    }
    const n = result.leads.length
    this.set({
      ...base,
      narration: n ? 'Ranking by who still leads' : 'Nothing more to walk',
      detail: n ? `${plural(n, 'lead')} from ${plural(result.rounds_walked, 'round')}` : '',
    })
    const generation = this.state.generation
    this.settle = window.setTimeout(() => {
      this.settle = null
      if (this.state.generation !== generation || this.state.phase !== 'walking') return
      this.set({ ...this.state, phase: 'done', narration: '', detail: '' })
    }, SETTLE_MS)
  }
}

function inputFromResult(result: Result): WalkInputs {
  return {
    soft_yeses: result.input.soft_yeses.map((s) => ({ name: s.name, ids: s.ids })),
    stage: result.input.stage,
    company: result.input.company?.id ? { id: result.input.company.id, name: result.input.company.name } : null,
  }
}

export const walkStore = new WalkStore()

export function useWalk(): WalkState {
  return useSyncExternalStore(walkStore.subscribe, walkStore.get)
}
