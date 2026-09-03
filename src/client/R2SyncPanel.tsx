// src/client/R2SyncPanel.tsx — the R2 Sync tab (backup + restore + GC).
// Confirmation-first: every mutation route lives inside a ConfirmDialog bound
// to a live preview id; secret material is never rendered — only the redacted
// source label and non-secret config/status fields.
import * as React from 'react'
import { useBackupTarget } from './use-backup.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { Button, MaestroLogo, StatTile, Badge } from './ui.js'

const sourceLabel = (s: string | undefined) => (s === 'env' ? 'Env' : s === 'file' ? 'Private file' : 'Not configured')

export function R2SyncPanel(props: { ctx: any }): React.ReactElement {
  const b = useBackupTarget(props.ctx)
  const st = b.status
  // Mobile-first: only the primary backup action stays visible; restore/GC
  // live behind a More menu so the row never overflows 360px viewports.
  const [moreOpen, setMoreOpen] = React.useState(false)
  const closeMore = () => setMoreOpen(false)

  const banner = () => {
    if (!st) return null
    return (
      <div data-r2-summary="">
        <Badge tone={st.configured ? 'success' : 'error'}>{st.configured ? sourceLabel(st.source) : sourceLabel('none')}</Badge>
        <span data-r2-muted="">{st.configured ? `${st.bucket} · ${st.prefix}` : 'Set domains.sync.r2 + secret material to enable backup'}</span>
      </div>
    )
  }

  const dialog = () => {
    if (b.confirmOpen === 'backup' && b.backupPreview) {
      return (
        <ConfirmDialog
          kind="backup"
          title="Apply backup"
          targetLabel={`${st?.bucket ?? ''} / ${st?.prefix ?? ''}`}
          preview={b.backupPreview}
          previewDirection={'push' as any}
          remoteHost={st?.bucket ?? 'R2'}
          busy={b.busy}
          actionLimit={5}
          planAgeSecs={0}
          onShowMore={() => {}}
          onCancel={b.cancelDialog}
          onApply={() => void b.applyBackup()}
        />
      )
    }
    if (b.confirmOpen === 'restore' && b.restorePreview) {
      const r = b.restorePreview
      return (
        <ConfirmDialog
          kind="restore"
          title={`Apply restore (${r.mode === 'new-dir' ? 'new dir' : 'in place'})`}
          targetLabel="from backup HEAD"
          preview={{ ...r, summary: r.summary, actions: [] }}
          previewDirection={'pull' as any}
          remoteHost="R2 backup"
          busy={b.busy}
          actionLimit={5}
          planAgeSecs={0}
          onShowMore={() => {}}
          onCancel={b.cancelDialog}
          onApply={() => void b.applyRestore(r.mode)}
        />
      )
    }
    if (b.confirmOpen === 'gc' && b.gcReport) {
      return (
        <ConfirmDialog
          kind="gc"
          title="Apply GC"
          targetLabel={`${b.gcReport.deletableBlobs?.length ?? 0} blobs · ${b.gcReport.freedBytes ?? 0} bytes`}
          preview={{ ...b.gcReport, summary: {}, actions: [] }}
          previewDirection={'push' as any}
          remoteHost={st?.bucket ?? 'R2'}
          busy={b.busy}
          actionLimit={5}
          planAgeSecs={0}
          onShowMore={() => {}}
          onCancel={b.cancelDialog}
          onApply={() => void b.applyGc()}
        />
      )
    }
    return null
  }

  return (
    <div data-sync-root="" data-r2-root="" aria-busy={b.busy}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '2px 2px 4px' }}>
        <MaestroLogo />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }}>R2 Sync</div>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }}>
            {b.checking ? 'Checking backup configuration…' : st?.configured ? `Backup ${st.prefix}` : 'Not configured'}
          </span>
        </div>
      </div>
      {banner()}
      <div data-r2-stats="">
        <StatTile icon="server" value={String(st?.eligible?.md ?? 0)} label="memories" />
        <StatTile icon="refresh" value={String(st?.eligible?.sessions ?? 0)} label="sessions" />
        <StatTile icon="check" value={st?.lastManifest ? 'yes' : 'no'} label="last backup" />
      </div>
      <div data-r2-actions="" data-sync-actions-bar="">
        <Button data-testid="r2-preview-backup" kind="primary" disabled={!b.canBackup} onClick={() => void b.previewBackup()}>
          Preview Backup
        </Button>
        <div data-r2-more="">
          <Button
            data-testid="r2-more"
            variant="outline"
            disabled={!b.canBackup}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            More
          </Button>
          {moreOpen ? (
            <div data-r2-more-menu="" role="menu" aria-label="More backup actions">
              <Button data-testid="r2-restore-newdir" role="menuitem" variant="ghost" disabled={!b.canBackup} onClick={() => { closeMore(); void b.previewRestore('new-dir') }}>
                Restore to new folder…
              </Button>
              <Button data-testid="r2-restore-inplace" role="menuitem" variant="ghost" disabled={!b.canBackup} onClick={() => { closeMore(); void b.previewRestore('in-place') }}>
                Restore in place…
              </Button>
              <Button data-testid="r2-preview-gc" role="menuitem" variant="ghost" disabled={!b.canBackup} onClick={() => { closeMore(); void b.previewGc() }}>
                Preview GC
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {b.error ? <div role="alert" data-sync-error="">{b.error}</div> : null}
      {dialog()}
    </div>
  )
}