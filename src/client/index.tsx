/**
 * dsh-maestro-sync — client Settings tab
 * React card in Settings slot, shows remoteHost, lastSync, Dry-run / Pull merge / Push merge
 * Calls host via connection.rpc.call('/dsh-maestro-sync', method, payload)
 */
import * as React from 'react'
import { SyncDashboard } from './dashboard.js'

export const inject = ['slots', 'connection'] as const

const RPC_CHANNEL = '/dsh-maestro-sync'

const SYNC_CSS = `
.sync-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:16px; display:flex; flex-direction:column; gap:12px; }
.sync-header { display:flex; align-items:center; gap:10px; }
.sync-title { font-size:14px; font-weight:700; letter-spacing:-0.01em; }
.sync-subtitle { color:var(--dsw-alias-label-secondary); font-size:12px; }
.sync-kicker { text-transform:uppercase; letter-spacing:0.04em; font-size:11px; color:var(--dsw-alias-label-secondary); font-weight:600; }
.sync-row { display:flex; gap:12px; flex-wrap:wrap; }
.sync-field { flex:1 1 160px; min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); padding:8px 10px; }
.sync-field-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.sync-field-value { font-size:13px; font-weight:600; word-break:break-all; }
.sync-btn { min-height:44px; padding:0 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); display:inline-flex; align-items:center; justify-content:center; gap:6px; font:inherit; font-size:13px; cursor:pointer; font-weight:500; }
.sync-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.sync-btn:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
.sync-btn:disabled { opacity:0.5; cursor:not-allowed; }
.sync-btn-primary { background:#2563EB; color:#fff; border-color:#2563EB; }
.sync-btn-primary:hover { background:#1D4ED8; border-color:#1D4ED8; color:#fff; }
.sync-pre { white-space:pre-wrap; word-break:break-word; font-size:12px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; max-height:200px; overflow:auto; }
.sync-muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
@media (prefers-reduced-motion: reduce) { .sync-btn { transition:none !important; } }
`

function formatLastSync(v: string | null): string {
  if (!v) return 'never'
  try {
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return v
    return d.toLocaleString()
  } catch {
    return v
  }
}

function SyncPanel({ ctx }: { ctx: any }): React.ReactElement {
  const [remoteHost, setRemoteHost] = React.useState<string>('…')
  const [lastSync, setLastSync] = React.useState<string | null>(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-maestro-sync:lastSync') : null
    } catch {
      return null
    }
  })
  const [status, setStatus] = React.useState<any>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<any>(null)
  const [error, setError] = React.useState<string>('')

  const call = React.useCallback(
    (method: string, payload: any): Promise<any> => {
      const conn = (ctx as any).connection ?? (ctx as any).get?.('connection')
      if (!conn?.rpc?.call) return Promise.reject(new Error('RPC not available'))
      return conn.rpc.call(RPC_CHANNEL, method, payload) as Promise<any>
    },
    [ctx],
  )

  const loadStatus = React.useCallback(async () => {
    setError('')
    try {
      const res: any = await call('status', {})
      // host returns {ok:true, ...statusFields} or {ok:false, error}
      const data = res?.ok === true ? res : res?.ok === false ? res : { ok: true, ...res }
      if (data?.ok === false) {
        setError(data?.error ?? 'status failed')
        return
      }
      setStatus(data)
      // derive remoteHost if present; otherwise keep default
      const rh = (data as any).remoteHost ?? (data as any).remote ?? (data as any).remoteHostName
      if (typeof rh === 'string' && rh) setRemoteHost(rh)
      else if (remoteHost === '…') setRemoteHost('dsh-remote')
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [call, remoteHost])

  React.useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const persistLastSync = React.useCallback((ts: string) => {
    setLastSync(ts)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-maestro-sync:lastSync', ts)
    } catch {}
  }, [])

  const handleDryRun = React.useCallback(async () => {
    setBusy('dry')
    setError('')
    setResult(null)
    try {
      const res: any = await call('pull', { dryRun: true })
      setResult(res)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [call])

  const handlePull = React.useCallback(async () => {
    setBusy('pull')
    setError('')
    setResult(null)
    try {
      const res: any = await call('pull', { dryRun: false })
      setResult(res)
      if (res?.ok !== false) persistLastSync(new Date().toISOString())
      await loadStatus()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [call, loadStatus, persistLastSync])

  const handlePush = React.useCallback(async () => {
    setBusy('push')
    setError('')
    setResult(null)
    try {
      const res: any = await call('push', { dryRun: false })
      setResult(res)
      if (res?.ok !== false) persistLastSync(new Date().toISOString())
      await loadStatus()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [call, loadStatus, persistLastSync])

  const counts = status
    ? `${status.localOnly ?? 0} local-only · ${status.remoteOnly ?? 0} remote-only · ${status.both ?? 0} both`
    : '—'

  return React.createElement(
    'div',
    { className: 'sync-card' },
    React.createElement('style', null, SYNC_CSS),
    React.createElement(
      'div',
      { className: 'sync-header' },
      React.createElement(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        React.createElement('div', { className: 'sync-title' }, 'Sync'),
        React.createElement('div', { className: 'sync-subtitle' }, 'Merge memories & sessions between dsh-home ↔ dsh-company (no --delete)'),
      ),
      React.createElement(
        'button',
        { type: 'button', onClick: loadStatus, className: 'sync-btn', 'aria-label': 'Refresh status', disabled: !!busy },
        'Refresh',
      ),
    ),
    React.createElement(
      'div',
      { className: 'sync-row' },
      React.createElement(
        'div',
        { className: 'sync-field' },
        React.createElement('div', { className: 'sync-field-label' }, 'Remote host'),
        React.createElement('div', { className: 'sync-field-value', 'data-testid': 'sync-remote-host' }, remoteHost),
      ),
      React.createElement(
        'div',
        { className: 'sync-field' },
        React.createElement('div', { className: 'sync-field-label' }, 'Last sync'),
        React.createElement('div', { className: 'sync-field-value', 'data-testid': 'sync-last-sync' }, formatLastSync(lastSync)),
      ),
    ),
    React.createElement('div', { className: 'sync-muted', 'data-testid': 'sync-counts' }, counts),
    status?.bothFiles?.length
      ? React.createElement('div', { className: 'sync-muted' }, `both: ${(status.bothFiles as string[]).slice(0, 5).join(', ')}${(status.bothFiles as string[]).length > 5 ? ' …' : ''}`)
      : null,
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: handleDryRun,
          className: 'sync-btn',
          disabled: !!busy,
          'data-testid': 'sync-dry-run',
        },
        busy === 'dry' ? 'Running…' : 'Dry-run',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: handlePull,
          className: 'sync-btn sync-btn-primary',
          disabled: !!busy,
          'data-testid': 'sync-pull',
        },
        busy === 'pull' ? 'Pulling…' : 'Pull merge',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: handlePush,
          className: 'sync-btn',
          disabled: !!busy,
          'data-testid': 'sync-push',
        },
        busy === 'push' ? 'Pushing…' : 'Push merge',
      ),
    ),
    error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error) : null,
    result
      ? React.createElement('pre', { className: 'sync-pre', 'data-testid': 'sync-result' }, JSON.stringify(result, null, 2))
      : null,
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => {
          try {
            window.dispatchEvent(new CustomEvent('maestro-sync:open-dashboard'))
          } catch {}
        },
        className: 'sync-btn',
        style: { marginTop: 4 },
        'data-testid': 'sync-open-dashboard-from-card',
      },
      'Open Sync Dashboard →',
    ),
    React.createElement('div', { className: 'sync-muted' }, 'Dry-run previews without writing. Pull fetches remote → local, Push sends local → remote. Merge is union by stripId (§).'),
  )
}

function SyncTrigger({ onOpen }: { onOpen: () => void }): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      onClick: onOpen,
      className: 'sync-btn',
      style: { width: '100%', justifyContent: 'flex-start' },
      'aria-label': 'Open Sync Dashboard',
      'data-testid': 'sync-open-dashboard',
    },
    'Sync',
  )
}

export function apply(ctx: any): void {
  const slots = (ctx as any).slots ?? (ctx as any).get?.('slots')
  if (!slots?.inject || !slots?.register) return
  // Settings card (summary) — stays in Settings page
  ctx.effect(
    () => {
      const dispose = slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'maestro-sync', order: 26, label: () => 'Sync' },
          () => React.createElement(SyncPanel, { ctx }),
        ),
      )
      return () => {
        try {
          ;(dispose as any)?.()
        } catch {}
      }
    },
    'maestro-sync: settings',
  )
  // Dashboard tab — sidebar footer + overlay (full-page, Minimalism & Swiss)
  ctx.effect(
    () => {
      let open = false
      let setOpen: ((v: boolean) => void) | null = null
      const TriggerWrap = () =>
        React.createElement(SyncTrigger, {
          onOpen: () => {
            open = true
            setOpen?.(true)
          },
        })
      const OverlayWrap = () => {
        const [isOpen, setIsOpen] = React.useState(open)
        React.useEffect(() => {
          setOpen = setIsOpen
          const handler = () => setIsOpen(true)
          try {
            window.addEventListener('maestro-sync:open-dashboard', handler as any)
          } catch {}
          return () => {
            setOpen = null
            try {
              window.removeEventListener('maestro-sync:open-dashboard', handler as any)
            } catch {}
          }
        }, [setIsOpen])
        if (!isOpen) return null
        return React.createElement(SyncDashboard, { ctx, onClose: () => setIsOpen(false) })
      }
      const d1 = slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'maestro-sync-trigger', order: 40, label: () => 'Sync' }, () => React.createElement(TriggerWrap)))
      const d2 = slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'maestro-sync-dashboard', order: 40 }, () => React.createElement(OverlayWrap)))
      return () => {
        try {
          ;(d1 as any)?.()
          ;(d2 as any)?.()
        } catch {}
      }
    },
    'maestro-sync: dashboard',
  )
}

export default { inject, apply }
