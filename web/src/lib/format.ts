const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(iso: string | null | undefined): [number, number, number] | null {
  if (!iso) return null
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(iso)
  if (!m) return null
  return [Number(m[1]), m[2] ? Number(m[2]) : 0, m[3] ? Number(m[3]) : 0]
}

/** "6 Nov 2026". Falls back to "Nov 2026" or "2026" when the date is partial; "" when missing. */
export function fmtDate(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return ''
  const [y, m, d] = p
  if (!m || m > 12) return String(y)
  if (!d) return `${MONTHS[m - 1]} ${y}`
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** "Jul 2024" */
export function fmtMonth(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return ''
  const [y, m] = p
  if (!m || m > 12) return String(y)
  return `${MONTHS[m - 1]} ${y}`
}

const SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' }

/** 1500000, "EUR" -> "€1.5M". "" when there is no amount. */
export function fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (!amount || !Number.isFinite(amount)) return ''
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '')
  let s: string
  if (amount >= 1e9) s = `${trim(amount / 1e9)}B`
  else if (amount >= 1e6) s = `${trim(amount / 1e6)}M`
  else if (amount >= 1e3) s = `${Math.round(amount / 1e3)}K`
  else s = String(Math.round(amount))
  const sym = currency ? SYMBOL[currency] : undefined
  if (sym) return `${sym}${s}`
  return currency ? `${s} ${currency}` : s
}

export function plural(n: number, word: string, many?: string): string {
  return `${n} ${n === 1 ? word : (many ?? `${word}s`)}`
}

/** "A", "A or B", "A, B or C" */
/** "Tesi’s", "Lifeline Ventures’": a name that ends in s takes the apostrophe alone. */
export function possessive(name: string): string {
  return /s$/i.test(name.trim()) ? `${name}’` : `${name}’s`
}

export function listOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

export function listAnd(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A stage label worth showing. Cala's unknown stage comes back as "Round"; that is not a stage. */
export function stageLabel(stage: string | null | undefined, stageName: string | null | undefined): string {
  if (!stage || !stageName) return ''
  return stageName
}

/** "Seaber.io's €1.5M seed (Jul 2024)" */
export function dealPhrase(d: {
  issuer: { name: string } | null
  stage: string | null
  stage_name: string | null
  amount: number | null
  currency: string | null
  date: string | null
}): string {
  const issuer = d.issuer?.name || 'a company'
  let stage = d.stage && d.stage_name ? d.stage_name.toLowerCase() : 'round'
  stage = stage.replace(/series ([a-z])/, (_, c: string) => `Series ${c.toUpperCase()}`)
  const money = fmtMoney(d.amount, d.currency)
  const when = fmtMonth(d.date)
  const core = `${d.issuer?.name ? possessive(issuer) : 'a company’s'} ${money ? `${money} ` : ''}${stage}`
  return when ? `${core} (${when})` : core
}

/** Rounds count that respects Cala's 50-item cap. */
export function capped(n: number | null | undefined, isCapped: boolean | null | undefined): string {
  if (n == null) return ''
  return isCapped ? `${n}+` : String(n)
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Slush listings are UTC; the event is in Helsinki. */
export function fmtEventTime(start: string | null, end: string | null): string {
  if (!start) return ''
  const s = new Date(start)
  if (Number.isNaN(s.getTime())) return ''
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Helsinki' })
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Helsinki' })
  let out = `${day.format(s).replace(',', '')}, ${time.format(s)}`
  if (end) {
    const e = new Date(end)
    if (!Number.isNaN(e.getTime())) out += ` to ${time.format(e)}`
  }
  return out
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** "Series A", "pre-seed", "seed"; "round" when Cala has no stage for it. */
export function stageWord(stageName: string | null | undefined): string {
  if (!stageName || stageName === 'Round') return 'round'
  return stageName.toLowerCase().replace(/series ([a-z])/, (_, c: string) => `Series ${c.toUpperCase()}`)
}

/** A sentence lifted from a page: links stripped from it leave " ," and footnote marks behind. */
export function cleanQuote(q: string | null | undefined): string {
  if (!q) return ''
  return q
    .replace(/\s*\[\s*\d+\s*\]/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s{2,}/g, ' ')
    .replace(/^…\s*/, '… ')
    .trim()
}
