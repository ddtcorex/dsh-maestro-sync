/**
 * dsh-maestro-sync — client bundle entry.
 * Single registration: settings.section id maestro-sync (Minimalism & Swiss,
 * mobile-first). The settings card is the complete Sync UI — connection,
 * stats, paged file lists, and the confirmation-first Preview/Apply flow:
 * preview is read-only; apply exists only inside a dialog bound to the live
 * preview id (confirm:true). All colors/geometry via --dsw-alias-* tokens;
 * the only fixed hex is the shared Maestro logo tile #0A84FF (branding rule).
 */
import * as React from 'react'
import { SyncPanel } from './SyncPanel.js'

export const inject = ['slots', 'connection'] as const

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

function installStyleTag(css: string, pluginCss: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@ddtcorex/dsh-maestro-sync'
  tag.dataset.pluginCss = pluginCss
  tag.textContent = css
  document.head.appendChild(tag)
  return () => {
    document.querySelector(`style[data-plugin-css="${pluginCss}"]`)?.remove()
  }
}

// ---------------------------------------------------------------------------
// Sync UI CSS — token-native, mobile-first (375 → 480 → 640 → 1024 → 1440)
// ---------------------------------------------------------------------------
const SYNC_CSS = `
[data-sync-root], [data-sync-root] * { box-sizing: border-box; }
[data-sync-root] { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; min-width: 0; width: 100%; max-width: 640px; }

/* connection banner */
[data-sync-conn] { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
[data-sync-conn][data-state="bad"] { border-color: var(--dsw-alias-state-error-primary, #DC2626); }
[data-sync-conn-dot] { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; }
[data-sync-conn][data-state="ok"] [data-sync-conn-dot] { background: var(--dsw-alias-state-success-primary, #16A34A); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-success-primary, #16A34A) 16%, transparent); }
[data-sync-conn][data-state="bad"] [data-sync-conn-dot] { background: var(--dsw-alias-state-error-primary, #DC2626); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-error-primary, #DC2626) 12%, transparent); }
[data-sync-conn][data-state="checking"] [data-sync-conn-dot] { background: var(--dsw-alias-label-secondary); opacity: 0.6; }
[data-sync-conn-main] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
[data-sync-conn-title] { font-size: 12px; font-weight: 600; line-height: 16px; }
[data-sync-conn-desc] { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-secondary); word-break: break-word; }

/* identity fields */
[data-sync-fields] { display: flex; gap: 10px; flex-wrap: wrap; }
[data-sync-field] { flex: 1 1 160px; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px 10px; }
[data-sync-field-label] { font-size: 11px; color: var(--dsw-alias-label-secondary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; display: block; }
[data-sync-field-value] { font-size: 13px; font-weight: 600; word-break: break-all; margin-top: 2px; display: block; }

/* stat tiles */
[data-sync-stats] { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
[data-sync-stat] { display: flex; flex-direction: column; gap: 4px; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); padding: 10px 12px; text-align: left; font: inherit; cursor: default; color: inherit; }
button[data-sync-stat] { cursor: pointer; }
button[data-sync-stat]:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); }
button[data-sync-stat]:focus-visible { outline: 2px solid var(--dsw-alias-border-l2); outline-offset: 2px; }
[data-sync-stat-icon] { display: inline-flex; color: var(--dsw-alias-label-tertiary); }
[data-sync-stat-value] { font-size: 22px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
[data-sync-stat-label] { font-size: 12px; font-weight: 600; line-height: 16px; }
[data-sync-stat-hint] { font-size: 10px; line-height: 13px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* actions */
[data-sync-actions] { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

/* preview progress — live per-file ticks while sessions are counted */
[data-sync-progress] { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
[data-sync-progress-meta] { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
[data-sync-progress-track] { display: block; height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; }
[data-sync-progress-fill] { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-state-info-primary, #0A84FF); transition: width 0.3s ease; }
@media (prefers-reduced-motion: reduce) { [data-sync-progress-fill] { transition: none; } }

/* dialog session counts — counted by checksum, no per-file rows */
[data-sync-sessioncounts] { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); margin-bottom: 6px; }
[data-sync-sessioncounts-lbl] { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
[data-sync-sessioncounts-line] { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-secondary); }

/* notice / error */
[data-sync-notice] { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
[data-sync-notice][data-tone="bad"] { border-color: var(--dsw-alias-state-error-primary, #DC2626); }
[data-sync-notice-icon] { display: inline-flex; color: var(--dsw-alias-label-tertiary); margin-top: 1px; }
[data-sync-notice][data-tone="bad"] [data-sync-notice-icon] { color: var(--dsw-alias-state-error-primary, #DC2626); }
[data-sync-notice][data-tone="ok"] [data-sync-notice-icon] { color: var(--dsw-alias-state-success-primary, #16A34A); }
[data-sync-notice-main] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
[data-sync-notice-title] { font-size: 12px; font-weight: 600; }
[data-sync-notice-desc] { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-secondary); word-break: break-word; }

/* badges */
[data-sync-badge] { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
[data-sync-badge][data-tone="brand"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
[data-sync-badge][data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
[data-sync-badge][data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
[data-sync-badge][data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }

[data-sync-muted] { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 14px; }

/* ---- confirmation dialog: bottom sheet on mobile, centered card ≥640 ---- */
[data-sync-dialog-overlay] { position: fixed; inset: 0; z-index: 1000; background: color-mix(in srgb, var(--dsw-alias-bg-base, #000) 55%, transparent); display: flex; align-items: flex-end; justify-content: center; }
[data-sync-dialog] { width: 100%; max-width: 560px; max-height: 88dvh; overflow: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px 16px 0 0; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 -16px 50px rgba(0, 0, 0, 0.3); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
[data-sync-dialog-top] { display: flex; align-items: flex-start; gap: 8px; }
[data-sync-dialog-heading] { flex: 1; min-width: 0; }
[data-sync-dialog-title] { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; line-height: 20px; }
[data-sync-dialog-desc] { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
[data-sync-dialog-close] { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0; }
[data-sync-dialog-close]:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
[data-sync-dialog-close]:focus-visible { outline: 2px solid var(--dsw-alias-border-l2); outline-offset: 2px; }
[data-sync-planlist] { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
[data-sync-planrow] { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
[data-sync-planrow]:last-child { border-bottom: none; }
[data-sync-planfile-icon] { display: inline-flex; flex: none; }
[data-sync-planfile] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
[data-sync-planfile-title] { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-sync-planfile-path] { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-sync-planrow-meta] { flex: none; }
[data-sync-planmore] { display: flex; justify-content: center; padding: 8px; }
[data-sync-empty] { padding: 16px 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
[data-sync-loading] { padding: 16px 12px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
[data-sync-dialog-actions] { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }

/* ---- file list sections (in-card) ---- */
[data-sync-filetables] { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (min-width: 1024px) {
  [data-sync-filetables] { grid-template-columns: 1fr 1fr; }
}
[data-sync-dcol] { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; min-width: 0; }
[data-sync-dcol-head] { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
[data-sync-dcol-title] { font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
[data-sync-dcol-count] { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 8px; }
[data-sync-file] { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; min-width: 0; }
[data-sync-file]:last-child { border-bottom: none; }
[data-sync-file-icon] { display: inline-flex; flex: none; color: var(--dsw-alias-label-tertiary); }
[data-sync-file-main] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
[data-sync-file-title] { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
[data-sync-file-path] { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-sync-file-meta] { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 1px 6px; white-space: nowrap; }
[data-sync-dcol-foot] { display: flex; justify-content: center; padding: 8px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }

/* spinner */
@keyframes sync-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.sync-spin { display: inline-block; animation: sync-spin 0.8s linear infinite; font-size: 14px; line-height: 1; }

/* ---- breakpoints ---- */
@media (max-width: 480px) {
  [data-sync-actions] > [data-sync-btn] { flex: 1 1 auto; }
  [data-sync-fields] { flex-direction: column; }
}
@media (min-width: 640px) {
  [data-sync-dialog-overlay] { align-items: center; padding: 24px; }
  [data-sync-dialog] { border-radius: 14px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35); }
}
@media (min-width: 1024px) {
  [data-sync-dash-content] { padding: 20px; }
}
@media (max-width: 390px) {
  [data-sync-card] { padding: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  [data-sync-root] *, [data-sync-dialog] * { transition: none !important; animation: none !important; }
  .sync-spin { animation: none; }
}
`

function apply(ctx: any): void {
  const slots = (ctx as any).slots ?? (ctx as any).get?.('slots')
  if (!slots?.inject || !slots?.register) return

  ctx.effect(() => registerSyncNavIcon(() => 'Maestro Sync'), 'maestro-sync: settings nav icon')
  ctx.effect(() => installStyleTag(SETTINGS_NAV_CSS, 'maestro-sync/settings-nav.css'), 'maestro-sync: settings nav css')
  ctx.effect(() => installStyleTag(SYNC_CSS, 'maestro-sync/settings.css'), 'maestro-sync: settings css')

  ctx.effect(() => {
    const dispose = slots.inject('settings.section', () =>
      slots.register(
        { name: 'settings.section', id: 'maestro-sync', order: 26, label: () => 'Maestro Sync' },
        () => React.createElement(SyncPanel, { ctx }),
      ),
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