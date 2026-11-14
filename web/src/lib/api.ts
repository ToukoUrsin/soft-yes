// Types mirror the live API (softyes/api.py, walk.py, extras.py). Everything nullable there is nullable here.

export type Kind = 'fund' | 'person'
export type StageId = 'PRE_SEED' | 'SEED' | 'SERIES_A' | 'SERIES_B' | 'SERIES_C'

export interface Source {
  publisher: string | null
  url: string
  date?: string | null
  rank?: 'PRIMARY' | 'PRESS' | null
}

export interface Issuer { id: string; name: string }

export interface RoundBrief {
  id: string
  issuer: Issuer | null
  stage: string | null
  stage_name: string | null
  date: string | null
  amount: number | null
  currency: string | null
}

export interface RoundWithSources extends RoundBrief { sources?: Source[] }

/** "round": the soft yes was in this round. "cap_table": it backs the company; the round itself does not list it. */
export type Relation = 'round' | 'cap_table'
/** "graph": a funding-round entity in Cala. "knowledge": a report Cala's knowledge search read and cited. */
export type Via = 'graph' | 'knowledge'

export interface Evidence extends RoundBrief {
  date_is_report: boolean
  with: string[]
  with_keys: string[]
  co_leads: string[]
  investors: number | null
  relation?: Relation
  via?: Via
  sources: Source[]
}

export interface YearCount { year: number; joined: number; led: number }

export interface Pulse {
  rounds: number
  led: number
  lead_rate: number | null
  led_recent: number
  recent_months: number
  by_year: YearCount[]
  led_stages: { stage: string; n: number }[]
  capped: boolean
  portfolio_size: number
}

export interface Ask { key: string; name: string; deals: number; last: Evidence }

/** People from this investor registered for Slush. Head count and job titles only: no names. */
export interface AtSlush { firm: string; people: number; titles: string[] }

export interface Why { tone: 'good' | 'warn' | 'plain'; text: string }

export interface Lead {
  key: string
  id: string
  ids: string[]
  name: string
  kind: Kind
  ring: 1 | 2
  rank?: number
  score: number
  why: Why[]
  evidence: Evidence[]
  ask: Ask | null
  asks: Ask[]
  pulse: Pulse | null
  recent_leads: RoundWithSources[]
  last_led: RoundWithSources | null
  fit: { stage: string; stage_name: string; led_at_stage: number; match: boolean } | null
  typical_round: { min: number; max: number; n: number } | null
  portfolio: { id: string; name: string; sources: Source[] }[]
  at_slush?: AtSlush | null
}

export interface FollowedRound extends RoundBrief { leads: string[]; sources: Source[]; relation?: Relation; via?: Via }

export type Verdict = 'follows' | 'mixed' | 'leads' | 'thin' | 'unknown'

export interface SoftYes {
  key: string
  name: string
  ids: string[]
  kind?: Kind
  found: boolean
  rounds_in_cala: number | null
  led: number | null
  followed: number | null
  lead_rate: number | null
  walked: number | null
  capped: boolean | null
  verdict: Verdict
  insight: string
  pulse: Pulse | null
  description: string | null
  led_rounds: RoundWithSources[] | null
  usual_leads: { name: string; deals: number }[]
  followed_rounds: FollowedRound[]
  at_slush?: AtSlush | null
  /** Second pass through Cala's knowledge search, for investors with few rounds in the graph. */
  knowledge?: { question: string; read: number; kept: number; added: number; dropped: number; passages: number } | null
  cap_companies?: number
}

export interface Ledger {
  cala_calls: number
  fresh: number
  cached: number
  facts?: number
  sources?: number
  seconds?: number
  llm_facts?: number
}

export interface SoftInput { name: string; ids: string[]; kind?: Kind }

export interface Result {
  run_id: string
  created: number
  input: {
    soft_yeses: { name: string; ids: string[] }[]
    stage: StageId | null
    stage_name: string | null
    company: { id: string | null; name: string } | null
  }
  headline: string
  soft_yeses: SoftYes[]
  leads: Lead[]
  second_ring: Lead[]
  rounds_walked: number
  ledger: Ledger
  notes: string[]
  credits?: { used: number; cap: number; cached_calls: number }
  profile?: Profile | null
  slush?: { connected: boolean; firms: number; people: number; leads_attending: number }
}

export interface Profile {
  id?: string
  description: string | null
  website: string | null
  hq: string | null
  people: { name: string; role?: string | null }[]
  website_sources?: Source[]
}

export interface Config {
  framing: 'softyes' | 'investor_check' | 'conflict_check'
  stages: { id: StageId; name: string }[]
  credits: { used: number; cap: number; cached_calls: number }
  index_size: number
  gemini: boolean
  oxylabs: boolean
  slush?: { connected: boolean; firms: number; people: number }
}

export interface Example {
  id: string
  title: string
  blurb: string
  soft_yeses: SoftInput[]
  stage: StageId | null
}

export interface Suggestion {
  key: string
  name: string
  ids: string[]
  kind: Kind
  type: string | null
  description: string | null
  known_rounds: number
}

export interface Company {
  id: string
  name: string
  description: string | null
  website: string | null
  founded: string | number | null
  total_funding: number | null
  currency: string | null
  stage: string | null
  hq: string | null
  investors: { id: string; ids: string[]; key: string; name: string; kind: Kind }[]
  rounds: unknown
  industries: { id: string; name: string }[]
}

export type DraftKind = 'intro_ask' | 'direct' | 'slush'
export interface Founder { company: string; one_liner: string; raising: string }
export interface Draft {
  kind: DraftKind
  subject: string
  body: string
  facts: string[]
  model: string | null
  checked: boolean
  fallback: boolean
  chars: number
  note: string
}

export interface Says {
  available: boolean
  reason: string | null
  website: string | null
  website_sources?: Source[]
  people?: { name: string; role?: string | null }[]
  pages: { url: string; chars: number; status: string }[]
  quotes: { text: string; topic: 'leads' | 'stage' | 'cheque' | 'sector' | 'geography'; url: string }[]
  did: {
    rounds: number | null
    led: number | null
    lead_rate: number | null
    led_recent: number | null
    recent_months: number | null
    led_stages: { stage: string; n: number }[]
    last_led: RoundWithSources | null
  }
}

export interface ConflictCompany {
  id: string
  name: string
  description: string | null
  website: string | null
  industries: string[]
  shared_industries: string[]
  stage: string | null
  sources: Source[]
}
export interface Conflicts {
  available: boolean
  reason: string | null
  portfolio_size: number
  about?: string
  company: { id: string; name: string; description: string | null; industries: { id: string; name: string }[] } | null
  checked: ConflictCompany[]
  overlaps: ConflictCompany[]
  note?: string
}

export interface AskAnswer {
  available: boolean
  question: string
  reason?: string
  answer?: string | null
  steps?: { content: string | null; facts: { id?: string; content: string | null; origins: { publisher: string; url: string }[] }[] }[]
  facts?: number
  entities?: { id: string; name: string }[]
}

export interface SlushInfo {
  events_checked: number
  events: {
    id: string
    title: string | null
    start: string | null
    end: string | null
    venue: string | null
    host: string | null
    role: 'host' | 'named'
    snippet: string | null
  }[]
  slush: { starts: string; ends: string; days_away: number }
  meeting_tool: { note_limit: number; slot_minutes: number }
  source: { publisher: string; url: string } | null
  attending?: AtSlush | null
  directory?: { connected: boolean; firms: number; people: number }
}

export interface References {
  lead: string
  companies_checked: number
  references: {
    company: Issuer
    round: { id: string; stage_name: string | null; date: string | null; amount: number | null; currency: string | null }
    round_sources: Source[]
    people: { id: string; name: string; role: string; sources: Source[] }[]
  }[]
  unnamed: string[]
  people: number
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'The server did not answer. Check that Soft Yes is running, then try again.')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.detail === 'string' ? body.detail : ''
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail || `The server answered ${res.status}.`)
  }
  return (await res.json()) as T
}

const qs = (params: Record<string, string | undefined | null>) =>
  Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&')

export const api = {
  config: () => request<Config>('/api/config'),
  examples: () => request<{ examples: Example[] }>('/api/examples'),
  suggest: (q: string, signal?: AbortSignal) =>
    request<{ items: Suggestion[]; source: 'index' | 'cala' | 'none' }>(`/api/suggest?${qs({ q })}`, { signal }),
  company: (id: string, signal?: AbortSignal) => request<Company>(`/api/company?${qs({ id })}`, { signal }),
  run: (runId: string, signal?: AbortSignal) => request<Result>(`/api/run/${encodeURIComponent(runId)}`, { signal }),
  investor: (ids: string[], name: string | null, signal?: AbortSignal) =>
    request<Result>(`/api/investor?${qs({ ids: ids.join(','), name })}`, { signal }),
  draft: (
    body: { run_id: string; lead_key: string; kind: DraftKind; founder: Founder; llm: boolean },
    signal?: AbortSignal,
  ) =>
    request<Draft>('/api/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  says: (runId: string, leadKey: string, signal?: AbortSignal) =>
    request<Says>(`/api/says?${qs({ run_id: runId, lead_key: leadKey })}`, { signal }),
  conflicts: (runId: string, leadKey: string, companyId: string | null, about: string, signal?: AbortSignal) =>
    request<Conflicts>(`/api/conflicts?${qs({ run_id: runId, lead_key: leadKey, company_id: companyId, about })}`, {
      signal,
    }),
  ask: (runId: string, leadKey: string, q: string, signal?: AbortSignal) =>
    request<AskAnswer>(`/api/ask?${qs({ run_id: runId, lead_key: leadKey, q })}`, { signal }),
  references: (runId: string, leadKey: string, signal?: AbortSignal) =>
    request<References>(`/api/references?${qs({ run_id: runId, lead_key: leadKey })}`, { signal }),
  slush: (runId: string, leadKey: string, signal?: AbortSignal) =>
    request<SlushInfo>(`/api/slush?${qs({ run_id: runId, lead_key: leadKey })}`, { signal }),
}

export function investorHref(ids: string[], name?: string | null): string {
  const base = `/investor/${ids.slice(0, 4).join(',')}`
  return name ? `${base}?name=${encodeURIComponent(name)}` : base
}
