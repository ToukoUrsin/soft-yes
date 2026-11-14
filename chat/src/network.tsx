// The network around the founder's investors, from Cala: who they have sat in a round with, who led, and which of
// them opens which door. One hop further is one more walk through Cala's graph.

import { useEffect, useMemo, useState } from 'preact/hooks'
import { callTool, say, tell } from './bridge'
import { DraftBody, writeAsk } from './cards'
import { type DraftData, type Net, type NetworkData, listAnd, num, plural, reduced } from './lib'
import { Btn, Count, Head, Icon, Ledger, Link, Seg, useWidth } from './ui'

interface Fund {
  idx: number
  name: string
  key: string
  rounds: number[]
  led: number
  proven: number
  doors: Map<number, number[]>
  last: string
}

function funds(net: Net): Fund[] {
  const by = new Map<number, Fund>()
  net.rounds.forEach((r, ri) => {
    for (const [idx, isLead, stat] of r.i) {
      if (idx < net.softs) continue
      let f = by.get(idx)
      if (!f) {
        f = { idx, name: net.names[idx], key: net.keys?.[idx] ?? net.names[idx].toLowerCase().replace(/[^a-z0-9]/g, ''), rounds: [], led: 0, proven: 0, doors: new Map(), last: '' }
        by.set(idx, f)
      }
      if (f.rounds.includes(ri)) continue
      f.rounds.push(ri)
      if (isLead && stat !== 2) f.led++
      if (isLead && stat === 1) f.proven++
      if ((r.d || '') > f.last) f.last = r.d || ''
      for (const m of r.m) f.doors.set(m, [...(f.doors.get(m) ?? []), ri])
    }
  })
  return [...by.values()].sort((a, b) => b.rounds.length - a.rounds.length || b.led - a.led || b.last.localeCompare(a.last) || a.name.localeCompare(b.name))
}

function roundWords(net: Net, ri: number): string {
  const r = net.rounds[ri]
  const [y, m] = (r.d || '').split('-')
  const mon = m ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] : ''
  return [r.c, r.s, [mon, y].filter(Boolean).join(' ')].filter(Boolean).join(', ')
}

export function Network({ data, roomy, canExpand, onExpand, onBack }: {
  data: NetworkData; roomy: boolean; canExpand: boolean; onExpand: () => void; onBack?: () => void
}) {
  const [stack, setStack] = useState<NetworkData[]>([data])
  useEffect(() => setStack([data]), [data])
  const d = stack[stack.length - 1]
  const net = d.net || { names: [], softs: 0, rounds: [], more: 0 }
  const [ref, width] = useWidth<HTMLDivElement>()
  const everyone = useMemo(() => funds(net), [net])
  const anyLed = everyone.some((f) => f.led > 0)
  const [mode, setMode] = useState<'led' | 'all'>(anyLed ? 'led' : 'all')
  const [sel, setSel] = useState<number | null>(null)
  const [softSel, setSoftSel] = useState<number | null>(null)
  const [hop, setHop] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<{ key: string; data: DraftData } | null>(null)
  const [inn, setIn] = useState(reduced())
  const leadKeys = useMemo(() => new Map(d.leads.map((l) => [l.key, l])), [d])

  const pool = useMemo(() => {
    let xs = mode === 'led' ? everyone.filter((f) => f.led > 0) : everyone
    if (softSel != null) xs = xs.filter((f) => f.doors.has(softSel))
    return xs
  }, [everyone, mode, softSel])
  const max = roomy ? 22 : width >= 560 ? 9 : 8
  let shown = pool.slice(0, max)
  const focusKey = d.focus
  const focused = focusKey ? everyone.find((f) => f.key === focusKey || f.key.includes(focusKey) || focusKey.includes(f.key)) : null
  if (focused && !shown.includes(focused) && softSel == null) shown = [focused, ...shown.slice(0, max - 1)]
  const current = shown.find((f) => f.idx === sel) ?? (softSel == null ? (focused && shown.includes(focused) ? focused : shown[0]) : shown[0])

  useEffect(() => {
    setSel(null)
    setSoftSel(null)
    setIn(reduced())
    const t = window.setTimeout(() => setIn(true), 60)
    return () => clearTimeout(t)
  }, [d])

  const wide = width >= 560
  const rowI = 44
  const rowF = 30
  const top = 26
  const softs = net.names.slice(0, net.softs)
  const H = top + Math.max(softs.length * rowI, shown.length * rowF, 90) + 6
  const W = Math.max(0, width - 2)
  const col = wide ? { i: [0, W * 0.27], f: [W * 0.44, W] } : { i: [0, W * 0.36], f: [W * 0.47, W] }
  const y = (n: number, i: number, h: number) => top + (H - top - 6 - n * h) / 2 + i * h + h / 2
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.5
    return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }

  const pick = (f: Fund) => {
    setSel(f.idx)
    const doors = [...f.doors.keys()].map((m) => net.names[m])
    tell(`The founder is looking at ${f.name} in the Soft Yes network (run ${d.run_id}): ${plural(f.rounds.length, 'shared round')}, door through ${listAnd(doors)}.`)
  }

  const walkOut = async (f: Fund) => {
    setHop(f.name)
    setErr(null)
    try {
      const r = await callTool('explore_network', { fund: f.name, run_id: d.run_id }, 200_000)
      if (r.isError || r.structuredContent?.view !== 'network') throw new Error(r.content?.[0]?.text || 'Cala did not answer')
      setStack([...stack, r.structuredContent as NetworkData])
    } catch (e) {
      setErr(`Could not walk out from ${f.name}: ${(e as Error).message}`)
    }
    setHop(null)
  }

  const draft = async (f: Fund, door: string) => {
    setBusy(true)
    const got = await writeAsk({ run_id: d.run_id, lead: f.name, company: d.company })
    if (got) {
      setAsk({ key: f.key, data: got })
      setBusy(false)
      return
    }
    const sent = await say(`Draft the intro ask to ${door} about ${f.name} with Soft Yes (run ${d.run_id}), and save it to my drafts.`)
    setBusy(false)
    if (!sent) setErr(`Ask in the chat: “Draft the intro ask to ${door} about ${f.name}.”`)
  }

  const hopped = stack.length > 1
  const title = hopped ? `One hop from ${d.softs.map((s) => s.name).join(', ')}` : 'Your network, through Cala'
  const others = everyone.length
  return (
    <div class="card card--net" ref={ref}>
      <Head
        title={title}
        sub={<>{listAnd(softs)} {softs.length === 1 ? 'has' : 'have'} sat in <b>{net.rounds.length + net.more}</b> rounds with <b>{others}</b> other investors. Each line is a round in Cala’s graph.</>}
        right={<>
          {(hopped || onBack) && <button type="button" class="tool" onClick={() => (hopped ? setStack(stack.slice(0, -1)) : onBack?.())}><Icon name="back" size={14} />Back</button>}
          {canExpand && <button type="button" class="tool" onClick={onExpand}><Icon name="expand" size={14} />Expand</button>}
        </>}
      />
      <Ledger cells={[
        { kind: 'cala', label: 'Rounds in Cala’s graph', value: <Count to={net.rounds.length + net.more} run={inn} />, note: 'rounds' },
        { kind: 'cala', label: 'One round away', value: <Count to={others} run={inn} />, note: 'investors' },
        { kind: 'page', label: 'Led, by the page', value: <Count to={everyone.filter((f) => f.proven > 0).length} run={inn} />, note: `of ${everyone.filter((f) => f.led > 0).length} Cala flags` },
        { kind: 'model', label: 'From a language model', value: <span class="num">0</span>, note: 'facts' },
      ]} />

      <div class="bar">
        <Seg label="Who to show" value={mode} onChange={(m) => { setMode(m); setSel(null) }}
          options={[{ id: 'led', label: 'Led a round', count: everyone.filter((f) => f.led > 0).length }, { id: 'all', label: 'Everyone', count: everyone.length }]} />
        {softSel != null && <button type="button" class="more" onClick={() => setSoftSel(null)}>All of your investors</button>}
      </div>

      {hop ? (
        <div class="stage stage--wait" aria-busy="true">
          <ul class="wait">
            <li><Icon name="cala" size={12} /><b>Asking Cala</b><span>for the rounds {hop} joined, and who sat in them</span></li>
            {[0, 1, 2].map((i) => <li key={i}><i class="skel" style={{ width: `${50 + i * 12}%` }} /></li>)}
          </ul>
        </div>
      ) : shown.length === 0 ? (
        <p class="empty">{mode === 'led' ? 'Cala flags no lead in the rounds these investors joined. Switch to Everyone.' : 'Cala lists no round these investors joined with someone else.'}</p>
      ) : (
        <div class="stage">
          <div class={`g g--net${inn ? ' is-in' : ''}${wide ? '' : ' g--narrow'}`} style={{ height: `${H}px` }}>
            <svg class="g__links" width={W} height={H} aria-hidden="true">
              {shown.flatMap((f, fi) => [...f.doors.entries()].map(([m, rs]) => {
                const on = current ? f.idx === current.idx : true
                const dim = softSel != null && softSel !== m
                return (
                  <path key={`${f.idx}:${m}`} pathLength={1} d={curve(col.i[1] + 5, y(softs.length, m, rowI), col.f[0] - 5, y(shown.length, fi, rowF))}
                    class={`lk lk--n${on && !dim ? ' is-on' : ''}`} style={{ '--d': `${fi * 45}ms`, strokeWidth: `${1 + Math.min(3, rs.length - 1) * 0.6}px` }} />
                )
              }))}
            </svg>
            <span class="g__h" style={{ left: 0, width: `${col.i[1]}px`, textAlign: 'right' }}>{hopped ? 'From' : 'Your investors'}</span>
            <span class="g__h" style={{ left: `${col.f[0]}px` }}>One round away</span>
            <span class="g__h g__h--r" style={{ right: 0 }}>{wide ? 'Shared rounds' : 'Rounds'}</span>
            {softs.map((name, i) => (
              <button key={name} type="button" class={`n n--soft${softSel === i ? ' is-sel' : ''}${current && !current.doors.has(i) ? ' is-dim' : ''}`}
                style={{ top: `${y(softs.length, i, rowI) - rowI / 2}px`, height: `${rowI}px`, left: 0, width: `${col.i[1]}px`, '--i': i }}
                onClick={() => { setSoftSel(softSel === i ? null : i); setSel(null) }} aria-pressed={softSel === i}>
                <span class="n__t"><b class="n__name">{name}</b><span class="n__sub">{d.softs[i]?.rounds != null ? `${num(d.softs[i].rounds)} rounds in Cala` : 'in Cala'}</span></span>
                <i class="n__dot" />
              </button>
            ))}
            {shown.map((f, i) => (
              <button key={f.idx} type="button" class={`n n--fund${current?.idx === f.idx ? ' is-sel' : ''}`} aria-pressed={current?.idx === f.idx}
                style={{ top: `${y(shown.length, i, rowF) - rowF / 2}px`, height: `${rowF}px`, left: `${col.f[0]}px`, width: `${col.f[1] - col.f[0]}px`, '--i': i }}
                onClick={() => pick(f)}>
                <i class="n__dot" />
                <span class="n__t"><b class="n__name">{f.name}</b></span>
                <span class="n__meta num">
                  {f.led > 0 && <em class={f.proven ? 'good' : ''}>{wide ? `led ${f.led}` : `L${f.led}`}</em>}
                  {f.rounds.length}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {current && !hop && (
        <section class="door" key={current.idx}>
          <div class="door__head">
            <h2>{current.name}</h2>
            {leadKeys.get(current.key)?.now && <span class="pill pill--now"><i />Leading now</span>}
          </div>
          <p class="door__sum">
            In {plural(current.rounds.length, 'round')} with {softs.length === 1 ? softs[0] : 'your investors'}
            {current.led > 0 ? <>, led {current.led} of them{current.proven ? <> (<span class="good">{current.proven} confirmed on the page</span>)</> : null}</> : ', led none of them'}.
          </p>
          <ul class="door__list">
            {[...current.doors.entries()].sort((a, b) => b[1].length - a[1].length).map(([m, rs]) => (
              <li key={m}>
                <span class="door__who"><Icon name="door" size={13} /><b>{net.names[m]}</b></span>
                <span class="door__rounds">{rs.slice(0, 3).map((ri) => roundWords(net, ri)).join(' · ')}{rs.length > 3 ? ` · +${rs.length - 3} more` : ''}</span>
              </li>
            ))}
          </ul>
          {ask?.key === current.key ? <div class="ask"><DraftBody data={ask.data} onClose={() => setAsk(null)} /></div> : (
          <div class="acts">
            {leadKeys.has(current.key) && !hopped && current.doors.size > 0 && (
              <Btn kind="main" icon="mail" busy={busy}
                onClick={() => draft(current, net.names[[...current.doors.entries()].sort((a, b) => b[1].length - a[1].length)[0][0]])}>
                Draft the ask
              </Btn>
            )}
            <Btn icon="hop" onClick={() => walkOut(current)}>One hop from {current.name.split(' ').slice(0, 2).join(' ')}</Btn>
          </div>
          )}
        </section>
      )}
      {err && <p class="banner">{err}</p>}

      <footer class="foot">
        <div class="foot__l">
          {pool.length > shown.length && <span class="foot__n">{shown.length} of {pool.length} shown{canExpand ? '' : ''}</span>}
        </div>
        <Link href={d.url} class="foot__r">Every round and source</Link>
      </footer>
    </div>
  )
}
