// The card's side of MCP Apps (SEP-1865): JSON-RPC 2.0 with the chat host over postMessage.
// Written by hand: the SDK's ready-made bundle is half a megabyte, and this card needs a dozen messages.

export interface HostContext {
  theme?: 'light' | 'dark'
  displayMode?: 'inline' | 'fullscreen' | 'pip'
  availableDisplayModes?: string[]
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number }
  platform?: 'web' | 'desktop' | 'mobile'
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number }
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } }
  toolInfo?: { tool?: { name?: string } }
  locale?: string
}

export interface ToolResult {
  content?: { type: string; text?: string }[]
  structuredContent?: any
  isError?: boolean
}

type Handler = (params: any) => void

let seq = 1
const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void; timer: number }>()
const handlers = new Map<string, Handler>()
export const host = { connected: false, capabilities: {} as any, info: {} as any }

function post(msg: object) {
  window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*')
}

export function request<T = any>(method: string, params: object = {}, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((ok, no) => {
    const id = seq++
    const timer = window.setTimeout(() => {
      waiting.delete(id)
      no(new Error(`${method}: no answer`))
    }, timeoutMs)
    waiting.set(id, { ok, no, timer })
    post({ id, method, params })
  })
}

export function notify(method: string, params: object = {}) {
  post({ method, params })
}

export function on(method: string, fn: Handler) {
  handlers.set(method, fn)
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent) return
  const m = ev.data
  if (!m || m.jsonrpc !== '2.0') return
  if (m.method === undefined) {
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    clearTimeout(w.timer)
    if (m.error) w.no(new Error(m.error.message || 'The host refused'))
    else w.ok(m.result)
    return
  }
  if (m.id !== undefined) {
    // a request from the host: ping, or being told the card is about to be closed
    post({ id: m.id, result: {} })
    handlers.get(m.method)?.(m.params)
    return
  }
  handlers.get(m.method)?.(m.params)
})

export async function connect(): Promise<HostContext> {
  const r = await request<any>('ui/initialize', {
    appInfo: { name: 'Soft Yes', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: '2026-01-26',
  }, 15_000)
  host.connected = true
  host.capabilities = r?.hostCapabilities || {}
  host.info = r?.hostInfo || {}
  notify('ui/notifications/initialized')
  return r?.hostContext || {}
}

/** Calls one of this connector's own tools through the host. */
export async function callTool(name: string, args: object, timeoutMs = 120_000): Promise<ToolResult> {
  return request<ToolResult>('tools/call', { name, arguments: args }, timeoutMs)
}

/** Says something in the chat as the person, so the assistant acts on it. False when the host does not take it. */
export async function say(text: string): Promise<boolean> {
  try {
    const r = await request<any>('ui/message', { role: 'user', content: [{ type: 'text', text: text.slice(0, 7800) }] }, 30_000)
    return !r?.isError
  } catch {
    return false
  }
}

/** Tells the assistant what the person is looking at, without a new message. */
export function tell(text: string) {
  request('ui/update-model-context', { content: [{ type: 'text', text: text.slice(0, 3800) }] }, 10_000).catch(() => undefined)
}

export async function openLink(url: string) {
  try {
    const r = await request<any>('ui/open-link', { url }, 30_000)
    if (r?.isError) throw new Error('refused')
  } catch {
    try {
      window.open(url, '_blank', 'noopener')
    } catch {
      /* a sandbox without popups: nothing more to try */
    }
  }
}

export async function askDisplay(mode: 'inline' | 'fullscreen'): Promise<string | null> {
  try {
    const r = await request<any>('ui/request-display-mode', { mode }, 10_000)
    return r?.mode || null
  } catch {
    return null
  }
}

/** Keeps the host told how tall the card is, so nothing scrolls inside it. */
export function reportSize(el: HTMLElement, active: () => boolean) {
  let last = 0
  let frame = 0
  const send = () => {
    frame = 0
    if (!active()) return
    const h = Math.ceil(el.getBoundingClientRect().height)
    if (h && Math.abs(h - last) >= 1) {
      last = h
      notify('ui/notifications/size-changed', { width: Math.ceil(window.innerWidth), height: h })
    }
  }
  const queue = () => {
    if (!frame) frame = requestAnimationFrame(send)
  }
  new ResizeObserver(queue).observe(el)
  window.addEventListener('resize', queue)
  queue()
  return () => {
    last = 0
    queue()
  }
}

export function applyHost(ctx: HostContext) {
  const root = document.documentElement
  if (ctx.theme) {
    root.dataset.theme = ctx.theme
    root.style.colorScheme = ctx.theme
  }
  for (const [k, v] of Object.entries(ctx.styles?.variables || {})) {
    if (v) root.style.setProperty(k, v)
  }
  const fonts = ctx.styles?.css?.fonts
  if (fonts && !document.getElementById('host-fonts')) {
    const s = document.createElement('style')
    s.id = 'host-fonts'
    s.textContent = fonts
    document.head.appendChild(s)
  }
  const pad = ctx.safeAreaInsets
  if (pad) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) root.style.setProperty(`--safe-${side}`, `${pad[side] || 0}px`)
  }
  if (ctx.displayMode) root.dataset.mode = ctx.displayMode
  if (ctx.platform) root.dataset.platform = ctx.platform
}
