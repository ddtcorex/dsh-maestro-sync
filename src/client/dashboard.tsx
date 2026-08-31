import * as React from 'react'

const RPC = '/dsh-maestro-sync' as const

type Status = {
  localOnly: number
  remoteOnly: number
  both: number
  localOnlyFiles: string[]
  remoteOnlyFiles: string[]
  bothFiles: string[]
  remoteHost?: string
}

function useRpc(ctx: any) {
  return React.useCallback(
    (method: string, payload: any): Promise<any> => {
      const conn = (ctx as any).connection ?? (ctx as any).get?.('connection')
      if (!conn?.rpc?.call) return Promise.reject(new Error('RPC not available'))
      return conn.rpc.call(RPC, method, payload) as Promise<any>
    },
    [ctx],
  )
}

const DASH_CSS = `
.sync-dash-overlay { position:fixed; inset:0; z-index:50; display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-1); }
.sync-dash-header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.sync-dash-title { font-size:16px; font-weight:700; letter-spacing:-0.01em; line-height:20px; }
.sync-dash-subtitle { color:var(--dsw-alias-label-secondary); font-size:13px; line-height:18px; margin-top:2px; }
.sync-dash-body { flex:1 1 auto; display:flex; flex-direction:column; gap:18px; padding:20px; overflow:auto; min-height:0; max-width:960px; width:100%; margin:0 auto; box-sizing:border-box; }
.sync-dash-summary { display:grid; grid-template-columns:1fr; gap:12px; }
@media(min-width:640px){ .sync-dash-summary{ grid-template-columns:1fr 1fr 1fr; } }
.sync-dash-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:14px; display:flex; flex-direction:column; gap:8px; }
.sync-dash-card-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--dsw-alias-label-secondary); }
.sync-dash-card-value { font-size:28px; font-weight:700; line-height:1; letter-spacing:-0.02em; }
.sync-dash-card-desc { font-size:12px; line-height:16px; color:var(--dsw-alias-label-secondary); }
.sync-dash-section { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.sync-dash-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.sync-dash-section-title { font-size:13px; font-weight:600; display:flex; align-items:center; gap:8px; }
.sync-dash-section-count { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:2px 8px; }
.sync-dash-file { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:13px; }
.sync-dash-file:last-child{ border-bottom:none; }
.sync-dash-file-icon { flex:none; width:28px; height:28px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; font-size:14px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.sync-dash-file-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.sync-dash-file-title { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sync-dash-file-path { font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sync-dash-file-meta { flex:none; font-size:11px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:2px 6px; }
.sync-dash-empty { padding:24px 14px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:18px; }
.sync-dash-actions { display:flex; gap:10px; flex-wrap:wrap; padding:0; align-items:center; }
.sync-dash-btn { min-height:36px; padding:0 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:6px; color:var(--dsw-alias-label-primary); }
.sync-dash-btn:hover{ background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
.sync-dash-btn:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
.sync-dash-btn:disabled { opacity:0.5; cursor:not-allowed; }
.sync-dash-btn-primary { background:#2563EB; color:#fff; border-color:#2563EB; }
.sync-dash-btn-primary:hover { background:#1D4ED8; border-color:#1D4ED8; color:#fff; }
.sync-dash-result { margin:0 20px 16px; padding:12px 14px; border-radius:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); font-size:13px; line-height:18px; }
.sync-dash-result-title { font-weight:600; margin-bottom:4px; }
.sync-dash-result-desc { color:var(--dsw-alias-label-secondary); }
.sync-dash-muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
@media(prefers-reduced-motion:reduce){ .sync-dash-btn{ transition:none !important; } }
`

function formatFile(path: string): { icon: string; title: string; path: string; meta: string } {
  if (path.startsWith('memories/daily/')) {
    const date = path.replace('memories/daily/', '').replace('.md', '')
    try {
      const d = new Date(date)
      if (!isNaN(d.getTime())) {
        return { icon: '📝', title: `Daily notes — ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, path, meta: 'Daily' }
      }
    } catch {}
    return { icon: '📝', title: `Daily notes — ${date}`, path, meta: 'Daily' }
  }
  if (path.startsWith('memories/projects/')) {
    const parts = path.split('/')
    const hash = parts[2] ?? ''
    return { icon: '📁', title: `Project memory`, path, meta: hash.slice(0, 7) }
  }
  if (path === 'memories/MEMORY.md') return { icon: '⭐', title: 'Global memory', path, meta: 'Global' }
  if (path.startsWith('sessions/')) {
    const parts = path.split('/')
    const cwdHash = parts[1] ?? ''
    return { icon: '💬', title: `Session`, path, meta: cwdHash.slice(0, 7) }
  }
  if (path.startsWith('maestro/')) return { icon: '⚙️', title: path.split('/').pop() ?? path, path, meta: 'Maestro' }
  if (path === 'settings.yaml') return { icon: '🔧', title: 'Settings', path, meta: 'Config' }
  return { icon: '📄', title: path.split('/').pop() ?? path, path, meta: path.split('/')[0] ?? '' }
}

function humanSummary(status: Status | null): string {
  if (!status) return 'Checking what needs to be synced…'
  const { localOnly, remoteOnly, both } = status
  if (localOnly === 0 && remoteOnly === 0) return `Everything is in sync — ${both} files match on both machines.`
  if (localOnly > 0 && remoteOnly === 0) return `${localOnly} files are only on this machine and will be sent to the other machine.`
  if (remoteOnly > 0 && localOnly === 0) return `${remoteOnly} files are only on the other machine and will be brought here.`
  return `${localOnly} files only here, ${remoteOnly} files only there, and ${both} files already match.`
}

export function SyncDashboard({ ctx, onClose }: { ctx: any; onClose: () => void }): React.ReactElement {
  const call = useRpc(ctx)
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ kind: 'dry' | 'pull' | 'push'; copied: number; merged: number; added: number } | null>(null)
  const [error, setError] = React.useState<string>('')

  const loadStatus = React.useCallback(async () => {
    setError('')
    try {
      const res: any = await call('status', {})
      const data = res?.ok === true ? res : res?.ok === false ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'Could not check sync status'); return }
      setStatus(data)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [call])

  React.useEffect(() => { void loadStatus() }, [loadStatus])

  const handleDryRun = React.useCallback(async () => {
    setBusy('dry'); setError(''); setResult(null)
    try {
      const res: any = await call('pull', { dryRun: true })
      const data = res?.ok === false ? res : res?.ok === true ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'Dry run failed'); return }
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
      await loadStatus()
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }, [call, loadStatus])

  const handlePush = React.useCallback(async () => {
    setBusy('push'); setError(''); setResult(null)
    try {
      const res: any = await call('push', { dryRun: false })
      const data = res?.ok === false ? res : res?.ok === true ? res : { ok: true, ...res }
      if (data?.ok === false) { setError(data?.error ?? 'Push failed'); return }
      setResult({ kind: 'push', copied: data.copied ?? 0, merged: data.merged ?? 0, added: data.added ?? 0 })
      await loadStatus()
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setBusy(null) }
  }, [call, loadStatus])

  const summary = humanSummary(status)
  const hasLocal = (status?.localOnly ?? 0) > 0
  const hasRemote = (status?.remoteOnly ?? 0) > 0
  const isSynced = status ? status.localOnly === 0 && status.remoteOnly === 0 : false

  return React.createElement(
    'div',
    { className: 'sync-dash-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Maestro Sync' },
    React.createElement('style', null, DASH_CSS),
    React.createElement(
      'div',
      { className: 'sync-dash-header' },
      React.createElement(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        React.createElement('div', { className: 'sync-dash-title' }, 'Maestro Sync'),
        React.createElement('div', { className: 'sync-dash-subtitle' }, summary),
      ),
      React.createElement('button', { type: 'button', onClick: loadStatus, className: 'sync-dash-btn', disabled: !!busy, 'aria-label': 'Refresh' }, 'Refresh'),
      React.createElement('button', { type: 'button', onClick: onClose, className: 'sync-dash-btn', 'aria-label': 'Close' }, 'Close'),
    ),
    React.createElement(
      'div',
      { className: 'sync-dash-body' },
      // Summary cards — human readable
      React.createElement(
        'div',
        { className: 'sync-dash-summary' },
        React.createElement(
          'div',
          { className: 'sync-dash-card', style: hasLocal ? { borderColor: '#F59E0B', background: '#FFFBEB' } : undefined },
          React.createElement('div', { className: 'sync-dash-card-label' }, 'Only on this machine'),
          React.createElement('div', { className: 'sync-dash-card-value' }, status ? String(status.localOnly) : '—'),
          React.createElement('div', { className: 'sync-dash-card-desc' }, hasLocal ? 'These will be sent to the other machine when you push.' : 'Nothing new here.'),
        ),
        React.createElement(
          'div',
          { className: 'sync-dash-card', style: isSynced ? { borderColor: '#10B981', background: '#ECFDF5' } : undefined },
          React.createElement('div', { className: 'sync-dash-card-label' }, 'Already in sync'),
          React.createElement('div', { className: 'sync-dash-card-value' }, status ? String(status.both) : '—'),
          React.createElement('div', { className: 'sync-dash-card-desc' }, isSynced ? 'All matched files are up to date.' : 'Files that match on both machines.'),
        ),
        React.createElement(
          'div',
          { className: 'sync-dash-card', style: hasRemote ? { borderColor: '#3B82F6', background: '#EFF6FF' } : undefined },
          React.createElement('div', { className: 'sync-dash-card-label' }, 'Only on the other machine'),
          React.createElement('div', { className: 'sync-dash-card-value' }, status ? String(status.remoteOnly) : '—'),
          React.createElement('div', { className: 'sync-dash-card-desc' }, hasRemote ? 'These will be brought here when you pull.' : 'Nothing new there.'),
        ),
      ),
      React.createElement(
        'div',
        { className: 'sync-dash-actions', style: { padding: '4px 0 8px' } as any },
        React.createElement('button', { type: 'button', onClick: handleDryRun, className: 'sync-dash-btn', disabled: !!busy }, busy === 'dry' ? 'Checking…' : 'Preview changes'),
        React.createElement('button', { type: 'button', onClick: handlePull, className: 'sync-dash-btn sync-dash-btn-primary', disabled: !!busy }, busy === 'pull' ? 'Pulling…' : 'Pull from other machine'),
        React.createElement('button', { type: 'button', onClick: handlePush, className: 'sync-dash-btn', disabled: !!busy }, busy === 'push' ? 'Pushing…' : 'Push to other machine'),
        React.createElement('span', { className: 'sync-dash-muted', style: { marginLeft: 'auto', alignSelf: 'center' } as any }, status?.remoteHost ? `Connected to ${status.remoteHost}` : 'Not connected'),
      ),
      // File lists — human readable, not raw paths
      status ? React.createElement(
        'div',
        { className: 'sync-dash-section' },
        React.createElement('div', { className: 'sync-dash-section-head' },
          React.createElement('div', { className: 'sync-dash-section-title' }, '📥 Coming from the other machine'),
          React.createElement('div', { className: 'sync-dash-section-count' }, `${status.remoteOnlyFiles?.length ?? 0} files`),
        ),
        (status.remoteOnlyFiles?.length ?? 0) === 0
          ? React.createElement('div', { className: 'sync-dash-empty' }, 'Nothing to pull — the other machine has no new files.')
          : (status.remoteOnlyFiles ?? []).slice(0, 8).map((p) => {
              const f = formatFile(p)
              return React.createElement('div', { key: p, className: 'sync-dash-file' },
                React.createElement('div', { className: 'sync-dash-file-icon' }, f.icon),
                React.createElement('div', { className: 'sync-dash-file-main' },
                  React.createElement('div', { className: 'sync-dash-file-title' }, f.title),
                  React.createElement('div', { className: 'sync-dash-file-path' }, f.path),
                ),
                React.createElement('div', { className: 'sync-dash-file-meta' }, f.meta),
              )
            }),
        (status.remoteOnlyFiles?.length ?? 0) > 8
          ? React.createElement('div', { className: 'sync-dash-file', style: { justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' } as any }, `And ${status.remoteOnlyFiles.length - 8} more files`)
          : null,
      ) : null,
      status ? React.createElement(
        'div',
        { className: 'sync-dash-section' },
        React.createElement('div', { className: 'sync-dash-section-head' },
          React.createElement('div', { className: 'sync-dash-section-title' }, '📤 Ready to send'),
          React.createElement('div', { className: 'sync-dash-section-count' }, `${status.localOnlyFiles?.length ?? 0} files`),
        ),
        (status.localOnlyFiles?.length ?? 0) === 0
          ? React.createElement('div', { className: 'sync-dash-empty' }, 'Nothing to push — this machine has no new files.')
          : (status.localOnlyFiles ?? []).slice(0, 8).map((p) => {
              const f = formatFile(p)
              return React.createElement('div', { key: p, className: 'sync-dash-file' },
                React.createElement('div', { className: 'sync-dash-file-icon' }, f.icon),
                React.createElement('div', { className: 'sync-dash-file-main' },
                  React.createElement('div', { className: 'sync-dash-file-title' }, f.title),
                  React.createElement('div', { className: 'sync-dash-file-path' }, f.path),
                ),
                React.createElement('div', { className: 'sync-dash-file-meta' }, f.meta),
              )
            }),
        (status.localOnlyFiles?.length ?? 0) > 8
          ? React.createElement('div', { className: 'sync-dash-file', style: { justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' } as any }, `And ${status.localOnlyFiles.length - 8} more files`)
          : null,
      ) : null,
      error ? React.createElement('div', { className: 'sync-dash-result', style: { borderColor: '#FCA5A5', background: '#FEF2F2' } as any },
        React.createElement('div', { className: 'sync-dash-result-title', style: { color: '#DC2626' } as any }, 'Something went wrong'),
        React.createElement('div', { className: 'sync-dash-result-desc' }, error),
      ) : null,
      result ? React.createElement('div', { className: 'sync-dash-result', style: result.copied === 0 && result.added === 0 ? { background: '#ECFDF5', borderColor: '#6EE7B7' } : undefined } as any,
        React.createElement('div', { className: 'sync-dash-result-title' },
          result.kind === 'dry' ? 'Preview — nothing was changed yet' : result.kind === 'pull' ? 'Pull complete' : 'Push complete',
        ),
        React.createElement('div', { className: 'sync-dash-result-desc' },
          result.kind === 'dry'
            ? `${result.copied} files would be copied and ${result.added} new notes would be merged. Run Pull to actually bring them here.`
            : result.kind === 'pull'
              ? `Brought ${result.copied} files from the other machine and merged ${result.added} new notes into your memories.`
              : `Sent ${result.copied} files to the other machine.`,
          result.merged > 0 ? ` ${result.merged} memories had new notes combined.` : '',
        ),
      ) : null,
      React.createElement('div', { className: 'sync-dash-muted', style: { textAlign: 'center', padding: '8px 0' } },
        'Your notes and sessions are merged — never overwritten. Daily notes are combined by unique entries, sessions by new lines.',
      ),
    ),
  )
}
