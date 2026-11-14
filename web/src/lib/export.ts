import type { Lead, Result } from './api'
import { dealPhrase, fmtDate, fmtMoney, fmtMonth, host, listAnd } from './format'

export function proofLine(result: Result): string {
  const l = result.ledger
  const parts = [`${l.cala_calls} Cala calls`]
  if (l.facts != null) parts.push(`${l.facts} sourced facts`)
  if (l.sources != null) parts.push(`${l.sources} sources`)
  parts.push('0 stated by a language model')
  return parts.join(', ')
}

function title(result: Result): string {
  const names = listAnd(result.input.soft_yeses.map((s) => s.name))
  return `Lead shortlist for a round ${names} will follow${result.input.stage_name ? ` (${result.input.stage_name})` : ''}`
}

function leadMarkdown(l: Lead, heading: string): string {
  const out: string[] = [`### ${heading}`, '']
  for (const w of l.why) out.push(`- ${w.text}`)
  if (l.ask) out.push('', `Ask ${l.ask.name} for the intro. Deal to cite: ${dealPhrase(l.ask.last)}.`)
  if (l.evidence.length) {
    out.push('', 'Shared deals:')
    for (const e of l.evidence) {
      const bits = [e.issuer?.name ?? 'Unnamed company', e.stage && e.stage_name ? e.stage_name : '', fmtMoney(e.amount, e.currency), fmtMonth(e.date)]
        .filter(Boolean)
        .join(', ')
      const src = e.sources.map((s) => `[${s.publisher || host(s.url)}](${s.url})`).join(', ')
      out.push(`- ${bits}${e.with.length ? `, with ${listAnd(e.with)}` : ''}${src ? `. Sources: ${src}` : ''}`)
    }
  }
  if (l.last_led) {
    const src = (l.last_led.sources ?? []).map((s) => `[${s.publisher || host(s.url)}](${s.url})`).join(', ')
    out.push('', `Last round it led in Cala: ${dealPhrase(l.last_led)}${src ? `. Sources: ${src}` : ''}`)
  }
  return out.join('\n')
}

export function toMarkdown(result: Result, permalink: string): string {
  const out: string[] = [`# ${title(result)}`, '', result.headline, '']
  out.push('## Who said yes', '')
  for (const s of result.soft_yeses) out.push(`- ${s.insight}`)
  if (result.leads.length) {
    out.push('', '## Likely leads', '')
    for (const l of result.leads) out.push(leadMarkdown(l, `${l.rank ?? ''}. ${l.name}`.trim()), '')
  }
  if (result.second_ring.length) {
    out.push('## Second ring: sat in those rounds without leading, lead elsewhere', '')
    for (const l of result.second_ring) out.push(leadMarkdown(l, l.name), '')
  }
  out.push('---', `${proofLine(result)}.`, `Every fact is from Cala with its source. ${permalink}`)
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

const cell = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(result: Result): string {
  const head = [
    'rank', 'investor', 'ring', 'kind', 'shared_rounds', 'with', 'ask_for_intro', 'deal_to_cite', 'deal_date', 'led_in_cala',
    'rounds_in_cala', 'led_last_24_months', 'last_led_company', 'last_led_date', 'stage_fit', 'reasons', 'sources',
  ]
  const rows = [...result.leads, ...result.second_ring].map((l) => {
    const withNames = Array.from(new Set(l.evidence.flatMap((e) => e.with)))
    const urls = Array.from(new Set(l.evidence.flatMap((e) => e.sources.map((s) => s.url))))
    return [
      l.ring === 1 ? l.rank : '',
      l.name,
      l.ring,
      l.kind,
      l.evidence.length,
      withNames.join('; '),
      l.ask?.name,
      l.ask ? dealPhrase(l.ask.last) : '',
      l.ask?.last.date ?? '',
      l.pulse?.led,
      l.pulse ? `${l.pulse.rounds}${l.pulse.capped ? '+' : ''}` : '',
      l.pulse?.led_recent,
      l.last_led?.issuer?.name,
      l.last_led?.date ? fmtDate(l.last_led.date) : '',
      l.fit ? (l.fit.match ? `has led at ${l.fit.stage_name}` : `no ${l.fit.stage_name} lead in Cala`) : '',
      l.why.map((w) => w.text).join('; '),
      urls.join(' '),
    ]
      .map(cell)
      .join(',')
  })
  return [head.join(','), ...rows].join('\r\n')
}

export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
