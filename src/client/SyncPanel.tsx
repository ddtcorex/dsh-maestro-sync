import * as React from 'react'
import { useSync, type Bucket } from './use-sync.js'
import { R2SyncPanel } from './R2SyncPanel.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { Button, Icon, MaestroLogo, StatTile, formatFile, formatLastSync, humanSummary } from './ui.js'

/**
 * Maestro Sync — the complete settings card (settings.section, id maestro-sync).
 * Mobile-first summary + the two paged file lists (Only here / Only there);
 * everything lives in Settings. Keeps the confirmation-first contract: Preview
 * is read-only; apply exists only inside the dialog bound to the live preview
 * id (confirm:true).
 */
export function SyncPanel(props: { ctx: any }): React.ReactElement {
  const s = useSync(props.ctx)
  const { connection, checking, busy, error, result, status, remoteHost, lastSync, confirmOpen, preview, previewDirection, actionLimit, pages } = s

  const isConnected = connection?.ok === true
  const isDisconnected = connection?.ok === false
  const canSync = isConnected && !checking && !busy
  const planAgeSecs = preview?.expiresAt ? Math.max(0, Math.round((new Date(preview.expiresAt).getTime() - Date.now()) / 1000)) : 0

  const renderBucket = (bucket: Bucket, heading: string, empty: string) => {
    const page = pages[bucket]
    const icon = bucket === 'localOnly' ? 'upload' : 'download'
    return (
      <section data-sync-dcol="" data-bucket={bucket} aria-label={heading}>
        <header data-sync-dcol-head="">
          <span data-sync-dcol-title="">
            <Icon name={icon} />
            {heading}
          </span>
          <span data-sync-dcol-count="">
            {page.files.length}/{page.total}
          </span>
        </header>
        {isDisconnected ? (
          <div data-sync-empty="">Cannot check remote — SSH to {connection!.host} is not connected.</div>
        ) : page.files.length === 0 && !page.loaded ? (
          <div data-sync-loading="">Checking {heading.toLowerCase()}…</div>
        ) : page.files.length === 0 && !checking ? (
          <div data-sync-empty="">{empty}</div>
        ) : (
          page.files.map((p: string) => {
            const f = formatFile(p)
            return (
              <div key={p} data-sync-file="" title={p}>
                <span data-sync-file-icon="" style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                  <Icon name={f.icon} />
                </span>
                <span data-sync-file-main="">
                  <span data-sync-file-title="">{f.title}</span>
                  <span data-sync-file-path="">{f.path}</span>
                </span>
                <span data-sync-file-meta="">{f.meta}</span>
              </div>
            )
          })
        )}
        {page.next != null ? (
          <footer data-sync-dcol-foot="">
            <Button size="sm" variant="ghost" onClick={() => void s.loadPage(bucket, page.next!)} aria-label={`Show more ${heading}`}>
              Show more
            </Button>
          </footer>
        ) : null}
      </section>
    )
  }

  const renderRemote = () => (
    <div data-sync-root="" aria-busy={busy || checking}>
      {/* Header — shared Maestro badge + title + live status line (same as Maestro Jobs) */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '2px 2px 4px' }}>
        <MaestroLogo />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }}>Maestro Sync</div>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }}>
            {checking ? 'Checking connection…' : isConnected ? `${connection!.host} · ${humanSummary(status)}` : isDisconnected ? `Cannot reach ${connection!.host}` : humanSummary(status)}
          </span>
        </div>
        <Button variant="ghost" size="sm" icon="refresh" busy={checking} onClick={() => void s.loadStatus()} aria-label="Refresh connection status" style={{ marginLeft: 'auto', marginTop: 2 }}>
          {checking ? 'Checking' : 'Refresh'}
        </Button>
      </div>

      {/* Connection banner */}
      <div data-sync-conn="" data-state={isDisconnected ? 'bad' : checking ? 'checking' : 'ok'} data-testid="sync-connection">
        <span data-sync-conn-dot="" />
        <span data-sync-conn-main="">
          {checking ? (
            <span data-sync-conn-title="">Checking SSH to {remoteHost}…</span>
          ) : isConnected ? (
            <>
              <span data-sync-conn-title="">
                Connected to {connection!.host}
                {connection!.latencyMs != null ? ` · ${connection!.latencyMs}ms` : ''} · SSH ready
              </span>
              <span data-sync-conn-desc="">Use Preview to see the exact plan — Apply always requires confirmation.</span>
            </>
          ) : isDisconnected ? (
            <>
              <span data-sync-conn-title="">Cannot reach {connection!.host} — sync is paused</span>
              <span data-sync-conn-desc="">{connection!.error ? String(connection!.error).slice(0, 220) : 'SSH failed. Check that the host is reachable and your key is loaded.'}</span>
            </>
          ) : (
            <span data-sync-conn-title="">Checking connection…</span>
          )}
        </span>
      </div>

      {/* Identity fields — host + last sync */}
      <div data-sync-fields="">
        <div data-sync-field="">
          <span data-sync-field-label="">Remote host</span>
          <span data-sync-field-value="" data-testid="sync-remote-host">{remoteHost}</span>
        </div>
        <div data-sync-field="">
          <span data-sync-field-label="">Last sync</span>
          <span data-sync-field-value="" data-testid="sync-last-sync">{formatLastSync(lastSync)}</span>
        </div>
      </div>

      {/* Stats */}
      <div data-sync-stats="">
        <StatTile
          icon="upload"
          value={status ? String(status.localOnly ?? 0) : '—'}
          label="Only here"
          hint={status?.localOnly ? 'Pushed on Preview Push' : 'Nothing here'}
          ariaLabel="Files only on this machine"
        />
        <StatTile
          icon="swap"
          value={status ? String(status.both ?? 0) : '—'}
          label="On both"
          hint="Content compared in Preview"
          ariaLabel="Files on both machines"
        />
        <StatTile
          icon="download"
          value={status ? String(status.remoteOnly ?? 0) : '—'}
          label="Only there"
          hint={status?.remoteOnly ? 'Pulled on Preview Pull' : 'Nothing there'}
          ariaLabel="Files only on the other machine"
        />
      </div>

      {/* Primary actions */}
      <div data-sync-actions="">
        <Button variant="outline" icon="download" disabled={!canSync} data-testid="sync-preview-pull" onClick={() => void s.handlePreview('pull')}>
          {busy ? 'Working…' : 'Preview Pull'}
        </Button>
        <Button variant="outline" icon="upload" disabled={!canSync} data-testid="sync-preview-push" onClick={() => void s.handlePreview('push')}>
          {busy ? 'Working…' : 'Preview Push'}
        </Button>
      </div>

      {/* Preview progress — shows the session file currently being counted */}
      {busy && s.progress ? (
        <div data-sync-progress="" role="status" aria-live="polite" data-testid="sync-progress">
          <span data-sync-progress-meta="">
            {s.progress.phase === 'hashing'
              ? `Reviewing sessions ${s.progress.current}/${s.progress.total}${s.progress.file ? ` — ${formatFile(s.progress.file).path}` : ''}`
              : s.progress.phase === 'staging'
                ? `Staging files ${s.progress.current}/${s.progress.total}`
                : s.progress.phase === 'planning'
                  ? 'Building the exact plan…'
                  : 'Listing both machines…'}
          </span>
          <span data-sync-progress-track="" role="progressbar" aria-valuemin={0} aria-valuemax={s.progress.total} aria-valuenow={s.progress.current}>
            <span data-sync-progress-fill="" style={{ width: `${s.progress.total > 0 ? Math.min(100, Math.round((s.progress.current / s.progress.total) * 100)) : 0}%` }} />
          </span>
        </div>
      ) : null}

      {/* Results + errors (announced) */}
      {result ? (
        <div data-sync-notice="" data-tone={result.ok ? 'ok' : 'bad'} role="status" aria-live="polite">
          <span data-sync-notice-icon="">
            <Icon name={result.ok ? 'check' : 'alert'} />
          </span>
          <span data-sync-notice-main="">
            <span data-sync-notice-title="">{result.ok ? 'Apply complete' : 'Apply failed'}</span>
            <span data-sync-notice-desc="">{result.text}</span>
          </span>
        </div>
      ) : null}
      {error ? (
        <div data-sync-notice="" data-tone="bad" role="alert">
          <span data-sync-notice-icon="">
            <Icon name="alert" />
          </span>
          <span data-sync-notice-main="">
            <span data-sync-notice-title="">Something went wrong</span>
            <span data-sync-notice-desc="">{error}</span>
          </span>
        </div>
      ) : null}

      {/* File list sections — everything stays inside Settings */}
      <div data-sync-filetables="">
        {renderBucket('remoteOnly', 'Coming from the other machine', 'Nothing to pull — the other machine has no eligible files here.')}
        {renderBucket('localOnly', 'Ready to send', 'Nothing to push — this machine has no eligible files here.')}
      </div>

      {/* Confirmation dialog — the only place apply exists */}
      {confirmOpen && preview ? (
        <ConfirmDialog
          preview={preview}
          previewDirection={previewDirection}
          remoteHost={remoteHost}
          busy={busy}
          actionLimit={actionLimit}
          planAgeSecs={planAgeSecs}
          onShowMore={() => s.setActionLimit((n: number) => n + 5)}
          onCancel={s.cancelDialog}
          onApply={() => void s.handleApply()}
        />
      ) : null}

      <div data-sync-muted="" style={{ textAlign: 'center' }}>
        Notes and sessions are merged — never overwritten. Apply always requires confirmation.
      </div>
    </div>
  )

  const [tab, setTab] = React.useState<'remote' | 'r2'>('remote')
  return (
    <div data-sync-shell="">
      <div data-sync-tabs="" role="tablist" aria-label="Maestro Sync modes">
        <button data-testid="sync-tab-remote" role="tab" aria-selected={tab === 'remote'} data-sync-tab="" onClick={() => setTab('remote')}>
          Remote Sync
        </button>
        <button data-testid="sync-tab-r2" role="tab" aria-selected={tab === 'r2'} data-sync-tab="" onClick={() => setTab('r2')}>
          R2 Sync
        </button>
      </div>
      {tab === 'remote' ? renderRemote() : <R2SyncPanel ctx={props.ctx} />}
    </div>
  )
}