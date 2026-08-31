/**
 * dsh-maestro-sync — Settings section only (sidebar + dashboard removed)
 * Shows human-readable sync status inside Settings. No sidebar button, no overlay.
 */
import * as React from 'react'

export const inject = ['slots', 'connection'] as const

const RPC_CHANNEL = '/dsh-maestro-sync'

// Shared Maestro mark — same as dsh-maestro-config / dashboard BrandMark
// Path: M2 11 L5 4 L8 9 L11 4 L14 11 stroke 1.6 — keep in sync per AGENTS.md Branding
const SETTINGS_NAV_MARKER = 'data-maestro-sync-settings-nav'
const SETTINGS_NAV_CSS = `
/* sync: replace the settings-nav fallback gear with the Maestro M-logo glyph — same mark as Maestro */
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
.sync-conn-hint { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:4px 6px; margin-top:6px; display:inline-block; max-width:100%; overflow:auto; }
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
.sync-file-icon { flex:none; width:26px; height:26px; border-radius:7px; display:inline-flex; align-items:center; justify-content:center; font-size:13px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.sync-file-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.sync-file-title { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:12px; }
.sync-file-path { font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sync-file-meta { flex:none; font-size:11px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:1px 6px; }
.sync-empty { padding:16px 12px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:16px; }
.sync-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.sync-btn { min-height:36px; padding:0 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); display:inline-flex; align-items:center; justify-content:center; gap:6px; font:inherit; font-size:13px; cursor:pointer; font-weight:500; }
.sync-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.sync-btn:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
.sync-btn:disabled { opacity:0.5; cursor:not-allowed; }
.sync-btn-primary { background:#2563EB; color:#fff; border-color:#2563EB; }
.sync-btn-primary:hover { background:#1D4ED8; border-color:#1D4ED8; color:#fff; }
.sync-result { padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); font-size:12px; line-height:16px; }
.sync-result-error { border-color:var(--dsw-alias-state-error-primary, #DC2626); }
.sync-result-error .sync-result-title { color:var(--dsw-alias-state-error-primary, #DC2626); }
.sync-result-title { font-weight:600; margin-bottom:2px; font-size:12px; }
.sync-result-desc { color:var(--dsw-alias-label-secondary); }
.sync-muted { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:14px; }
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
  if (path.startsWith('maestro/')) return { icon: '⚙️', title: path.split('/').pop() ?? path, path, meta: 'Maestro' }
  if (path === 'settings.yaml') return { icon: '🔧', title: 'Settings', path, meta: 'Config' }
  return { icon: '📄', title: path.split('/').pop() ?? path, path, meta: path.split('/')[0] ?? '' }
}

function sortForDisplay(files: string[]): string[] {
  const score = (p: string) => {
    if (p.startsWith('sessions/')) return 0
    if (p.startsWith('memories/daily/')) return 1
    if (p.startsWith('memories/projects/')) return 2
    if (p === 'memories/MEMORY.md') return 2
    if (p.startsWith('memories/')) return 3
    if (p.startsWith('maestro/')) return 4
    return 5
  }
  return [...files].sort((a, b) => {
    const sa = score(a), sb = score(b)
    if (sa !== sb) return sa - sb
    return a.localeCompare(b)
  })
}

function humanSummary(status: any): string {
  if (!status) return 'Checking what needs to be synced…'
  const { localOnly = 0, remoteOnly = 0, both = 0 } = status
  if (localOnly === 0 && remoteOnly === 0) return `Everything is in sync — ${both} files match on both machines.`
  if (localOnly > 0 && remoteOnly === 0) return `${localOnly} files only here will be sent when you push.`
  if (remoteOnly > 0 && localOnly === 0) return `${remoteOnly} files only on the other machine will be pulled.`
  return `${localOnly} only here · ${remoteOnly} only there · ${both} already match`
}

function SyncPanel({ ctx }: { ctx: any }): React.ReactElement {
  const [remoteHost, setRemoteHost] = React.useState<string>('…')
  const [lastSync, setLastSync] = React.useState<string | null>(() => {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-maestro-sync:lastSync') : null } catch { return null }
  })
  const [status, setStatus] = React.useState<any>(null)
  const [connection, setConnection] = React.useState<{ ok: boolean; host: string; latencyMs?: number; error?: string } | null>(null)
  const [checking, setChecking] = React.useState<boolean>(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ kind: 'dry' | 'pull' | 'push'; copied: number; merged: number; added: number } | null>(null)
  const [error, setError] = React.useState<string>('')

  const call = React.useCallback((method: string, payload: any): Promise<any> => {
    const conn = (ctx as any).connection ?? (ctx as any).get?.('connection')
    if (!conn?.rpc?.call) return Promise.reject(new Error('RPC not available'))
    return conn.rpc.call(RPC_CHANNEL, method, payload) as Promise<any>
  }, [ctx])

  const loadStatus = React.useCallback(async () => {
    setError(''); setChecking(true)
    try {
      const res: any = await call('status', {})
      // debug: log raw response for diagnosis (visible in browser console)
      try { console.log('[maestro-sync] status raw', JSON.stringify(res).slice(0, 2000)) } catch {}
      const data = res?.ok === true ? res : res?.ok === false ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'status failed'); setChecking(false); return }
      try { console.log('[maestro-sync] status data', JSON.stringify({ remoteHost: (data as any).remoteHost, connection: (data as any).connection, localOnly: (data as any).localOnly, remoteOnly: (data as any).remoteOnly }).slice(0, 2000)) } catch {}
      setStatus(data)
      const conn = (data as any).connection ?? null
      if (conn) setConnection(conn)
      else {
        // fallback: derive from remoteHost
        const rh = (data as any).remoteHost ?? 'kai@ssh.ddtcorex.com'
        setConnection({ ok: true, host: rh })
      }
      const rh = (data as any).remoteHost ?? (data as any).connection?.host ?? (data as any).remote ?? (data as any).remoteHostName
      if (typeof rh === 'string' && rh) setRemoteHost(rh)
      else if (remoteHost === '…') setRemoteHost('kai@ssh.ddtcorex.com')
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setChecking(false) }
  }, [call, remoteHost])

  React.useEffect(() => { void loadStatus() }, [loadStatus])

  const persistLastSync = React.useCallback((ts: string) => {
    setLastSync(ts)
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-maestro-sync:lastSync', ts) } catch {}
  }, [])

  const handleDryRun = React.useCallback(async () => {
    setBusy('dry'); setError(''); setResult(null)
    try {
      const res: any = await call('pull', { dryRun: true })
      const data = res?.ok === false ? res : res?.ok === true ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'Preview failed'); return }
      setResult({ kind: 'dry', copied: data.copied ?? 0, merged: data.merged ?? 0, added: data.added ?? 0 })
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }, [call])

  const handlePull = React.useCallback(async () => {
    setBusy('pull'); setError(''); setResult(null)
    try {
      const res: any = await call('pull', { dryRun: false })
      const data = res?.ok === false ? res : res?.ok === true ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'Pull failed'); return }
      setResult({ kind: 'pull', copied: data.copied ?? 0, merged: data.merged ?? 0, added: data.added ?? 0 })
      if (data?.ok !== false) persistLastSync(new Date().toISOString())
      await loadStatus()
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }, [call, loadStatus, persistLastSync])

  const handlePush = React.useCallback(async () => {
    setBusy('push'); setError(''); setResult(null)
    try {
      const res: any = await call('push', { dryRun: false })
      const data = res?.ok === false ? res : res?.ok === true ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'Push failed'); return }
      setResult({ kind: 'push', copied: data.copied ?? 0, merged: data.merged ?? 0, added: data.added ?? 0 })
      if (data?.ok !== false) persistLastSync(new Date().toISOString())
      await loadStatus()
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }, [call, loadStatus, persistLastSync])

  const summary = humanSummary(status)

  const isConnected = connection?.ok === true
  const isDisconnected = connection?.ok === false
  const canSync = isConnected && !checking && !busy

  return React.createElement('div', { className: 'sync-card' },
    React.createElement('style', null, SYNC_CSS),
    React.createElement('div', { className: 'sync-header', style: { alignItems: 'flex-start' } as any },
      React.createElement('span', {
        'data-maestro-logo': '',
        style: {
          width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--dsw-alias-brand-primary, #0A84FF)', backgroundColor: '#0A84FF', color: '#fff', flex: 'none',
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
    React.createElement('style', null, '[data-maestro-logo]{background:#0A84FF !important; background-color:#0A84FF !important; color:#fff !important;}'),
    // Connection banner — prerequisite for all sync actions
    React.createElement('div', { className: `sync-conn ${isDisconnected ? 'sync-conn-bad' : 'sync-conn-ok'}` },
      React.createElement('div', { className: `sync-conn-dot ${checking ? 'sync-conn-dot-checking' : isConnected ? 'sync-conn-dot-ok' : isDisconnected ? 'sync-conn-dot-bad' : 'sync-conn-dot-checking'}` }),
      React.createElement('div', { className: 'sync-conn-main' },
        checking ? React.createElement('div', { className: 'sync-conn-title' }, `Checking SSH to ${remoteHost}…`)
          : isConnected ? React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'sync-conn-title' }, `Connected to ${connection!.host}${connection!.latencyMs != null ? ` · ${connection!.latencyMs}ms` : ''} · SSH ready`),
              React.createElement('div', { className: 'sync-conn-desc' }, 'Preview, Pull and Push will use this host. If counts look wrong, hit Refresh.'),
            )
          : isDisconnected ? React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'sync-conn-title' }, `Cannot reach ${connection!.host} — sync is paused`),
              React.createElement('div', { className: 'sync-conn-desc' }, connection!.error ? String(connection!.error).slice(0, 220) : 'SSH failed. Check that the host is reachable and your key is loaded.'),
              React.createElement('div', { className: 'sync-conn-hint' }, `ssh -o ConnectTimeout=5 ${connection!.host} "echo ok"`),
              React.createElement('div', { className: 'sync-conn-desc', style: { marginTop: '4px' } as any }, 'Fix: check ~/.ssh/config Host ' + connection!.host + ', ssh-agent, and that the remote ~/.dsh exists.'),
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
    // 3-stat summary — neutral DSH tokens only
    React.createElement('div', { className: 'sync-stats' },
      React.createElement('div', { className: 'sync-stat' },
        React.createElement('div', { className: 'sync-stat-label' }, 'Only on this machine'),
        React.createElement('div', { className: 'sync-stat-value' }, status ? String(status.localOnly ?? 0) : '—'),
        React.createElement('div', { className: 'sync-stat-desc' }, status?.localOnly ? 'Will be sent when you push.' : 'Nothing new here.'),
      ),
      React.createElement('div', { className: 'sync-stat' },
        React.createElement('div', { className: 'sync-stat-label' }, 'Already in sync'),
        React.createElement('div', { className: 'sync-stat-value' }, status ? String(status.both ?? 0) : '—'),
        React.createElement('div', { className: 'sync-stat-desc' }, 'Files matching on both machines.'),
      ),
      React.createElement('div', { className: 'sync-stat' },
        React.createElement('div', { className: 'sync-stat-label' }, 'Only on the other machine'),
        React.createElement('div', { className: 'sync-stat-value' }, status ? String(status.remoteOnly ?? 0) : '—'),
        React.createElement('div', { className: 'sync-stat-desc' }, status?.remoteOnly ? 'Will be brought when you pull.' : 'Nothing new there.'),
      ),
    ),
    React.createElement('div', { className: 'sync-actions' },
      React.createElement('button', { type: 'button', onClick: handleDryRun, className: 'sync-btn', disabled: !canSync, title: !isConnected ? `Cannot preview — SSH to ${remoteHost} is not connected` : undefined, 'data-testid': 'sync-dry-run' }, busy === 'dry' ? 'Checking…' : 'Preview changes'),
      React.createElement('button', { type: 'button', onClick: handlePull, className: 'sync-btn sync-btn-primary', disabled: !canSync, title: !isConnected ? `Cannot pull — SSH to ${remoteHost} is not connected` : undefined, 'data-testid': 'sync-pull' }, busy === 'pull' ? 'Pulling…' : 'Pull from other machine'),
      React.createElement('button', { type: 'button', onClick: handlePush, className: 'sync-btn', disabled: !canSync, title: !isConnected ? `Cannot push — SSH to ${remoteHost} is not connected` : undefined, 'data-testid': 'sync-push' }, busy === 'push' ? 'Pushing…' : 'Push to other machine'),
      React.createElement('span', { className: 'sync-muted', style: { marginLeft: 'auto' } as any }, checking ? 'Checking SSH…' : isConnected ? `SSH ${connection!.host} · ${connection!.latencyMs ?? '—'}ms` : isDisconnected ? 'SSH disconnected' : 'SSH unknown'),
    ),
    // File lists — compact human-readable
    status ? React.createElement('div', { className: 'sync-section' },
      React.createElement('div', { className: 'sync-section-head' },
        React.createElement('div', { className: 'sync-section-title' }, '📥 Coming from the other machine'),
        React.createElement('div', { className: 'sync-section-count' }, `${status.remoteOnlyFiles?.length ?? 0} files`),
      ),
      isDisconnected
        ? React.createElement('div', { className: 'sync-empty' }, `Cannot check remote — SSH to ${connection!.host} is not connected. Fix SSH then Refresh.`)
        : (status.remoteOnlyFiles?.length ?? 0) === 0
          ? React.createElement('div', { className: 'sync-empty' }, 'Nothing to pull — the other machine has no new files.')
        : sortForDisplay(status.remoteOnlyFiles as string[]).slice(0, 8).map((p: string) => {
            const f = formatFile(p)
            return React.createElement('div', { key: p, className: 'sync-file' },
              React.createElement('div', { className: 'sync-file-icon' }, f.icon),
              React.createElement('div', { className: 'sync-file-main' },
                React.createElement('div', { className: 'sync-file-title' }, f.title),
                React.createElement('div', { className: 'sync-file-path' }, f.path),
              ),
              React.createElement('div', { className: 'sync-file-meta' }, f.meta),
            )
          }),
      !isDisconnected && (status.remoteOnlyFiles?.length ?? 0) > 8 ? React.createElement('div', { className: 'sync-empty' }, `And ${status.remoteOnlyFiles.length - 8} more · sessions first, then daily notes`) : null,
    ) : null,
    status ? React.createElement('div', { className: 'sync-section' },
      React.createElement('div', { className: 'sync-section-head' },
        React.createElement('div', { className: 'sync-section-title' }, '📤 Ready to send'),
        React.createElement('div', { className: 'sync-section-count' }, `${status.localOnlyFiles?.length ?? 0} files`),
      ),
      (status.localOnlyFiles?.length ?? 0) === 0
        ? React.createElement('div', { className: 'sync-empty' }, 'Nothing to push — this machine has no new files.')
        : sortForDisplay(status.localOnlyFiles as string[]).slice(0, 8).map((p: string) => {
            const f = formatFile(p)
            return React.createElement('div', { key: p, className: 'sync-file' },
              React.createElement('div', { className: 'sync-file-icon' }, f.icon),
              React.createElement('div', { className: 'sync-file-main' },
                React.createElement('div', { className: 'sync-file-title' }, f.title),
                React.createElement('div', { className: 'sync-file-path' }, f.path),
              ),
              React.createElement('div', { className: 'sync-file-meta' }, f.meta),
            )
          }),
      (status.localOnlyFiles?.length ?? 0) > 8 ? React.createElement('div', { className: 'sync-empty' }, `And ${status.localOnlyFiles.length - 8} more · sessions first`) : null,
    ) : null,
    error ? React.createElement('div', { className: 'sync-result sync-result-error' },
      React.createElement('div', { className: 'sync-result-title' }, 'Something went wrong'),
      React.createElement('div', { className: 'sync-result-desc' }, error),
    ) : null,
    result ? React.createElement('div', { className: 'sync-result' },
      React.createElement('div', { className: 'sync-result-title' },
        result.kind === 'dry' ? 'Preview — nothing was changed yet' : result.kind === 'pull' ? 'Pull complete' : 'Push complete',
      ),
      React.createElement('div', { className: 'sync-result-desc' },
        result.kind === 'dry' ? `${result.copied} files would be copied and ${result.added} new notes would be merged. Run Pull to actually bring them here.`
          : result.kind === 'pull' ? `Brought ${result.copied} files and merged ${result.added} new notes.`
          : `Sent ${result.copied} files to the other machine.`,
        result.merged > 0 ? ` ${result.merged} memories had new notes combined.` : '',
      ),
    ) : null,
    React.createElement('div', { className: 'sync-muted', style: { textAlign: 'center' } as any }, 'Notes and sessions are merged — never overwritten. Daily notes by unique entries, sessions by new lines.'),
  )
}

export function apply(ctx: any): void {
  const slots = (ctx as any).slots ?? (ctx as any).get?.('slots')
  if (!slots?.inject || !slots?.register) return
  // Shared Maestro nav icon — same M-logo as Maestro tab (BrandMark)
  ctx.effect(() => registerSyncNavIcon(() => 'Maestro Sync'), 'maestro-sync: settings nav icon')
  ctx.effect(installSyncNavIconStyle, 'maestro-sync: settings nav css')
  ctx.effect(() => {
    const dispose = slots.inject('settings.section', () =>
      slots.register({ name: 'settings.section', id: 'maestro-sync', order: 26, label: () => 'Maestro Sync' }, () => React.createElement(SyncPanel, { ctx })),
    )
    return () => { try { (dispose as any)?.() } catch {} }
  }, 'maestro-sync: settings')
}

export default { inject, apply }
