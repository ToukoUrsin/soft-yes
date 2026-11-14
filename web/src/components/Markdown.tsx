import type { ReactNode } from 'react'

// A small, safe renderer for the Markdown Cala answers in: headings, lists, tables, bold, italic,
// code and links. It builds elements, never HTML strings.

const INLINE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const key = `i${i++}`
    if (m[1]) out.push(<a key={key} className="link" href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>)
    else if (m[3]) out.push(<strong key={key}>{m[3]}</strong>)
    else if (m[4]) out.push(<code key={key}>{m[4]}</code>)
    else if (m[5]) out.push(<em key={key}>{m[5]}</em>)
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const cells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = `b${blocks.length}`
    if (!line.trim()) {
      i += 1
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={key}>{inline(line.replace(/^#{1,6}\s+/, ''))}</h4>)
      i += 1
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(cells(lines[i]))
        i += 1
      }
      const [head, ...body] = rows
      blocks.push(
        <div key={key} className="md__table">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')
        i += 1
        // a wrapped list item continues on indented lines
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          item += ` ${lines[i].trim()}`
          i += 1
        }
        items.push(item)
      }
      const list = items.map((it, j) => <li key={j}>{inline(it)}</li>)
      blocks.push(ordered ? <ol key={key}>{list}</ol> : <ul key={key}>{list}</ul>)
    } else {
      const para: string[] = []
      while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) {
        para.push(lines[i].trim())
        i += 1
      }
      blocks.push(<p key={key}>{inline(para.join(' '))}</p>)
    }
  }
  return <div className="md">{blocks}</div>
}
