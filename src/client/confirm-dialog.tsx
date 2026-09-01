import * as React from 'react'
import { Button, Icon, actionLabel, actionTone, formatFile } from './ui.js'

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
}): React.ReactElement {
  const { preview, previewDirection, remoteHost, busy, actionLimit, planAgeSecs, onShowMore, onCancel, onApply } = props
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
              Apply {previewDirection} — preview {previewId}
            </div>
            <div data-sync-dialog-desc="">
              {remoteHost} · plan {planAgeSecs}s before expiry · {summary.copied ?? 0} copy · {summary.merged ?? 0} merge (+{summary.added ?? 0} added) · {summary.skipped ?? 0} skip · {summary.conflicts ?? 0} conflict
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

        <div data-sync-dialog-actions="">
          <Button variant="outline" onClick={onCancel} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button variant="primary" onClick={onApply} disabled={busy} busy={busy} aria-label={`Apply ${previewDirection}`}>
            {busy ? 'Applying…' : `Apply ${previewDirection} — ${summary.copied ?? 0} copy, ${summary.merged ?? 0} merge`}
          </Button>
        </div>
      </div>
    </div>
  )
}