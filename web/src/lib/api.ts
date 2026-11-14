// Types mirror the live API (softyes/api.py, walk.py, extras.py). Everything nullable there is nullable here.

export type Kind = 'fund' | 'person'
export type StageId = 'PRE_SEED' | 'SEED' | 'SERIES_A' | 'SERIES_B' | 'SERIES_C'

export interface Source {
  publisher: string | null
  url: string
  date?: string | null
  rank?: 'PRIMARY' | 'PRESS' | null
  /** What this page is cited for on this row. Empty: it is about the round but backs none of the facts shown. */
  backs?: Backs[]
}

export type Backs = 'lead' | 'amount' | 'date'

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

/**
 * What the page Cala cites says about one "led" claim.
 * lead: it says this investor led (quote). report: the round is from a report, not a round page.
 * follower: it names another lead (led_by). unstated: it names the investor but not as lead. other: it says the investor
 * led a different round of the company (other_round). absent: it does not name the investor. off: the page is about
 * something else. unread: the page could not be read.
 */
export type CheckStatus = 'lead' | 'report' | 'follower' | 'unstated' | 'other' | 'absent' | 'off' | 'unread'
export interface Check {
  status: CheckStatus
  quote?: string | null
  url?: string | null
  publisher?: string | null
  led_by?: string[] | null
  other_round?: string | null
  /** The only page that says so is months older than the date Cala gives the round: the page's date and stage. */
  earlier?: { date: string; stage_name: string | null } | null
}
/** Cala's stage label next to the one the page uses (null: the page names no stage). */
export interface StagePage { cala: string; page: string | null }

export interface RoundWithSources extends RoundBrief {
  sources?: Source[]
  check?: Check | null
  stage_page?: StagePage | null
  off_page?: boolean
}

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
  /** Cala's date for the round is later than every page that names this lead: the row shows the report's date. */
  caution?: string | null
  /** An amount Cala attaches to the round from a page older than the round. Not shown as the round's size. */
  amount_set_aside?: SetAside | null
  check?: Check | null
  /** Cala did not flag this investor as the lead; the page says it led. */
  promoted?: boolean
  stage_page?: StagePage | null
  off_page?: boolean
  stage_set_aside?: { stage: string; stage_name: string; other: string } | null
}

/** `reported`: the only page behind the amount is older than the round. `why: "page"`: no page read for the round states it. */
export interface SetAside { amount: number; currency: string | null; reported?: string; why?: 'page' }

export type TierId = 'active' | 'thin' | 'quiet' | 'unconfirmed' | 'check'
export interface Tier { id: TierId; label: string; note: string; count: number }

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
  tier?: TierId
  /** Of the rounds here whose page was read, how many say this investor led. */
  confirmed?: number
  checked?: number
  /** Cala's record under this name looks like a different company. */
  wrong_entity?: boolean
  doubt?: Doubt | null
}

export interface Doubt { founded?: number | null; round_year?: number | null; description?: string | null; text: string }

export interface FollowedRound extends RoundBrief {
  leads: string[]
  /** The leads the cited page itself names. */
  leads_on_page?: string[]
  stage_page?: StagePage | null
  sources: Source[]
  relation?: Relation
  via?: Via
}

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
  /** Rounds Cala says it led where the page names another lead. */
  led_corrected?: RoundWithSources[] | null
  doubt?: Doubt | null
  /** Rounds added from reports. */
  reports?: number
  duplicates?: number | null
}

// ---- the page check

interface FindingBase { round: string; company: string; stage_name: string | null; date: string | null }
export interface ConfirmedRow extends FindingBase { kind: 'confirmed'; cala: string; quote: string; url: string; publisher: string | null }
export interface LeadFinding extends FindingBase {
  kind: 'lead'; cala: string; page: string[]; quote: string | null; url: string | null; publisher: string | null; other_round?: string | null
}
export interface AmountFinding extends FindingBase { kind: 'amount'; amount: number; currency: string | null; pages: string[] }
export interface StageFinding extends FindingBase { kind: 'stage'; cala: string; page: string | null; pages: string[] }
export type Finding = LeadFinding | AmountFinding | StageFinding

export interface PageCheck {
  rounds: number
  pages: number
  confirmed: number
  corrected: number
  added?: number
  unstated: number
  unread: number
  amounts?: number
  stages?: number
  late?: number
  findings: Finding[]
  confirmed_rows: ConfirmedRow[]
}

export interface Audit {
  walks: number
  rounds: number
  pages: number
  claims: number
  confirmed: number
  corrected: number
  unstated: number
  unread: number
  leads: LeadFinding[]
  confirmed_rows: ConfirmedRow[]
  amounts: AmountFinding[]
  stages: StageFinding[]
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
    /** No stage given: the one most of the walked rounds carry. */
    stage_usual?: { stage: string; stage_name: string; rounds: number; of: number } | null
  }
  headline: string
  soft_yeses: SoftYes[]
  leads: Lead[]
  second_ring: Lead[]
  /** How much Cala holds on each lead, strongest first. The list is grouped by it. */
  tiers?: Tier[]
  rounds_walked: number
  ledger: Ledger
  notes: string[]
  credits?: { used: number; cap: number; cached_calls: number }
  profile?: Profile | null
  slush?: { connected: boolean; firms: number; people: number; leads_attending: number }
  /** The pages Cala cites, re-read: how many "led" claims they confirm, correct or leave open. */
  page_check?: PageCheck | null
  /** Set on a first result while the second pass is still reading these investors; gone from the final one. */
  pending?: string[]
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
  /** Address of Soft Yes as an MCP server, for a founder's own assistant. */
  mcp?: string
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
  /** The name typed is close to this one but not the same: a likely misspelling. */
  did_you_mean?: boolean
  /** The top row is what was typed, with a record in Cala: Enter may take it. */
  sure?: boolean
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
  /** Checked against Cala. */
  facts: string[]
  /** The founder's own words. Nothing checks them. */
  yours?: string[]
  /** Blanks the founder still has to fill in, as they appear in the text: "[your company]". */
  placeholders?: string[]
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

/** One company's rounds in Cala, each lead claim next to what the cited page says. */
export interface CompanyRound {
  id: string
  stage_name: string | null
  date: string | null
  amount: number | null
  currency: string | null
  amount_set_aside?: unknown
  cala_leads: string[]
  investors: { name: string; cala_lead: boolean; is_lead: boolean; promoted: boolean; check: Check | null }[]
  others: number
  pages: { url: string; publisher: string | null; status: string }[]
}
export interface CompanyCheck {
  q: string
  company: { id: string; name: string; description: string | null } | null
  matches: { id: string; name: string; description: string | null }[]
  rounds: CompanyRound[]
  rounds_in_cala?: number
  investors_in_cala?: number | null
  page_check: { rounds: number; pages: number; confirmed: number; corrected: number; unstated: number; unread: number }
  /** No round in the graph: sentences from the pages Cala's knowledge search read. */
  knowledge?: { question: string; passages: number; quotes: { quote: string; url: string; publisher: string; title: string; table?: boolean }[] } | null
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RETRY_MS = [400, 1200, 2500]
export const OFFLINE = 'No connection to Soft Yes right now. Check your network and try again.'

/** Every call is a read or repeats safely, so a dropped connection or a gateway hiccup is retried quietly. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(path, init)
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
    }
    if (res?.ok) {
      const body = await res.json()
      // A slow answer is sent behind a trickle of spaces, so a failure after that arrives inside a 200.
      if (body && typeof body === 'object' && typeof body.failed === 'number') {
        throw new ApiError(body.failed, typeof body.detail === 'string' ? body.detail : `The server answered ${body.failed}.`)
      }
      return body as T
    }
    const transient = !res || (res.status >= 502 && res.status <= 504)
    if (transient && attempt < RETRY_MS.length) {
      await sleep(RETRY_MS[attempt])
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      continue
    }
    if (!res) throw new ApiError(0, OFFLINE)
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.detail === 'string' ? body.detail : ''
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail || (transient ? OFFLINE : `The server answered ${res.status}.`))
  }
}

const qs = (params: Record<string, string | undefined | null>) =>
  Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&')

export const api = {
  config: () => request<Config>('/api/config'),
  audit: (signal?: AbortSignal) => request<Audit>('/api/audit', { signal }),
  check: (by: { q?: string; id?: string }, signal?: AbortSignal) => request<CompanyCheck>(`/api/check?${qs(by)}`, { signal }),
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
  const base = `/investor/${ids.slice(0, 6).join(',')}`
  return name ? `${base}?name=${encodeURIComponent(name)}` : base
}
