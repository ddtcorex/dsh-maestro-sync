import * as React from 'react'
import { RPC_CHANNEL } from './ui.js'

/**
 * Shared Sync state machine — confirmation-first Preview/Apply.
 * - Preview is read-only; apply exists only inside a confirmation dialog bound
 *   to the live preview id, with {confirm:true}. Escape cancels; nothing applies
 *   without confirmation.
 * - status pages two buckets (localOnly / remoteOnly) with cursors.
 */

export interface SyncConnection {
  ok: boolean
  host: string
  latencyMs?: number
  error?: string
}

export interface PageState {
  files: string[]
  total: number
  next: number | null
}

export type Bucket = 'localOnly' | 'remoteOnly'

export function useSync(ctx: any) {
  const [remoteHost, setRemoteHost] = React.useState<string>('…')
  const [lastSync, setLastSync] = React.useState<string | null>(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-maestro-sync:lastSync') : null
    } catch {
      return null
    }
  })
  const [status, setStatus] = React.useState<any>(null)
  const [connection, setConnection] = React.useState<SyncConnection | null>(null)
  const [checking, setChecking] = React.useState<boolean>(true)
  const [busy, setBusy] = React.useState<boolean>(false)
  const [result, setResult] = React.useState<{ kind: string; ok: boolean; text: string } | null>(null)
  const [error, setError] = React.useState<string>('')
  const [preview, setPreview] = React.useState<any>(null)
  const [previewDirection, setPreviewDirection] = React.useState<'pull' | 'push'>('pull')
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [actionLimit, setActionLimit] = React.useState(5)
  const [progress, setProgress] = React.useState<{ phase: string; current: number; total: number; file?: string } | null>(null)
  const cancelledRef = React.useRef(false)
  const [pages, setPages] = React.useState<Record<Bucket, PageState>>({
    localOnly: { files: [], total: 0, next: null },
    remoteOnly: { files: [], total: 0, next: null },
  })

  // dsh-client-connection decodes every RPC response as the carrier shape
  // { ok: true, value } | { ok: false, error: { code, message, details } }.
  // Unwrap to the payload; normalize the failure error to a string.
  const call = React.useCallback(async (method: string, payload: any): Promise<any> => {
    const conn = (ctx as any).connection ?? (ctx as any).get?.('connection')
    if (!conn?.rpc?.call) throw new Error('RPC not available')
    const res: any = await conn.rpc.call(RPC_CHANNEL, method, payload)
    if (res && typeof res === 'object' && 'ok' in res) {
      if (res.ok) return res.value
      const err = res.error
      if (typeof err === 'string') return { ok: false, error: err }
      return { ok: false, error: err?.message ?? 'RPC failed', code: typeof err?.code === 'string' ? err.code : undefined }
    }
    return res
  }, [ctx])

  const loadPage = React.useCallback(
    async (bucket: Bucket, cursor: number) => {
      try {
        const res: any = await call('status', { bucket, cursor, limit: 10 })
        if (!res) return
        setPages((prev) => ({
          ...prev,
          [bucket]: {
            files: cursor === 0 ? (res.files ?? []) : [...prev[bucket].files, ...(res.files ?? [])],
            total: res.total ?? prev[bucket].total,
            next: res.nextCursor ?? null,
          },
        }))
      } catch {
        // page load failure is non-fatal
      }
    },
    [call],
  )

  const loadStatus = React.useCallback(async () => {
    // a refresh invalidates previous status/action state (the last announcement
    // stays visible until the next user action)
    setError('')
    setChecking(true)
    setStatus(null)
    try {
      const res: any = await call('status', {})
      if (res?.ok === false) {
        setError(res?.error ?? 'status failed')
        return
      }
      setStatus(res)
      const conn = (res as any)?.connection ?? null
      if (conn) setConnection(conn)
      else setConnection({ ok: true, host: (res as any)?.remoteHost ?? 'kai@ssh.ddtcorex.com' })
      if (typeof (res as any)?.remoteHost === 'string' && (res as any).remoteHost) setRemoteHost((res as any).remoteHost)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setChecking(false)
    }
    await loadPage('localOnly', 0)
    await loadPage('remoteOnly', 0)
  }, [call, loadPage])

  React.useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const persistLastSync = React.useCallback((ts: string) => {
    setLastSync(ts)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-maestro-sync:lastSync', ts)
    } catch {}
  }, [])

  const handlePreview = React.useCallback(
    async (direction: 'pull' | 'push') => {
      setBusy(true)
      setError('')
      setResult(null)
      setActionLimit(5)
      setProgress({ phase: 'listing', current: 0, total: 1 })
      try {
        // Asynchronous count-only preview: start the job, poll progress (the
        // host hashes sessions over ssh, one progress tick per file) until the
        // preview settles, then open the confirmation dialog.
        const start: any = await call('previewStart', { direction })
        const jobId = start?.jobId
        if (!jobId) {
          setError(start?.error ?? 'Preview failed to start')
          setProgress(null)
          return
        }
        let done = false
        while (!done && !cancelledRef.current) {
          const st: any = await call('previewStatus', { jobId })
          if (st?.status === 'running' && st?.progress) {
            setProgress({ phase: st.progress.phase, current: st.progress.current, total: st.progress.total, file: st.progress.file })
          }
          if (st?.status === 'done') {
            if (st.preview) {
              setPreview(st.preview)
              setPreviewDirection(direction)
              setConfirmOpen(true)
            } else {
              setError('Preview finished without a result')
            }
            done = true
          } else if (st?.status === 'error') {
            setError(st.error ?? 'Preview failed')
            done = true
          } else if (st?.ok === false) {
            setError(st.error ?? 'Preview failed')
            done = true
          } else {
            await new Promise((r) => setTimeout(r, 700))
          }
        }
      } catch (e: any) {
        setError(e?.message ?? String(e))
      } finally {
        setBusy(false)
        setProgress(null)
      }
    },
    [call],
  )

  const handleApply = React.useCallback(async () => {
    if (!preview?.previewId) return
    setBusy(true)
    setError('')
    const previewId = preview.previewId
    const direction = previewDirection
    try {
      const res: any = await call('apply', { previewId, direction, confirm: true })
      setConfirmOpen(false)
      setPreview(null)
      if (res?.ok === false) {
        const label = typeof res.code === 'string' ? res.code : 'apply failed'
        setError(`${label}: ${res?.error ?? 'apply failed'}`)
        setResult({ kind: 'apply', ok: false, text: 'Apply failed' })
        return
      }
      setResult({ kind: 'apply', ok: true, text: `Applied preview ${previewId.slice(0, 8)} — committed ${(res?.committed ?? []).length} file(s), +${res?.summary?.added ?? 0} entries` })
      persistLastSync(new Date().toISOString())
      void loadStatus()
    } catch (e: any) {
      setConfirmOpen(false)
      setPreview(null)
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [preview, previewDirection, call, loadStatus, persistLastSync])

  const cancelDialog = React.useCallback(() => {
    setConfirmOpen(false)
    setPreview(null)
  }, [])

  React.useEffect(() => {
    if (!confirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmOpen, cancelDialog])

  return {
    remoteHost,
    lastSync,
    status,
    connection,
    checking,
    busy,
    result,
    error,
    preview,
    previewDirection,
    confirmOpen,
    actionLimit,
    progress,
    pages,
    setActionLimit,
    setError,
    setResult,
    loadStatus,
    loadPage,
    handlePreview,
    handleApply,
    cancelDialog,
  }
}

export type SyncState = ReturnType<typeof useSync>