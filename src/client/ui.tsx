import * as React from 'react'

/**
 * Sync UI kit — DSH-native primitives, Minimalism & Swiss (design-system/MASTER.md).
 * Every color/geometry value maps to a --dsw-alias-* / --dsw-* token; the only
 * fixed hex is the shared Maestro logo tile #0A84FF (branding rule).
 * Components style themselves via [data-sync-*] attributes + tokens (mirrors
 * the dsh-maestro-jobs ui kit so mobile media queries live in one CSS layer).
 */

export const RPC_CHANNEL = '/dsh-maestro-sync' as const

// --- DSH tokens — single source, no custom hex ---------------------------------
export const t = {
  bgBase: 'var(--dsw-alias-bg-base)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3)',
  bgOverlay: 'var(--dsw-alias-bg-overlay)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  labelFg: 'var(--dsw-alias-label-primary-foreground)',
  primaryFill: 'var(--dsw-alias-button-primary-fill)',
  primaryHover: 'var(--dsw-alias-button-primary-hover)',
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover)',
  interactiveActive: 'var(--dsw-alias-interactive-bg-active)',
  brand: 'var(--dsw-alias-brand-primary)',
  stateError: 'var(--dsw-alias-state-error-primary)',
  stateSuccess: 'var(--dsw-alias-state-success-primary)',
  stateWarn: 'var(--dsw-alias-state-warn-primary)',
  shadowLv3: 'var(--dsw-shadow-lv3)',
} as const

// --- Shared Maestro logo (branding rule: same mark/path everywhere) -------------
export function MaestroMark(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 11 L5 4 L8 9 L11 4 L14 11" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function MaestroLogo(props: { outer?: number; size?: number; radius?: number }) {
  const outer = props.outer ?? 28
  const size = props.size ?? 16
  const radius = props.radius ?? 8
  return (
    <span
      data-maestro-logo=""
      style={{
        width: outer,
        height: outer,
        borderRadius: radius,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-brand-primary, #0A84FF)',
        backgroundColor: '#0A84FF',
        color: '#fff',
        flex: 'none',
        border: '1px solid rgba(0, 0, 0, 0.08)',
        boxShadow: '0 0 0 1px var(--dsw-alias-border-l1)',
        boxSizing: 'border-box',
        alignSelf: 'flex-start',
        marginTop: 2,
      }}
    >
      <MaestroMark size={size} />
    </span>
  )
}

// --- Inline SVG icon set (no emoji-as-icon) -------------------------------------
export type IconName =
  | 'refresh'
  | 'download'
  | 'upload'
  | 'swap'
  | 'file'
  | 'folder'
  | 'star'
  | 'message'
  | 'calendar'
  | 'server'
  | 'clock'
  | 'alert'
  | 'check'
  | 'close'
  | 'chevron-down'
  | 'chevron-right'
  | 'external'

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  download: <path d="M8 2.5v7m0 0L5 6.5m3 3l3-3M3 12.5h10v1H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  upload: <path d="M8 11.5v-7m0 0L5 7.5m3-3l3 3M3 12.5h10v1H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  swap: <path d="M4.5 3.5 2 6l2.5 2.5M2 6h7m2.5 5.5L14 9l-2.5-2.5M14 9H7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  file: <path d="M3 13V3h6l4 4v6H3zM9 3v4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  folder: <path d="M2 3.5h4.5l1.5 2H14v8H2v-10z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  star: <path d="M8 2l1.8 3.7 4.2.6-3 3 .7 4.2L8 11.9 4.3 13.5l.7-4.2-3-3 4.2-.6z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
  message: <path d="M3 3h10v8H6l-3 3V3z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
  calendar: (
    <>
      <rect x="2.5" y="4" width="11" height="9.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 7.5h11M5.5 2.5v3m5-3v3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  server: (
    <>
      <rect x="2.5" y="3" width="11" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2.5" y="9" width="11" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 5h.01M5.5 11h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5v3l2 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.5 14 13H2L8 2.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 7v2.5M8 11.5v.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  check: <path d="M3.5 8.2l2.8 2.8L12.5 4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  close: <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  'chevron-down': <path d="M3.5 5.5 7 9l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  'chevron-right': <path d="M5.5 3.5 9 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  external: <path d="M6 3h7v7M13 3 7 9M13 9v4H3V3h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
}

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 14
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: 'none' }}>
      {ICON_PATHS[props.name]}
    </svg>
  )
}

// --- Buttons (primary / outline / ghost, sm / md) — token-native ---------------
export function Button(props: {
  variant?: 'primary' | 'outline' | 'ghost'
  size?: 'sm' | 'md'
  icon?: IconName
  busy?: boolean
  children?: React.ReactNode
  style?: React.CSSProperties
} & Record<string, unknown>) {
  const { variant = 'outline', size = 'md', icon, busy, children, style, ...rest } = props as any
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: size === 'sm' ? 32 : 36,
    padding: size === 'sm' ? '0 12px' : '0 14px',
    borderRadius: size === 'sm' ? 16 : 18,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: variant === 'primary' ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
    color: variant === 'primary' ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
  }
  if (variant === 'ghost') base.border = '1px solid transparent'
  const disabled = rest.disabled === true
  return (
    <button
      type="button"
      data-sync-btn=""
      data-variant={variant}
      data-size={size}
      {...rest}
      disabled={disabled || busy === true}
      style={{ ...base, ...(style ?? {}) }}
      onMouseEnter={(e) => {
        if (disabled || busy) return
        if (variant === 'primary') (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-button-primary-hover)'
        else (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-interactive-bg-hover)'
      }}
      onMouseLeave={(e) => {
        if (variant === 'primary') (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-button-primary-fill)'
        else (e.currentTarget as HTMLButtonElement).style.background = variant === 'outline' ? 'transparent' : 'transparent'
      }}
    >
      {busy ? <span className="sync-spin" aria-hidden="true">◌</span> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}

// --- Stat tile — tappable summary card ------------------------------------------
export function StatTile(props: { icon: IconName; value: React.ReactNode; label: string; hint?: string; tone?: 'default' | 'success' | 'error' | 'warn'; onClick?: () => void; ariaLabel?: string }) {
  const toneColor = props.tone === 'success' ? t.stateSuccess : props.tone === 'error' ? t.stateError : props.tone === 'warn' ? t.stateWarn : undefined
  const isBtn = props.onClick !== undefined
  const inner = (
    <>
      <span data-sync-stat-icon="" style={{ color: toneColor ?? 'var(--dsw-alias-label-tertiary)', display: 'inline-flex' }}>
        <Icon name={props.icon} />
      </span>
      <span data-sync-stat-value="" style={{ color: 'var(--dsw-alias-label-primary)' }}>{props.value}</span>
      <span data-sync-stat-label="" style={{ color: 'var(--dsw-alias-label-secondary)' }}>{props.label}</span>
      {props.hint ? <span data-sync-stat-hint="" style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{props.hint}</span> : null}
    </>
  )
  if (isBtn) {
    return (
      <button type="button" data-sync-stat="" role="button" aria-label={props.ariaLabel} onClick={props.onClick}>
        {inner}
      </button>
    )
  }
  return <div data-sync-stat="">{inner}</div>
}

// --- Small status badge -----------------------------------------------------------
export function Badge(props: { children: React.ReactNode; tone?: 'default' | 'success' | 'error' | 'warn' | 'brand'; icon?: IconName }) {
  const tone = props.tone ?? 'default'
  return (
    <span data-sync-badge="" data-tone={tone}>
      {props.icon ? <Icon name={props.icon} size={11} /> : null}
      {props.children}
    </span>
  )
}

// --- File + action helpers ---------------------------------------------------------
export function formatLastSync(v: string | null): string {
  if (!v) return 'never'
  try {
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return v
    return d.toLocaleString()
  } catch {
    return v
  }
}

export function fileIcon(path: string): IconName {
  if (path.startsWith('memories/daily/')) return 'calendar'
  if (path.startsWith('memories/projects/')) return 'folder'
  if (path === 'memories/MEMORY.md') return 'star'
  if (path.startsWith('sessions/')) return 'message'
  return 'file'
}

export function formatFile(path: string): { icon: IconName; title: string; path: string; meta: string } {
  if (path.startsWith('memories/daily/')) {
    const date = path.replace('memories/daily/', '').replace('.md', '')
    try {
      const d = new Date(date)
      if (!isNaN(d.getTime())) return { icon: 'calendar', title: `Daily notes — ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, path, meta: 'Daily' }
    } catch {}
    return { icon: 'calendar', title: `Daily notes — ${date}`, path, meta: 'Daily' }
  }
  if (path.startsWith('memories/projects/')) {
    const hash = path.split('/')[2] ?? ''
    return { icon: 'folder', title: 'Project memory', path, meta: hash.slice(0, 7) }
  }
  if (path === 'memories/MEMORY.md') return { icon: 'star', title: 'Global memory', path, meta: 'Global' }
  if (path.startsWith('sessions/')) {
    const hash = path.split('/')[1] ?? ''
    return { icon: 'message', title: 'Session', path, meta: hash.slice(0, 7) }
  }
  return { icon: 'file', title: path.split('/').pop() ?? path, path, meta: path.split('/')[0] ?? '' }
}

/** Exact action label — same-name files are never called "in sync" here. */
export function actionLabel(action: any): string {
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

export function actionTone(action: any): 'default' | 'success' | 'error' | 'warn' | 'brand' {
  switch (action?.action) {
    case 'copy':
      return 'brand'
    case 'merge':
      return 'success'
    case 'conflict':
      return 'error'
    default:
      return 'default'
  }
}

export function humanSummary(status: any): string {
  const localOnly = status?.localOnly ?? 0
  const remoteOnly = status?.remoteOnly ?? 0
  const both = status?.both ?? 0
  if (localOnly === 0 && remoteOnly === 0 && both === 0) return 'No eligible files found on either side.'
  return `${localOnly} only here · ${remoteOnly} only there · ${both} on both (content compared in Preview)`
}