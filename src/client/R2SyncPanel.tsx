// src/client/R2SyncPanel.tsx — the R2 Sync tab (backup + restore + GC).
// Confirmation-first: every mutation route lives inside a ConfirmDialog bound
// to a live preview id; secret material is never rendered — only the redacted
// source label and non-secret config/status fields.
import * as React from 'react'
import { useBackupTarget } from './use-backup.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { Button, StatTile, Badge } from './ui.js'

const sourceLabel = (s: string | undefined) => (s === 'env' ? 'Env' : s === 'file' ? 'Private file' : 'Not configured')

type BackupApi = ReturnType<typeof useBackupTarget>

function field(input: { id: string; label: string; value: string; placeholder: string; onChange: (v: string) => void; disabled: boolean; hint?: string }) {
  return (
    <div data-r2-field="">
      <label data-r2-field-label="" htmlFor={input.id}>{input.label}</label>
      <input
        id={input.id}
        data-r2-field-input=""
        data-testid={input.id}
        value={input.value}
        onChange={(e) => input.onChange(e.target.value)}
        placeholder={input.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={input.disabled}
      />
      {input.hint ? <span data-r2-field-hint="">{input.hint}</span> : null}
    </div>
  )
}

/**
 * Non-secret backup target form — mirrors the SSH section on the Remote tab.
 * Keys are never asked for here: they come from env or the 0600 sidecar.
 */
function ConfigForm(props: { b: BackupApi }): React.ReactElement {
  const b = props.b
  const st = b.status
  const [provider, setProvider] = React.useState('r2')
  const [accountId, setAccountId] = React.useState('')
  const [endpoint, setEndpoint] = React.useState('')
  const [region, setRegion] = React.useState('')
  const [bucket, setBucket] = React.useState('')
  const [prefix, setPrefix] = React.useState('')
  const [primed, setPrimed] = React.useState(false)
  React.useEffect(() => {
    if (primed || !st) return
    const r = st.r2
    setProvider(r?.provider === 'aws' ? 'aws' : 'r2')
    setAccountId('')
    setEndpoint(r?.endpoint ?? '')
    setRegion(r?.region ?? '')
    setBucket(r?.bucket ?? '')
    setPrefix(st.prefix ?? '')
    setPrimed(true)
  }, [st, primed])
  const busy = b.busy || b.checking
  return (
    <div data-r2-config="">
      <span data-r2-config-label="">Backup target</span>
      <div data-r2-field="">
        <label data-r2-field-label="" htmlFor="r2-cfg-provider">Provider</label>
        <div data-r2-provider-row="" role="radiogroup" aria-label="Provider">
          {(['r2', 'aws'] as const).map((p) => (
            <button
              key={p}
              type="button"
              data-testid={`r2-cfg-provider-${p}`}
              data-r2-provider-opt=""
              aria-pressed={provider === p}
              disabled={busy}
              onClick={() => setProvider(p)}
            >
              {p === 'r2' ? 'Cloudflare R2' : 'AWS S3'}
            </button>
          ))}
        </div>
      </div>
      {provider === 'r2' ? field({ id: 'r2-cfg-account', label: 'Account ID', value: accountId, placeholder: '32 hex chars (empty = keep default endpoint)', onChange: setAccountId, disabled: busy }) : null}
      {field({ id: 'r2-cfg-endpoint', label: 'Endpoint', value: endpoint, placeholder: 'empty = default for provider', onChange: setEndpoint, disabled: busy })}
      {field({ id: 'r2-cfg-region', label: 'Region', value: region, placeholder: 'auto', onChange: setRegion, disabled: busy })}
      {field({ id: 'r2-cfg-bucket', label: 'Bucket', value: bucket, placeholder: 'maestro-backup', onChange: setBucket, disabled: busy })}
      {field({ id: 'r2-cfg-prefix', label: 'Prefix', value: prefix, placeholder: 'v1/hosts/<id>/', onChange: setPrefix, disabled: busy })}
      <div data-r2-config-row="">
        <Button data-testid="r2-save-config" variant="primary" disabled={busy} busy={b.busy} onClick={() => void b.saveR2Config({ provider, accountId, endpoint, region, bucket, prefix })}>
          {b.busy ? 'Saving…' : 'Save target'}
        </Button>
      </div>
      <span data-r2-config-hint="">Access keys are never entered here — set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY env or the 0600 sidecar file.</span>
    </div>
  )
}

export function R2SyncPanel(props: { b: ReturnType<typeof useBackupTarget> }): React.ReactElement {
  const b = props.b
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
      {banner()}
      <ConfigForm b={b} />
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