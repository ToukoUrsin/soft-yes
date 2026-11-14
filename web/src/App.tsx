import { useEffect, useRef } from 'react'
import { Link, Route, Switch, useLocation } from 'wouter'
import { Mark } from './components/ui'
import { useConfig } from './lib/store'
import { AuditPage } from './pages/Audit'
import { Home } from './pages/Home'
import { InvestorPage } from './pages/Investor'
import { Run } from './pages/Run'

function NotFound() {
  return (
    <main className="page run">
      <div className="state">
        <strong>There is nothing at this address.</strong>
        <span>The link may be mistyped. A walk starts from the investors who said yes.</span>
        <Link className="btn" href="/">Start a walk</Link>
      </div>
    </main>
  )
}

export function App() {
  const [path] = useLocation()
  const check = useConfig()?.framing === 'investor_check'
  const findHref = check ? '/find' : '/'
  const checkHref = check ? '/' : '/investor'
  const onAudit = path.startsWith('/audit')
  const onCheck = path.startsWith('/investor') || (check && path === '/')

  // A new page starts at its top. A walk taking its permalink is the same page.
  const prev = useRef(path)
  useEffect(() => {
    if (prev.current !== '/r/live') window.scrollTo(0, 0)
    prev.current = path
  }, [path])

  return (
    <>
      <header className="topbar">
        <div className="page topbar__in">
          <Link href="/" className="wordmark" aria-label="Soft Yes, start page">
            <Mark />
            <span className="wordmark__name">Soft Yes</span>
          </Link>
          <nav className="topnav" aria-label="Main">
            <Link href={findHref} aria-current={!onCheck && !onAudit ? 'page' : undefined}>Find a lead</Link>
            <Link href={checkHref} aria-current={onCheck ? 'page' : undefined}>Investor check</Link>
            <Link href="/audit" aria-current={onAudit ? 'page' : undefined}>Page check</Link>
          </nav>
        </div>
      </header>
      <Switch>
        <Route path="/"><Home /></Route>
        <Route path="/find"><Home mode="find" /></Route>
        <Route path="/investor"><Home mode="check" /></Route>
        <Route path="/investor/:ids"><InvestorPage /></Route>
        <Route path="/audit"><AuditPage /></Route>
        <Route path="/r/:runId"><Run /></Route>
        <Route><NotFound /></Route>
      </Switch>
    </>
  )
}
