/**
 * dsh-maestro-sync — Settings section (confirmation-first preview/apply UI).
 * - Preview is read-only: it stages and plans, then opens a confirmation dialog
 *   that names direction, host, plan age and exact action counts.
 * - Apply is only reachable inside that dialog, bound to the preview id, with
 *   {confirm:true}. Escape cancels; nothing applies without confirmation.
 * - aria-live="polite" for progress/results, role="alert" for errors, aria-busy
 *   while requests run, accessible full file names for truncated paths, token
 *   colors, and "Show more" pagination for long lists.
 * No sidebar button, no dashboard overlay.
 */
import * as React from 'react'

export const inject = ['slots', 'connection'] as const

const RPC_CHANNEL = '/dsh-maestro-sync'

// Shared Maestro mark — same as dsh-maestro-config / dashboard BrandMark
const SETTINGS_NAV_MARKER = 'data-maestro-sync-settings-nav'
const SETTINGS_NAV_CSS = `
[${SETTINGS_NAV_MARKER}] > svg:first-child,
[${SETTINGS_NAV_MARKER}] > svg.zWKi1a_navIcon {
  display: none !important;
}
[${SETTINGS_NAV_MARKER}]::before {
  content: '';
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-block;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 11 L5 4 L8 9 L11 4 L14 11'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 11 L5 4 L8 9 L11 4 L14 11'/%3E%3C/svg%3E") center / contain no-repeat;
}
`

function registerSyncNavIcon(label: () => string, root?: any): () => void {
  if (typeof document === 'undefined' && root === undefined) return () => {}
  const scope: any = root ?? document
  let disposed = false
  const sync = () => {
    if (disposed) return
    const currentLabel = label().trim()
    const buttons = scope.querySelectorAll('[role="dialog"] nav button')
    for (const button of Array.from(buttons as any) as Element[]) {
      const el = button as any
      const matches = currentLabel.length > 0 && (button as Element).textContent != null && (button as Element).textContent!.trim() === currentLabel
      if (matches) el.setAttribute(SETTINGS_NAV_MARKER, '')
      else el.removeAttribute(SETTINGS_NAV_MARKER)
    }
  }
  sync()
  let observer: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }
  return () => {
    disposed = true
    if (observer !== null) observer.disconnect()
    for (const element of Array.from(scope.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`) as any)) {
      ;(element as any).removeAttribute(SETTINGS_NAV_MARKER)
    }
  }
}

function installSyncNavIconStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@ddtcorex/dsh-maestro-sync'
  tag.dataset.pluginCss = 'maestro-sync/settings-nav.css'
  tag.textContent = SETTINGS_NAV_CSS
  document.head.appendChild(tag)
  return () => {
    document.querySelector('style[data-plugin-css="maestro-sync/settings-nav.css"]')?.remove()
  }
}

const SYNC_CSS = `
.sync-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:16px; display:flex; flex-direction:column; gap:14px; }
.sync-header { display:flex; align-items:center; gap:10px; }
.sync-title { font-size:14px; font-weight:700; letter-spacing:-0.01em; }
.sync-subtitle { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:16px; margin-top:2px; }
.sync-conn { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.sync-conn-ok { border-color:var(--dsw-alias-border-l1); }
.sync-conn-bad { border-color:var(--dsw-alias-state-error-primary, #DC2626); }
.sync-conn-dot { flex:none; width:8px; height:8px; border-radius:50%; margin-top:5px; }
.sync-conn-dot-ok { background:var(--dsw-alias-state-success-primary, #16A34A); box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-success-primary, #16A34A) 16%, transparent); }
.sync-conn-dot-bad { background:var(--dsw-alias-state-error-primary, #DC2626); box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-error-primary, #DC2626) 12%, transparent); }
.sync-conn-dot-checking { background:var(--dsw-alias-label-secondary); opacity:0.6; }
.sync-conn-main { flex:1; min-width:0; }
.sync-conn-title { font-size:12px; font-weight:600; line-height:16px; }
.sync-conn-desc { font-size:11px; line-height:14px; color:var(--dsw-alias-label-secondary); margin-top:2px; word-break:break-word; }
.sync-fields { display:flex; gap:10px; flex-wrap:wrap; }
.sync-field { flex:1 1 160px; min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); padding:8px 10px; }
.sync-field-label { font-size:11px; color:var(--dsw-alias-label-secondary); font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }
.sync-field-value { font-size:13px; font-weight:600; word-break:break-all; margin-top:2px; }
.sync-stats { display:grid; grid-template-columns:1fr; gap:10px; }
@media(min-width:640px){ .sync-stats{ grid-template-columns:1fr 1fr 1fr; } }
.sync-stat { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-2); padding:12px; display:flex; flex-direction:column; gap:6px; }
.sync-stat-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--dsw-alias-label-secondary); }
.sync-stat-value { font-size:22px; font-weight:700; line-height:1; letter-spacing:-0.02em; }
.sync-stat-desc { font-size:11px; line-height:14px; color:var(--dsw-alias-label-secondary); }
.sync-section { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.sync-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.sync-section-title { font-size:12px; font-weight:600; display:flex; align-items:center; gap:6px; }
.sync-section-count { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:2px 8px; }
.sync-file { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12px; }
.sync-file:last-child{ border-bottom:none; }
.sync-file-title { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:12px; }
.sync-file-path { font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sync-file-meta { flex:none; font-size:11px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:1px 6px; }
.sync-empty { padding:16px 12px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:16px; }
.sync-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.sync-btn { min-height:36px; padding:0 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); display:inline-flex; align-items:center; justify-content:center; gap:6px; font:inherit; font-size:13px; cursor:pointer; font-weight:500; }
.sync-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.sync-btn:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
.sync-btn:disabled { opacity:0.5; cursor:not-allowed; }
/* token-driven primary action — no hardcoded brand color */
.sync-btn-primary { background:var(--dsw-alias-brand-primary, #2563EB); color:#fff; border-color:var(--dsw-alias-brand-primary, #2563EB); }
.sync-btn-primary:hover { opacity:0.92; background:var(--dsw-alias-brand-primary, #1D4ED8); border-color:var(--dsw-alias-brand-primary, #1D4ED8); color:#fff; }
.sync-result { padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); font-size:12px; line-height:16px; }
.sync-result-error { border-color:var(--dsw-alias-state-error-primary, #DC2626); }
.sync-result-error .sync-result-title { color:var(--dsw-alias-state-error-primary, #DC2626); }
.sync-result-title { font-weight:600; margin-bottom:2px; font-size:12px; }
.sync-result-desc { color:var(--dsw-alias-label-secondary); }
.sync-muted { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:14px; }
.sync-show-more { align-self:center; }
/* confirmation dialog */
.sync-dialog-overlay { position:fixed; inset:0; z-index:1000; background:color-mix(in srgb, var(--dsw-alias-bg-layer-0, #000) 55%, transparent); display:flex; align-items:center; justify-content:center; padding:24px; }
.sync-dialog { width:min(560px, 100%); max-height:80vh; overflow:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:14px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 20px 50px rgba(0,0,0,0.35); padding:16px; display:flex; flex-direction:column; gap:12px; }
.sync-dialog-title { font-size:14px; font-weight:700; letter-spacing:-0.01em; }
.sync-dialog-desc { font-size:12px; line-height:16px; color:var(--dsw-alias-label-secondary); }
.sync-dialog-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
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

function formatFile(path: string): { icon: string; title: string; path: string; meta: string } {
  if (path.startsWith('memories/daily/')) {
    const date = path.replace('memories/daily/', '').replace('.md', '')
    try {
      const d = new Date(date)
      if (!isNaN(d.getTime())) return { icon: '📝', title: `Daily notes — ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, path, meta: 'Daily' }
    } catch {}
    return { icon: '📝', title: `Daily notes — ${date}`, path, meta: 'Daily' }
  }
  if (path.startsWith('memories/projects/')) {
    const hash = path.split('/')[2] ?? ''
    return { icon: '📁', title: 'Project memory', path, meta: hash.slice(0, 7) }
  }
  if (path === 'memories/MEMORY.md') return { icon: '⭐', title: 'Global memory', path, meta: 'Global' }
  if (path.startsWith('sessions/')) {
    const hash = path.split('/')[1] ?? ''
    return { icon: '💬', title: 'Session', path, meta: hash.slice(0, 7) }
  }
  return { icon: '📄', title: path.split('/').pop() ?? path, path, meta: path.split('/')[0] ?? '' }
}

/** Exact action label — same-name files are never called "in sync" here. */
function actionLabel(action: any): string {
  switch (action?.action) {
    case 'copy':
      return 'copy'
    case 'merge':
      return `merge +${action.added ?? 0} ${(action.added ?? 0) === 1 ? 'new entry' : 'new entries'}`
    case 'conflict':
      return 'conflict'
    default:
      return 'skip'
  }
}

function humanSummary(status: any): string {
  const localOnly = status?.localOnly ?? 0
  const remoteOnly = status?.remoteOnly ?? 0
  const both = status?.both ?? 0
  if (localOnly === 0 && remoteOnly === 0 && both === 0) return 'No eligible files found on either side.'
  return `${localOnly} only here · ${remoteOnly} only there · ${both} on both (content compared in Preview)`
}

interface PageState {
  files: string[]
  total: number
  next: number | null
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
  const [connection, setConnection] = React.useState<{ ok: boolean; host: string; latencyMs?: number; error?: string } | null>(null)
  const [checking, setChecking] = React.useState<boolean>(true)
  const [busy, setBusy] = React.useState<boolean>(false)
  const [result, setResult] = React.useState<{ kind: string; ok: boolean; text: string } | null>(null)
  const [error, setError] = React.useState<string>('')
  const [preview, setPreview] = React.useState<any>(null)
  const [previewDirection, setPreviewDirection] = React.useState<'pull' | 'push'>('pull')
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [actionLimit, setActionLimit] = React.useState(5)
  const [pages, setPages] = React.useState<{ localOnly: PageState; remoteOnly: PageState }>({
    localOnly: { files: [], total: 0, next: null },
    remoteOnly: { files: [], total: 0, next: null },
  })

  const call = React.useCallback((method: string, payload: any): Promise<any> => {
    const conn = (ctx as any).connection ?? (ctx as any).get?.('connection')
    if (!conn?.rpc?.call) return Promise.reject(new Error('RPC not available'))
    return conn.rpc.call(RPC_CHANNEL, method, payload) as Promise<any>
  }, [ctx])

  const loadPage = React.useCallback(
    async (bucket: 'localOnly' | 'remoteOnly', cursor: number) => {
      try {
        const res: any = await call('status', { bucket, cursor, limit: 10 })
        if (!res?.ok) return
        setPages((prev) => ({
          ...prev,
          [bucket]: {
            files: cursor === 0 ? (res.files ?? []) : [...prev[bucket].files, ...(res.files ?? [])],
            total: res.total ?? prev[bucket].total,
            next: res.nextCursor ?? null,
          },
        }))
      } catch {
        // page load failure is non-fatal
      }
    },
    [call],
  )

  const loadStatus = React.useCallback(async () => {
    // a refresh invalidates previous status/action state (the last announcement
    // stays visible until the next user action)
    setError('')
    setChecking(true)
    setStatus(null)
    try {
      const res: any = await call('status', {})
      if (res?.ok === false) {
        setError(res?.error ?? 'status failed')
        return
      }
      setStatus(res)
      const conn = (res as any)?.connection ?? null
      if (conn) setConnection(conn)
      else setConnection({ ok: true, host: (res as any)?.remoteHost ?? 'kai@ssh.ddtcorex.com' })
      if (typeof (res as any)?.remoteHost === 'string' && (res as any).remoteHost) setRemoteHost((res as any).remoteHost)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setChecking(false)
    }
    await loadPage('localOnly', 0)
    await loadPage('remoteOnly', 0)
  }, [call, loadPage])

  React.useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const persistLastSync = React.useCallback((ts: string) => {
    setLastSync(ts)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-maestro-sync:lastSync', ts)
    } catch {}
  }, [])

  const handlePreview = React.useCallback(
    async (direction: 'pull' | 'push') => {
      setBusy(true)
      setError('')
      setResult(null)
      setActionLimit(5)
      try {
        const res: any = await call('preview', { direction })
        if (res?.ok === false) {
          setError(res?.error ?? 'Preview failed')
          return
        }
        setPreview(res)
        setPreviewDirection(direction)
        setConfirmOpen(true)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      } finally {
        setBusy(false)
      }
    },
    [call],
  )

  const handleApply = React.useCallback(async () => {
    if (!preview?.previewId) return
    setBusy(true)
    setError('')
    const previewId = preview.previewId
    const direction = previewDirection
    try {
      const res: any = await call('apply', { previewId, direction, confirm: true })
      setConfirmOpen(false)
      setPreview(null)
      if (res?.ok === false) {
        const label = typeof res.code === 'string' ? res.code : 'apply failed'
        setError(`${label}: ${res?.error ?? 'apply failed'}`)
        setResult({ kind: 'apply', ok: false, text: 'Apply failed' })
        return
      }
      setResult({ kind: 'apply', ok: true, text: `Applied preview ${previewId.slice(0, 8)} — committed ${(res?.committed ?? []).length} file(s), +${res?.summary?.added ?? 0} entries` })
      persistLastSync(new Date().toISOString())
      void loadStatus()
    } catch (e: any) {
      setConfirmOpen(false)
      setPreview(null)
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [preview, previewDirection, call, loadStatus, persistLastSync])

  const cancelDialog = React.useCallback(() => {
    setConfirmOpen(false)
    setPreview(null)
  }, [])

  React.useEffect(() => {
    if (!confirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmOpen, cancelDialog])

  const isConnected = connection?.ok === true
  const isDisconnected = connection?.ok === false
  const canSync = isConnected && !checking && !busy
  const summary = humanSummary(status)

  const previewActions = (preview?.actions ?? []).slice(0, actionLimit)
  const hasMoreActions = (preview?.actions?.length ?? 0) > actionLimit
  const planAgeSecs = preview?.expiresAt ? Math.max(0, Math.round((new Date(preview.expiresAt).getTime() - Date.now()) / 1000)) : 0

  return React.createElement('div', { className: 'sync-card', 'aria-busy': busy || checking },
    React.createElement('style', null, SYNC_CSS),
    React.createElement('div', { className: 'sync-header', style: { alignItems: 'flex-start' } as any },
      React.createElement('span', {
        'data-maestro-logo': '',
        style: {
          width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--dsw-alias-brand-primary, #0A84FF)', color: '#fff', flex: 'none',
          border: '1px solid rgba(0,0,0,0.08)', boxShadow: '0 0 0 1px var(--dsw-alias-border-l1)', boxSizing: 'border-box' as any, marginTop: 2,
        },
      } as any,
        React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' } as any,
          React.createElement('path', { d: 'M2 11 L5 4 L8 9 L11 4 L14 11', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as any)
        )
      ),
      React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        React.createElement('div', { className: 'sync-title' }, 'Maestro Sync'),
        React.createElement('div', { className: 'sync-subtitle' }, summary),
      ),
      React.createElement('button', { type: 'button', onClick: loadStatus, className: 'sync-btn', disabled: !!busy || checking, 'aria-label': 'Refresh status', style: { marginTop: 2 } as any }, checking ? 'Checking…' : 'Refresh'),
    ),

    // connection banner
    React.createElement('div', { className: `sync-conn ${isDisconnected ? 'sync-conn-bad' : 'sync-conn-ok'}` },
      React.createElement('div', { className: `sync-conn-dot ${checking ? 'sync-conn-dot-checking' : isConnected ? 'sync-conn-dot-ok' : isDisconnected ? 'sync-conn-dot-bad' : 'sync-conn-dot-checking'}` }),
      React.createElement('div', { className: 'sync-conn-main' },
        checking
          ? React.createElement('div', { className: 'sync-conn-title' }, `Checking SSH to ${remoteHost}…`)
          : isConnected
            ? React.createElement(React.Fragment, null,
                React.createElement('div', { className: 'sync-conn-title' }, `Connected to ${connection!.host}${connection!.latencyMs != null ? ` · ${connection!.latencyMs}ms` : ''} · SSH ready`),
                React.createElement('div', { className: 'sync-conn-desc' }, 'Use Preview to see the exact plan — Apply always requires confirmation in this dialog.'),
              )
            : isDisconnected
              ? React.createElement(React.Fragment, null,
                  React.createElement('div', { className: 'sync-conn-title' }, `Cannot reach ${connection!.host} — sync is paused`),
                  React.createElement('div', { className: 'sync-conn-desc' }, connection!.error ? String(connection!.error).slice(0, 220) : 'SSH failed. Check that the host is reachable and your key is loaded.'),
                )
              : React.createElement('div', { className: 'sync-conn-title' }, 'Checking connection…'),
      ),
    ),

    React.createElement('div', { className: 'sync-fields' },
      React.createElement('div', { className: 'sync-field' },
        React.createElement('div', { className: 'sync-field-label' }, 'Remote host'),
        React.createElement('div', { className: 'sync-field-value', 'data-testid': 'sync-remote-host' }, remoteHost),
      ),
      React.createElement('div', { className: 'sync-field' },
        React.createElement('div', { className: 'sync-field-label' }, 'Last sync'),
        React.createElement('div', { className: 'sync-field-value', 'data-testid': 'sync-last-sync' }, formatLastSync(lastSync)),
      ),
    ),

    React.createElement('div', { className: 'sync-stats' },
      React.createElement('div', { className: 'sync-stat' },
        React.createElement('div', { className: 'sync-stat-label' }, 'Only on this machine'),
        React.createElement('div', { className: 'sync-stat-value' }, status ? String(status.localOnly ?? 0) : '—'),
        React.createElement('div', { className: 'sync-stat-desc' }, status?.localOnly ? 'Considered when you push.' : 'Nothing here.'),
      ),
      React.createElement('div', { className: 'sync-stat' },
        React.createElement('div', { className: 'sync-stat-label' }, 'On both machines'),
        React.createElement('div', { className: 'sync-stat-value' }, status ? String(status.both ?? 0) : '—'),
        React.createElement('div', { className: 'sync-stat-desc' }, 'Same path on both sides — content is compared exactly in Preview.'),
      ),
      React.createElement('div', { className: 'sync-stat' },
        React.createElement('div', { className: 'sync-stat-label' }, 'Only on the other machine'),
        React.createElement('div', { className: 'sync-stat-value' }, status ? String(status.remoteOnly ?? 0) : '—'),
        React.createElement('div', { className: 'sync-stat-desc' }, status?.remoteOnly ? 'Considered when you pull.' : 'Nothing there.'),
      ),
    ),

    React.createElement('div', { className: 'sync-actions' },
      React.createElement('button', { type: 'button', onClick: () => handlePreview('pull'), className: 'sync-btn', disabled: !canSync, 'data-testid': 'sync-preview-pull' }, busy ? 'Working…' : 'Preview Pull'),
      React.createElement('button', { type: 'button', onClick: () => handlePreview('push'), className: 'sync-btn', disabled: !canSync, 'data-testid': 'sync-preview-push' }, busy ? 'Working…' : 'Preview Push'),
      React.createElement('span', { className: 'sync-muted', style: { marginLeft: 'auto' } as any }, checking ? 'Checking SSH…' : isConnected ? `SSH ${connection!.host} · ${connection!.latencyMs ?? '—'}ms` : isDisconnected ? 'SSH disconnected' : 'SSH unknown'),
    ),

    // confirmation dialog — the only place apply exists
    confirmOpen && preview
      ? React.createElement('div', { className: 'sync-dialog-overlay' },
          React.createElement('div', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sync-dialog-title', className: 'sync-dialog' },
            React.createElement('div', { id: 'sync-dialog-title', className: 'sync-dialog-title' }, `Apply ${previewDirection} — preview ${String(preview.previewId ?? '').slice(0, 8)}`),
            React.createElement('div', { className: 'sync-dialog-desc' },
              `Host ${remoteHost} · plan ${planAgeSecs}s before expiry · ${preview.summary?.copied ?? 0} copy · ${preview.summary?.merged ?? 0} merge (+${preview.summary?.added ?? 0} added) · ${preview.summary?.skipped ?? 0} skip · ${preview.summary?.conflicts ?? 0} conflict`,
            ),
            React.createElement('div', { className: 'sync-section' },
              previewActions.map((a: any) => {
                const f = formatFile(a.path)
                return React.createElement('div', { key: a.path, className: 'sync-file', 'data-action-row': 'true', title: a.path },
                  React.createElement('div', { className: 'sync-file-main' },
                    React.createElement('div', { className: 'sync-file-title' }, `${f.title} — ${actionLabel(a)}`),
                    React.createElement('div', { className: 'sync-file-path' }, a.path),
                  ),
                  React.createElement('div', { className: 'sync-file-meta' }, a.reason ?? a.action),
                )
              }),
              hasMoreActions
                ? React.createElement('div', { className: 'sync-actions', style: { padding: '10px 12px' } as any },
                    React.createElement('button', { type: 'button', className: 'sync-btn sync-show-more', onClick: () => setActionLimit((n) => n + 5) }, 'Show more'),
                  )
                : null,
            ),
            React.createElement('div', { className: 'sync-dialog-actions' },
              React.createElement('button', { type: 'button', onClick: cancelDialog, className: 'sync-btn', disabled: busy, 'aria-label': 'Cancel' }, 'Cancel'),
              React.createElement('button', { type: 'button', onClick: handleApply, className: 'sync-btn sync-btn-primary', disabled: busy, 'aria-label': `Apply ${previewDirection}` }, busy ? 'Applying…' : `Apply ${previewDirection} — ${preview.summary?.copied ?? 0} copy, ${preview.summary?.merged ?? 0} merge`),
            ),
          ),
        )
      : null,

    // per-bucket file lists (cursor-paged)
    React.createElement('div', { className: 'sync-section' },
      React.createElement('div', { className: 'sync-section-head' },
        React.createElement('div', { className: 'sync-section-title' }, '📥 Coming from the other machine'),
        React.createElement('div', { className: 'sync-section-count' }, `${pages.remoteOnly.files.length}/${pages.remoteOnly.total} files`),
      ),
      isDisconnected
        ? React.createElement('div', { className: 'sync-empty' }, `Cannot check remote — SSH to ${connection!.host} is not connected. Fix SSH then Refresh.`)
        : pages.remoteOnly.files.length === 0 && !checking
          ? React.createElement('div', { className: 'sync-empty' }, 'Nothing to pull — the other machine has no eligible files here.')
          : pages.remoteOnly.files.map((p: string) => {
              const f = formatFile(p)
              return React.createElement('div', { key: p, className: 'sync-file', title: p },
                React.createElement('div', { className: 'sync-file-main' },
                  React.createElement('div', { className: 'sync-file-title' }, f.title),
                  React.createElement('div', { className: 'sync-file-path' }, f.path),
                ),
                React.createElement('div', { className: 'sync-file-meta' }, f.meta),
              )
            }),
      pages.remoteOnly.next != null ? React.createElement('div', { className: 'sync-actions', style: { padding: '8px 12px' } as any },
        React.createElement('button', { type: 'button', className: 'sync-btn sync-show-more', onClick: () => loadPage('remoteOnly', pages.remoteOnly.next!) }, 'Show more'),
      ) : null,
    ),
    React.createElement('div', { className: 'sync-section' },
      React.createElement('div', { className: 'sync-section-head' },
        React.createElement('div', { className: 'sync-section-title' }, '📤 Ready to send'),
        React.createElement('div', { className: 'sync-section-count' }, `${pages.localOnly.files.length}/${pages.localOnly.total} files`),
      ),
      pages.localOnly.files.length === 0 && !checking
        ? React.createElement('div', { className: 'sync-empty' }, 'Nothing to push — this machine has no eligible files here.')
        : pages.localOnly.files.map((p: string) => {
            const f = formatFile(p)
            return React.createElement('div', { key: p, className: 'sync-file', title: p },
              React.createElement('div', { className: 'sync-file-main' },
                React.createElement('div', { className: 'sync-file-title' }, f.title),
                React.createElement('div', { className: 'sync-file-path' }, f.path),
              ),
              React.createElement('div', { className: 'sync-file-meta' }, f.meta),
            )
          }),
      pages.localOnly.next != null ? React.createElement('div', { className: 'sync-actions', style: { padding: '8px 12px' } as any },
        React.createElement('button', { type: 'button', className: 'sync-btn sync-show-more', onClick: () => loadPage('localOnly', pages.localOnly.next!) }, 'Show more'),
      ) : null,
    ),

    // results + errors (announced)
    result ? React.createElement('div', { className: 'sync-result', role: 'status' },
      React.createElement('div', { className: 'sync-result-title' }, result.ok ? 'Apply complete' : 'Apply failed'),
      React.createElement('div', { className: 'sync-result-desc' }, result.text),
    ) : null,
    error ? React.createElement('div', { className: 'sync-result sync-result-error', role: 'alert' },
      React.createElement('div', { className: 'sync-result-title' }, 'Something went wrong'),
      React.createElement('div', { className: 'sync-result-desc' }, error),
    ) : null,
    React.createElement('div', { className: 'sync-muted', style: { textAlign: 'center' } as any }, 'Notes and sessions are merged — never overwritten. Apply always requires confirmation.'),
  )
}

export function apply(ctx: any): void {
  const slots = (ctx as any).slots ?? (ctx as any).get?.('slots')
  if (!slots?.inject || !slots?.register) return
  ctx.effect(() => registerSyncNavIcon(() => 'Maestro Sync'), 'maestro-sync: settings nav icon')
  ctx.effect(installSyncNavIconStyle, 'maestro-sync: settings nav css')
  ctx.effect(() => {
    const dispose = slots.inject('settings.section', () =>
      slots.register({ name: 'settings.section', id: 'maestro-sync', order: 26, label: () => 'Maestro Sync' }, () => React.createElement(SyncPanel, { ctx })),
    )
    return () => {
      try {
        (dispose as any)?.()
      } catch {}
    }
  }, 'maestro-sync: settings')
}

export { SyncPanel }

export default { inject, apply }