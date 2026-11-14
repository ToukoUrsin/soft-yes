import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { type HostContext, type ToolResult, applyHost, askDisplay, callTool, connect, on, reportSize } from './bridge'
import { Claim, Draft, Tracker } from './cards'
import type { Data, NetworkData, WalkData } from './lib'
import { Network } from './network'
import { Head } from './ui'
import { Walk, WalkWait } from './walk'

function progressKey(args: any): string {
  // the same key the server makes from what the assistant asked for
  const norm = (s: string) => (s.toLowerCase().match(/[a-z0-9åäöüéèñøæ]+/g) || []).join('')
  const names = [
    ...((args?.soft_yeses as any[]) || []).map((s) => String(s?.investor || s?.name || '')),
    ...((Array.isArray(args?.investors) ? args.investors : args?.investors ? [args.investors] : []) as any[]).map(String),
  ]
  const set = [...new Set(names.filter(Boolean).map(norm))].sort()
  return `${set.join('|')}|${norm(String(args?.company || ''))}|${String(args?.stage || '').toLowerCase()}`.replace(/[^a-z0-9|]+/g, '')
}

function networkOf(w: WalkData, focus?: string): NetworkData {
  return {
    view: 'network', run_id: w.run_id, url: w.url, company: w.company, focus: focus ?? null, path: [],
    softs: w.softs.map((s) => ({ key: s.key, name: s.name, rounds: s.rounds, led: s.led, followed: s.followed })),
    leads: w.leads.map((l) => ({ key: l.key, name: l.name, rank: l.rank, now: l.now })),
    ledger: w.ledger, net: w.net,
  }
}

function Wait({ tool, args, progress }: { tool: string; args: any; progress: any }) {
  if (tool === 'find_lead' || (!tool && (args?.investors || args?.soft_yeses))) return <WalkWait args={args} progress={progress} />
  const title = tool === 'explore_network' ? 'Reading the network from Cala' : tool === 'draft_intro' ? 'Writing the ask from checked facts'
    : tool === 'round_tracker' ? 'Opening the round' : tool === 'check_claim' ? 'Reading the page Cala cites' : 'Soft Yes'
  return (
    <div class="card" aria-busy="true">
      <Head title={title} />
      <div class="stage stage--wait">
        <ul class="wait">{[0, 1, 2, 3].map((i) => <li key={i}><i class="skel" style={{ width: `${44 + ((i * 19) % 36)}%` }} /></li>)}</ul>
      </div>
    </div>
  )
}

function App() {
  const [ctx, setCtx] = useState<HostContext>({})
  const [args, setArgs] = useState<any>(null)
  const [data, setData] = useState<Data | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const [progress, setProgress] = useState<any>(null)
  const [side, setSide] = useState<NetworkData | null>(null)   // the network opened from inside the walk
  const got = useRef(false)
  const [fit, setFit] = useState(0)   // how far the card has drawn itself in to stay under the height the chat gives it
  const touched = useRef(false)

  useEffect(() => {
    on('ui/notifications/tool-input', (p) => setArgs(p?.arguments ?? {}))
    on('ui/notifications/tool-input-partial', (p) => setArgs((a: any) => a ?? p?.arguments ?? null))
    on('ui/notifications/tool-result', (p: ToolResult) => {
      got.current = true
      const sc = p?.structuredContent
      if (p?.isError || !sc?.view) setFail(p?.content?.find((c) => c.type === 'text')?.text || 'Soft Yes returned nothing to draw.')
      else { setFail(null); setSide(null); setData(sc as Data) }
    })
    on('ui/notifications/tool-cancelled', () => { got.current = true; setFail('This was stopped before Cala answered.') })
    on('ui/notifications/host-context-changed', (p) => setCtx((c) => { const next = { ...c, ...p }; applyHost(next); return next }))
    on('ui/resource-teardown', () => undefined)
    connect().then((c) => { applyHost(c); setCtx(c) }).catch(() => setFail('This card needs a chat that draws MCP Apps.'))
    const root = document.getElementById('app')!
    return reportSize(root, () => document.documentElement.dataset.mode !== 'fullscreen')
  }, [])

  const tool = ctx.toolInfo?.tool?.name || ''
  const cardId = ctx.toolInfo?.id != null ? String(ctx.toolInfo.id) : ''   // one per call the assistant made
  // while the walk is out, ask the server how far it has got
  useEffect(() => {
    if (data || fail || !args || (tool && tool !== 'find_lead')) return
    const key = progressKey(args)
    let live = true
    const poll = async () => {
      if (!live || got.current) return
      try {
        const r = await callTool('walk_progress', { key }, 8000)
        if (live && r.structuredContent?.state && r.structuredContent.state !== 'none') setProgress(r.structuredContent)
      } catch { /* a host that keeps the card from calling tools: the plain wait is shown */ }
      if (live && !got.current) window.setTimeout(poll, 1200)
    }
    const t = window.setTimeout(poll, 900)
    return () => { live = false; clearTimeout(t) }
  }, [args, data, fail, tool])

  const full = ctx.displayMode === 'fullscreen'
  const canExpand = !full && (ctx.availableDisplayModes || []).includes('fullscreen')
  const expand = () => { askDisplay('fullscreen') }
  const maxH = ctx.containerDimensions?.maxHeight
  useEffect(() => {
    const mark = () => { touched.current = true }
    window.addEventListener('pointerdown', mark, true)
    return () => window.removeEventListener('pointerdown', mark, true)
  }, [])
  useEffect(() => {
    // a chat clips a card taller than it allows: until the person opens something, draw less rather than be cut
    if (full || !maxH) { setFit(0); return }
    const root = document.getElementById('app')!
    const ro = new ResizeObserver(() => {
      if (!touched.current && root.getBoundingClientRect().height > maxH + 1) setFit((f) => Math.min(2, f + 1))
    })
    ro.observe(root)
    return () => ro.disconnect()
  }, [full, maxH])
  const level = full ? 0 : Math.max(fit, maxH && maxH < 620 ? 1 : 0, maxH && maxH < 460 ? 2 : 0)

  if (fail) {
    return (
      <div class="card card--fail" role="alert">
        <Head title="Soft Yes could not finish" sub={fail} />
      </div>
    )
  }
  if (!data) return <Wait tool={tool} args={args} progress={progress} />
  if (side) return <Network data={side} roomy={full} canExpand={canExpand} onExpand={expand} onBack={() => setSide(null)} />
  switch (data.view) {
    case 'walk':
      return <Walk data={data} cardId={cardId} roomy={full} fit={level} canExpand={canExpand} onExpand={expand}
        onNetwork={(focus) => setSide(networkOf(data, focus))} />
    case 'network':
      return <Network data={data} roomy={full} canExpand={canExpand} onExpand={expand} />
    case 'draft':
      return <Draft data={data} />
    case 'tracker':
      return <Tracker data={data} />
    case 'claim':
      return <Claim data={data} />
  }
  return null
}

render(<App />, document.getElementById('app')!)
