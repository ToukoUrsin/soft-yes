// What the server sends each card, and the small words the cards share.

export interface Brief { company?: string | null; stage_name?: string | null; date?: string | null; amount?: string | null }

export interface Evidence extends Brief {
  id: string
  status?: string | null
  quote?: string | null
  url?: string | null
  publisher?: string | null
  with: string[]
  co_leads: string[]
  via?: string | null
}

export interface Lead {
  key: string
  name: string
  rank?: number
  tier?: string
  tier_label?: string
  now: boolean
  led_recent?: number
  confirmed?: number
  checked?: number
  why: string[]
  caution?: string | null
  door?: { key: string; name: string; deals: number; round?: Brief | null } | null
  doors: { key: string; name: string; deals: number }[]
  evidence: Evidence[]
  rounds: number
  last_led?: Brief | null
  fit?: boolean | null
  at_slush: boolean
}

export interface Soft {
  key: string
  name: string
  verdict?: string
  rounds?: number
  led?: number
  followed?: number
  insight?: string
  from: 'inbox' | 'cala' | 'typed'
  person?: string
  said?: string
  date?: string
  email?: string
}

export interface RoundLead { key: string; name: string; status?: string | null; page?: string[] }
export interface Round { id: string; company?: string; stage_name?: string; date?: string; soft: string[]; leads: RoundLead[]; investors?: number; via?: string }
export interface Fix { round?: string; company?: string; stage_name?: string; date?: string; cala?: string; page: string[]; quote?: string; url?: string; publisher?: string }

export interface Net { names: string[]; keys?: string[]; softs: number; rounds: { c?: string; s?: string; d?: string; m: number[]; i: [number, number, number][] }[]; more: number }

export interface WalkData {
  view: 'walk'
  run_id: string
  url: string
  partial: boolean
  company?: string | null
  stage_name?: string | null
  headline: string
  softs: Soft[]
  rounds: Round[]
  rounds_walked?: number
  leads: Lead[]
  leads_total: number
  leading_now: number
  fixes: Fix[]
  check: { pages: number; confirmed: number; corrected: number; unstated: number; unread: number }
  ledger: { calls?: number; facts?: number; sources?: number; seconds?: number; llm: number; inbox: number }
  own?: { stage_name?: string; date?: string; from: string[]; of?: number; real: string[]; found?: { name: string; rank: number; through: any[] } | null } | null
  net?: Net | null
}

export interface NetworkData {
  view: 'network'
  run_id: string
  url: string
  company?: string | null
  softs: { key: string; name: string; rounds?: number; led?: number; followed?: number }[]
  focus?: string | null
  path: string[]
  leads: { key: string; name: string; rank?: number; now: boolean }[]
  ledger: { calls?: number; facts?: number; sources?: number; llm: number }
  net?: Net | null
}

export interface DraftData {
  view: 'draft'
  run_id: string
  url: string
  kind: 'intro_ask' | 'direct' | 'slush'
  lead: { key: string; name: string }
  to: { fund?: string; name?: string; email?: string }
  subject: string
  body: string
  facts: string[]
  yours: string[]
  placeholders: string[]
  note?: string
  written_by?: string | null
  dropped: string[]
  proof: Evidence[]
}

export interface TrackerData {
  view: 'tracker'
  tracker: string
  run_id: string
  url: string
  company?: string | null
  stage_name?: string | null
  target: { amount?: number; currency?: string }
  softs: { key: string; name: string; amount?: number | null; verdict?: string }[]
  leads: { key: string; name: string; status: string; via?: string | null; date?: string | null; note?: string | null; rank?: number; now: boolean; last_led?: Brief | null; new: boolean }[]
  labels: Record<string, string>
}

export interface ClaimData {
  view: 'claim'
  url: string
  company?: string
  investor?: string | null
  rounds: { id?: string; stage_name?: string; date?: string; amount?: string | null; others: number; investors: { name: string; cala_lead: boolean; status?: string | null; led_by: string[]; quote?: string | null; url?: string | null; publisher?: string | null; asked: boolean }[] }[]
  pages: number
  confirmed: number
  corrected: number
  investors_in_cala?: number
  said_on_pages: { quote?: string; url?: string; publisher?: string }[]
}

export type Data = WalkData | NetworkData | DraftData | TrackerData | ClaimData

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function month(iso?: string | null): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})/.exec(iso)
  if (!m) return ''
  return `${MONTHS[+m[2] - 1] ?? ''} ${m[1]}`.trim()
}

export function day(iso?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : month(iso)
}

export function listAnd(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? ''
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`
}

export function num(n?: number | null): string {
  return (n ?? 0).toLocaleString('en')
}

export function money(amount?: number | null, currency?: string): string {
  if (!amount) return ''
  const sym = ({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[currency || 'EUR'] ?? ''
  const cut = (x: number) => x.toFixed(1).replace(/\.0$/, '')
  if (amount >= 1e9) return `${sym}${cut(amount / 1e9)}B`
  if (amount >= 1e6) return `${sym}${cut(amount / 1e6)}M`
  if (amount >= 1e3) return `${sym}${Math.round(amount / 1e3)}K`
  return `${sym}${Math.round(amount)}`
}

/** "Casap, Series B, Oct 2026" */
export function roundName(b?: Brief | null): string {
  if (!b) return ''
  return [b.company, b.stage_name, month(b.date)].filter(Boolean).join(', ')
}

/** The name as a page may write it: in full, then without its last words. */
export function spellings(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let n = words.length; n > 0; n--) {
    const s = words.slice(0, n).join(' ')
    if (s.length >= 4 || n === words.length) out.push(s)
  }
  return out
}

/** Splits a sentence around the first spelling of any of the names found in it. */
export function cut(text: string, names: string[]): [string, string, string] {
  const low = text.toLowerCase()
  for (const name of names) {
    for (const s of spellings(name)) {
      const at = low.indexOf(s.toLowerCase())
      if (at >= 0) return [text.slice(0, at), text.slice(at, at + s.length), text.slice(at + s.length)]
    }
  }
  return [text, '', '']
}

export const STATUS_WORD: Record<string, string> = {
  lead: 'The page says it led',
  report: 'A report says it led',
  follower: 'The page names another lead',
  unstated: 'The page does not say who led',
  other: 'The page says it led another round',
  absent: 'The page does not name it',
  off: 'The cited page is about something else',
  unread: 'The page could not be read',
}

export const ok = (s?: string | null) => s === 'lead' || s === 'report'
export const wrong = (s?: string | null) => s === 'follower'

export function reduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
