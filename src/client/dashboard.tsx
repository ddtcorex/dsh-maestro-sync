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
.sync-dash-header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.sync-dash-title { font-size:15px; font-weight:700; letter-spacing:-0.01em; }
.sync-dash-subtitle { color:var(--dsw-alias-label-secondary); font-size:12px; }
.sync-dash-body { flex:1 1 auto; display:flex; gap:16px; padding:16px; overflow:hidden; min-height:0; }
.sync-dash-left { flex:1 1 50%; min-width:0; display:flex; flex-direction:column; gap:12px; overflow:hidden; }
.sync-dash-right { flex:1 1 50%; min-width:0; display:flex; flex-direction:column; gap:12px; overflow:hidden; border-left:1px solid var(--dsw-alias-border-l1); padding-left:16px; }
.sync-dash-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:12px; }
.sync-dash-tabs { display:flex; gap:6px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:8px; }
.sync-dash-tab { padding:6px 10px; border-radius:8px; border:1px solid transparent; background:transparent; font-size:13px; cursor:pointer; }
.sync-dash-tab[aria-selected="true"] { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l1); font-weight:600; }
.sync-dash-table { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; max-height:320px; }
.sync-dash-table-head { display:grid; grid-template-columns:1fr 1fr 1fr; gap:0; background:var(--dsw-alias-bg-layer-2); border-bottom:1px solid var(--dsw-alias-border-l1); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--dsw-alias-label-secondary); padding:8px 10px; }
.sync-dash-table-body { overflow:auto; max-height:280px; font-size:12px; }
.sync-dash-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; padding:6px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.sync-dash-row:last-child { border-bottom:0; }
.sync-dash-pre { white-space:pre-wrap; word-break:break-word; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; max-height:200px; overflow:auto; }
.sync-dash-btn { min-height:44px; padding:0 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
.sync-dash-btn:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
.sync-dash-tab:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
.sync-dash-btn:disabled { opacity:0.5; cursor:not-allowed; }
.sync-dash-btn-primary { background:#2563EB; color:#fff; border-color:#2563EB; }
.sync-dash-btn-primary:hover { background:#1D4ED8; }
.sync-dash-muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
@media (max-width: 768px) { .sync-dash-body { flex-direction:column; } .sync-dash-right { border-left:0; padding-left:0; border-top:1px solid var(--dsw-alias-border-l1); padding-top:16px; } }
`

function _formatFileList(files: string[], limit = 5): string {
  if (!files || files.length === 0) return '—'
  const shown = files.slice(0, limit).join(', ')
  return files.length > limit ? `${shown} … +${files.length - limit}` : shown
}
void _formatFileList

export function SyncDashboard({ ctx, onClose }: { ctx: any; onClose: () => void }): React.ReactElement {
  const call = useRpc(ctx)
  const [status, setStatus] = React.useState<Status | null>(null)
  const [filter, setFilter] = React.useState<'all' | 'memories' | 'sessions' | 'maestro'>('all')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<any>(null)
  const [error, setError] = React.useState<string>('')
  const [preview, setPreview] = React.useState<string>('')
  const [selected, setSelected] = React.useState<string | null>(null)

  const loadStatus = React.useCallback(async () => {
    setError('')
    try {
      const res: any = await call('status', {})
      const data = res?.ok === true ? res : res?.ok === false ? res : { ok: true, ...res }
      if (data?.ok === false) {
        setError(data?.error ?? 'status failed')
        return
      }
      setStatus(data)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [call])

  React.useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const filtered = React.useMemo(() => {
    if (!status) return { localOnlyFiles: [] as string[], remoteOnlyFiles: [] as string[], bothFiles: [] as string[] }
    const f = (arr: string[]) => {
      if (filter === 'all') return arr
      if (filter === 'memories') return arr.filter((p) => p.startsWith('memories/'))
      if (filter === 'sessions') return arr.filter((p) => p.startsWith('sessions/'))
      if (filter === 'maestro') return arr.filter((p) => p.startsWith('maestro/'))
      return arr
    }
    return {
      localOnlyFiles: f(status.localOnlyFiles || []),
      remoteOnlyFiles: f(status.remoteOnlyFiles || []),
      bothFiles: f(status.bothFiles || []),
    }
  }, [status, filter])

  const handlePreview = React.useCallback(
    async (rel: string) => {
      setSelected(rel)
      setPreview('loading…')
      try {
        // fetch via status? For now, try to get file content via pull dry-run preview or just show rel
        // Use host to cat file if available via status result
        setPreview(`— ${rel} —\nPreview via merge: use Dry-run to see added entries.\n(For now, file path only; full § preview will stream from host on Pull/Push.)`)
      } catch (e: any) {
        setPreview(e?.message ?? String(e))
      }
    },
    [],
  )

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
      await loadStatus()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [call, loadStatus])

  const handlePush = React.useCallback(async () => {
    setBusy('push')
    setError('')
    setResult(null)
    try {
      const res: any = await call('push', { dryRun: false })
      setResult(res)
      await loadStatus()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [call, loadStatus])

  const counts = status ? `${status.localOnly} local-only · ${status.remoteOnly} remote-only · ${status.both} both` : '—'

  return React.createElement(
    'div',
    { className: 'sync-dash-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sync Dashboard' },
    React.createElement('style', null, DASH_CSS),
    React.createElement(
      'div',
      { className: 'sync-dash-header' },
      React.createElement(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        React.createElement('div', { className: 'sync-dash-title' }, 'Sync Dashboard'),
        React.createElement('div', { className: 'sync-dash-subtitle' }, 'Merge memories & sessions — no --delete · ', counts),
      ),
      React.createElement('button', { type: 'button', onClick: loadStatus, className: 'sync-dash-btn', disabled: !!busy, 'aria-label': 'Refresh' }, 'Refresh'),
      React.createElement('button', { type: 'button', onClick: onClose, className: 'sync-dash-btn', 'aria-label': 'Close' }, 'Close'),
    ),
    React.createElement(
      'div',
      { className: 'sync-dash-body' },
      React.createElement(
        'div',
        { className: 'sync-dash-left' },
        React.createElement(
          'div',
          { className: 'sync-dash-card' },
          React.createElement(
            'div',
            { className: 'sync-dash-tabs', role: 'tablist' },
            (['all', 'memories', 'sessions', 'maestro'] as const).map((t) =>
              React.createElement(
                'button',
                {
                  key: t,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': filter === t,
                  className: 'sync-dash-tab',
                  onClick: () => setFilter(t),
                },
                t,
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'sync-dash-table', style: { marginTop: 8 } },
            React.createElement('div', { className: 'sync-dash-table-head' }, React.createElement('div', null, 'Local-only'), React.createElement('div', null, 'Both'), React.createElement('div', null, 'Remote-only')),
            React.createElement(
              'div',
              { className: 'sync-dash-table-body' },
              Array.from({ length: Math.max(filtered.localOnlyFiles.length, filtered.bothFiles.length, filtered.remoteOnlyFiles.length) }).map((_, i) =>
                React.createElement(
                  'div',
                  { key: i, className: 'sync-dash-row' },
                  React.createElement(
                    'div',
                    {
                      style: { cursor: filtered.localOnlyFiles[i] ? 'pointer' : 'default', color: filtered.localOnlyFiles[i] ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
                      onClick: filtered.localOnlyFiles[i] ? () => handlePreview(filtered.localOnlyFiles[i]!) : undefined,
                      title: filtered.localOnlyFiles[i] || '',
                    },
                    filtered.localOnlyFiles[i] ? filtered.localOnlyFiles[i]!.split('/').pop() : '—',
                  ),
                  React.createElement(
                    'div',
                    {
                      style: { cursor: filtered.bothFiles[i] ? 'pointer' : 'default' },
                      onClick: filtered.bothFiles[i] ? () => handlePreview(filtered.bothFiles[i]!) : undefined,
                      title: filtered.bothFiles[i] || '',
                    },
                    filtered.bothFiles[i] ? filtered.bothFiles[i]!.split('/').pop() : '—',
                  ),
                  React.createElement(
                    'div',
                    {
                      style: { cursor: filtered.remoteOnlyFiles[i] ? 'pointer' : 'default' },
                      onClick: filtered.remoteOnlyFiles[i] ? () => handlePreview(filtered.remoteOnlyFiles[i]!) : undefined,
                      title: filtered.remoteOnlyFiles[i] || '',
                    },
                    filtered.remoteOnlyFiles[i] ? filtered.remoteOnlyFiles[i]!.split('/').pop() : '—',
                  ),
                ),
              ),
            ),
          ),
          React.createElement('div', { className: 'sync-dash-muted', style: { marginTop: 6 } }, `filtered: ${filtered.localOnlyFiles.length} / ${filtered.bothFiles.length} / ${filtered.remoteOnlyFiles.length} · showing`, ' ', filter),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          React.createElement('button', { type: 'button', onClick: handleDryRun, className: 'sync-dash-btn', disabled: !!busy }, busy === 'dry' ? 'Running…' : 'Dry-run'),
          React.createElement('button', { type: 'button', onClick: handlePull, className: 'sync-dash-btn sync-dash-btn-primary', disabled: !!busy }, busy === 'pull' ? 'Pulling…' : 'Pull merge'),
          React.createElement('button', { type: 'button', onClick: handlePush, className: 'sync-dash-btn', disabled: !!busy }, busy === 'push' ? 'Pushing…' : 'Push merge'),
        ),
        error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error) : null,
        result ? React.createElement('pre', { className: 'sync-dash-pre' }, JSON.stringify(result, null, 2)) : null,
      ),
      React.createElement(
        'div',
        { className: 'sync-dash-right' },
        React.createElement('div', { className: 'sync-dash-card' }, React.createElement('div', { className: 'sync-dash-title', style: { fontSize: 13 } }, 'Preview'), React.createElement('div', { className: 'sync-dash-muted' }, selected ? `selected: ${selected}` : 'click a file to preview')),
        React.createElement('pre', { className: 'sync-dash-pre', style: { flex: '1 1 auto' } }, preview || '— select a file —\n§ preview and jsonl diff will show here.\nFor now, use Dry-run to see added counts.'),
        React.createElement('div', { className: 'sync-dash-muted' }, 'Tips: Dry-run previews without writing. Pull fetches remote → local, Push sends local → remote. Merge is union by stripId (§).'),
      ),
    ),
  )
}
