import * as React from 'react'
import { Button, Icon, actionLabel, actionTone, formatFile } from './ui.js'

/** Renders a tunnel domain object as a stable, comparable one-liner. */
function tunnelLine(v: any): string {
  if (v === null || v === undefined) return 'not set'
  if (typeof v !== 'object') return String(v)
  const keys = Object.keys(v).sort()
  if (keys.length === 0) return 'not set'
  return keys.map((k) => `${k}=${String((v as any)[k])}`).join(' · ')
}

/**
 * Tunnel-restore confirmation — the only place a restore can be issued.
 *
 * The restore rewrites `domains.tunnel` in the shared store, the same data
 * class whose uncoordinated write took a machine's tunnel down (HTTP 530) on
 * 2026-08-26/2026-09-09, so it follows the preview → single-use id → dialog
 * contract every other mutation in this panel already uses. The preview body is
 * read-only and shows exactly which fields change.
 */
export function TunnelRestoreDialog(props: {
  preview: any
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const { preview, busy, onCancel, onConfirm } = props
  const expiresIn = preview?.expiresAt ? Math.max(0, Math.round((new Date(preview.expiresAt).getTime() - Date.now()) / 1000)) : 0
  const changed = preview?.changed === true
  return (
    <div data-sync-dialog-overlay="" data-testid="sync-tunnel-dialog-overlay">
      <div role="dialog" aria-modal="true" aria-labelledby="sync-tunnel-dialog-title" data-sync-dialog="" data-testid="sync-tunnel-dialog">
        <div data-sync-dialog-top="">
          <div data-sync-dialog-heading="">
            <div id="sync-tunnel-dialog-title" data-sync-dialog-title="">Restore tunnel — profile {preview?.profile ?? '?'}</div>
            <div data-sync-dialog-desc="">
              Rewrites <code>domains.tunnel</code> in the shared settings store on this machine · preview expires in {expiresIn}s
            </div>
          </div>
          <button type="button" data-sync-dialog-close="" aria-label="Cancel" onClick={onCancel} disabled={busy}>
            <Icon name="close" />
          </button>
        </div>

        <div data-sync-planlist="" data-testid="sync-tunnel-plan">
          <div data-action-row="" data-sync-planrow="">
            <span data-sync-planfile="">
              <span data-sync-planfile-title="">Current value</span>
              <span data-sync-planfile-path="" data-testid="sync-tunnel-current">{tunnelLine(preview?.current)}</span>
            </span>
          </div>
          <div data-action-row="" data-sync-planrow="">
            <span data-sync-planfile="">
              <span data-sync-planfile-title="">Restored from profile</span>
              <span data-sync-planfile-path="" data-testid="sync-tunnel-desired">{tunnelLine(preview?.desired)}</span>
            </span>
          </div>
          <div data-sync-planlist-note="">
            {changed
              ? 'Only domains.tunnel changes — every other domain (jobs, notifier, guard, …) is left untouched.'
              : 'The stored value already matches this profile — confirming is a no-op.'}
          </div>
        </div>

        <div data-sync-dialog-actions="">
          <Button variant="outline" onClick={onCancel} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button variant="primary" data-testid="sync-tunnel-confirm" onClick={onConfirm} disabled={busy} busy={busy} aria-label="Restore tunnel">
            {busy ? 'Restoring…' : 'Restore tunnel'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Confirmation-first apply dialog — the ONLY place an apply can be issued.
 * Bound to a live preview id; Escape cancels; actions list paginates.
 * Bottom-sheet on mobile, centered card on ≥640px.
 */
export function ConfirmDialog(props: {
  preview: any
  previewDirection: 'pull' | 'push'
  remoteHost: string
  busy: boolean
  actionLimit: number
  planAgeSecs: number
  onShowMore: () => void
  onCancel: () => void
  onApply: () => void
  /** R2 flows: title + target label override; defaults keep the remote-sync wording. */
  kind?: 'sync' | 'backup' | 'restore' | 'gc'
  title?: string
  targetLabel?: string
  /** Bidirectional flow: second plan section rendered below the primary one. */
  projectedTitle?: string
  projectedPreview?: any
  projectedNote?: string
  /** Bidirectional flow: apply button label override. */
  applyLabel?: string
}): React.ReactElement {
  const { preview, previewDirection, remoteHost, busy, actionLimit, planAgeSecs, onShowMore, onCancel, onApply, title, targetLabel, projectedTitle, projectedPreview, projectedNote, applyLabel } = props
  const actions = (preview?.actions ?? []).slice(0, actionLimit)
  const hasMore = (preview?.actions?.length ?? 0) > actionLimit
  const summary = preview?.summary ?? {}
  const sessionCounts = preview?.sessionCounts
  const previewId = String(preview?.previewId ?? '').slice(0, 8)

  const sessionLine = sessionCounts
    ? `${sessionCounts.added ?? 0} added · ${sessionCounts.updated ?? 0} updated · ${sessionCounts.deleted ?? 0} deleted · ${sessionCounts.identical ?? 0} identical`
    : null

  return (
    <div data-sync-dialog-overlay="" data-testid="sync-dialog-overlay">
      <div role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title" data-sync-dialog="" data-testid="sync-dialog">
        <div data-sync-dialog-top="">
          <div data-sync-dialog-heading="">
            <div id="sync-dialog-title" data-sync-dialog-title="">
              {title ?? `Apply ${previewDirection} — preview ${previewId}`}
            </div>
            <div data-sync-dialog-desc="">
              {targetLabel ?? remoteHost} · plan {planAgeSecs}s before expiry · {summary.copied ?? 0} copy · {summary.merged ?? 0} merge (+{summary.added ?? 0} added) · {summary.skipped ?? 0} skip · {summary.conflicts ?? 0} conflict
            </div>
          </div>
          <button type="button" data-sync-dialog-close="" aria-label="Cancel" onClick={onCancel} disabled={busy}>
            <Icon name="close" />
          </button>
        </div>

        <div data-sync-planlist="">
          {sessionLine ? (
            <div data-sync-sessioncounts="" data-testid="sync-session-counts">
              <span data-sync-sessioncounts-lbl="">
                <Icon name="swap" />
                Sessions (counted by checksum)
              </span>
              <span data-sync-sessioncounts-line="">{sessionLine}</span>
            </div>
          ) : null}
          {actions.length === 0 ? (
            <div data-sync-empty="">Nothing to do — every file is already in sync.</div>
          ) : (
            actions.map((a: any) => {
              const f = formatFile(a.path)
              return (
                <div key={a.path} data-action-row="" title={a.path} data-sync-planrow="">
                  <span data-sync-planfile-icon="" style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                    <Icon name={f.icon} />
                  </span>
                  <span data-sync-planfile="">
                    <span data-sync-planfile-title="">{f.title} — {actionLabel(a)}</span>
                    <span data-sync-planfile-path="">{a.path}</span>
                  </span>
                  <span data-sync-planrow-meta="">
                    <span data-sync-badge="" data-tone={actionTone(a)}>{a.reason ?? a.action}</span>
                  </span>
                </div>
              )
            })
          )}
          {hasMore ? (
            <div data-sync-planmore="">
              <Button size="sm" variant="ghost" onClick={onShowMore} aria-label="Show more actions">Show more</Button>
            </div>
          ) : null}
        </div>

        {projectedPreview ? (
          <div data-sync-planlist="" data-testid="sync-projected-plan">
            <div data-sync-planlist-title="">{projectedTitle ?? 'Pull plan (projected)'}</div>
            {projectedNote ? <div data-sync-planlist-note="">{projectedNote}</div> : null}
            {((projectedPreview?.actions ?? []) as any[]).slice(0, actionLimit).map((a: any) => {
              const f = formatFile(a.path)
              return (
                <div key={a.path} data-action-row="" title={a.path} data-sync-planrow="">
                  <span data-sync-planfile-icon="" style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                    <Icon name={f.icon} />
                  </span>
                  <span data-sync-planfile="">
                    <span data-sync-planfile-title="">{f.title} — {actionLabel(a)}</span>
                    <span data-sync-planfile-path="">{a.path}</span>
                  </span>
                  <span data-sync-planrow-meta="">
                    <span data-sync-badge="" data-tone={actionTone(a)}>{a.reason ?? a.action}</span>
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}

        <div data-sync-dialog-actions="">
          <Button variant="outline" onClick={onCancel} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button variant="primary" onClick={onApply} disabled={busy} busy={busy} aria-label={applyLabel ?? `Apply ${previewDirection}`}>
            {busy ? 'Applying…' : (applyLabel ?? `Apply ${previewDirection} — ${summary.copied ?? 0} copy, ${summary.merged ?? 0} merge`)}
          </Button>
        </div>
      </div>
    </div>
  )
}