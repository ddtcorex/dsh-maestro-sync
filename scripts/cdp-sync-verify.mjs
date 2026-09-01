// Live verify: settings card shows real status counts and Preview Pull lists real actions.
// Usage: DSH_WEB_TOKEN=... node scripts/cdp-sync-verify.mjs [mobile|desktop]
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = process.env.DSH_WEB_TOKEN || ''
const SESSION_ID = process.env.DSH_SESSION_ID || 'session-5674e8fd-f84a-4437-b648-b660fe59dbc9'
const TOKEN_URL = `http://127.0.0.1:3080/?token=${TOKEN}`
const MODE = process.argv[2] ?? 'mobile'
const VIEW = MODE === 'mobile' ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, hasTouch: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false }

function allocPort() {
  return new Promise((res) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => res(p))
    })
  })
}
function rpc(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++rpc._seq
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data.toString())
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      if (m.error) rej(new Error(method + ': ' + JSON.stringify(m.error)))
      else res(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
rpc._seq = 0

async function evalJs(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

async function main() {
  const port = await allocPort()
  const userData = mkdtempSync(join(tmpdir(), 'sync-verify-'))
  const chrome = spawn('/opt/google/chrome/chrome', [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=' + port, '--user-data-dir=' + userData,
  ], { stdio: 'ignore' })
  let ws = null
  try {
    // wait for devtools endpoint
    let pages
    for (let i = 0; i < 50; i++) {
      try {
        pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
        if (pages?.length) break
      } catch {}
      await new Promise((r) => setTimeout(r, 200))
    }
    const page = pages.find((p) => p.type === 'page')
    ws = await new Promise((res, rej) => {
      const w = new WebSocket(page.webSocketDebuggerUrl)
      w.addEventListener('open', () => res(w))
      w.addEventListener('error', (e) => rej(new Error('ws error')))
    })

    await rpc(ws, 'Emulation.setDeviceMetricsOverride', VIEW)
    await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: SESSION_ID }))}); } catch (e) {}`,
    })
    await rpc(ws, 'Page.navigate', { url: TOKEN_URL })
    await new Promise((r) => setTimeout(r, 3000))
    // wait for app
    for (let i = 0; i < 50; i++) {
      const ready = await evalJs(ws, `typeof window.__DSH_BOOT__ === 'object' && !!(document.querySelector('[data-maestro-logo]') || document.body.innerText.includes('Settings'))`)
      if (ready) break
      await new Promise((r) => setTimeout(r, 300))
    }
    // open Settings -> Maestro Sync (mirrors cdp-sync-probe.mjs navigation)
    await evalJs(ws, `(() => { const b = document.querySelector('button[aria-label="Open sidebar"]'); if (b) { b.click(); return true; } return false; })()`)
    await new Promise((r) => setTimeout(r, 1200))
    const settingsBtn = await evalJs(ws, `(() => {
        const els = Array.from(document.querySelectorAll('button, [role="button"]'));
        const hit = els.find((el) => {
          const label = el.getAttribute('aria-label') || el.title || (el.textContent || '');
          return label.trim().toLowerCase() === 'settings';
        });
        if (!hit) return null;
        hit.click();
        return true;
      })()`)
    if (!settingsBtn) throw new Error('settings trigger not found')
    await new Promise((r) => setTimeout(r, 1400))
    const syncNav = await evalJs(ws, `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;
        const btns = Array.from(dialog.querySelectorAll('button'));
        const hit = btns.find((el) => (el.textContent || '').trim().toLowerCase().includes('maestro sync'));
        if (!hit) return null;
        hit.click();
        return true;
      })()`)
    if (!syncNav) throw new Error('maestro sync trigger not found')
    // wait for status to resolve (no longer "Checking connection…")
    let cardText = ''
    for (let i = 0; i < 60; i++) {
      cardText = await evalJs(ws, `(() => { const c = document.querySelector('[data-sync-card], [data-maestro-logo]'); if (!c) return ''; let el = c; for (let k = 0; k < 6 && el; k++) { if ((el.innerText || '').includes('REMOTE HOST')) break; el = el.parentElement; } return (el || c).innerText })()`)
      if (!cardText.includes('Checking connection')) break
      await new Promise((r) => setTimeout(r, 500))
    }
    // stats + status line
    const body = await evalJs(ws, `document.body.innerText`)
    const statTiles = await evalJs(ws, `(() => { const tiles = [...document.querySelectorAll('[data-stat-tile], [data-stat]')].map((t) => t.innerText.replace(/\\n/g, ' ')); return tiles })()`)
    // wait for bucket page loads to settle (data-sync-file rows appear)
    for (let i = 0; i < 60; i++) {
      const n = await evalJs(ws, `document.querySelectorAll('[data-sync-file]').length`)
      if (n > 0) break
      await new Promise((r) => setTimeout(r, 500))
    }
    // dump the file-list sections verbatim (no preview click, avoids busy noise)
    const listSections = await evalJs(ws, `(() => {
        const el = document.querySelector('[data-sync-card], [data-maestro-logo]');
        if (!el) return [];
        let root = el; for (let k = 0; k < 6 && root; k++) { if ((root.innerText || '').includes('Coming from the other machine')) break; root = root.parentElement; }
        if (!root) return [];
        return { section: (root.innerText || '').slice(0, 2000) };
      })()`)
    await evalJs(ws, `(() => { const el = document.querySelector('[data-testid="sync-preview-pull"]'); if (el) el.click(); return !!el })()`)
    let dialog = null
    // remote preview runs an SSH checksum dry-run; stage can take 2+ min on a slow link
    for (let i = 0; i < 360; i++) {
      const alertHit = await evalJs(ws, `(() => { const a = document.querySelector('[role="alert"]'); return a ? a.innerText.slice(0, 300) : null })()`)
      if (alertHit) { dialog = { alert: alertHit, rows: 0 }; break }
      dialog = await evalJs(ws, `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => (x.innerText || '').includes('Cancel') && (x.innerText || '').includes('Apply')); if (!d) return null; return { text: d.innerText.slice(0, 800), rows: d.querySelectorAll('[data-action-row]').length, hasPreviewId: !!(d.innerText || '').match(/[a-f0-9]{32}/) } })()`)
      if (dialog) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const listSectionsOut = listSections
    const statLines = body.split('\n').filter((l) => /^\d+$/.test(l.trim())).slice(0, 6)

    const out = {
      mode: MODE,
      hasCard: await evalJs(ws, `!!document.querySelector('[data-maestro-logo]')`),
      statusResolved: !cardText.includes('Checking connection'),
      cardHead: cardText.slice(0, 160).replace(/\n/g, ' | '),
      statTiles,
      statsDigits: statLines,
      previewButtonClicked: !!(await evalJs(ws, `!!document.querySelector('[data-testid="sync-preview-pull"]')`)),
      lists: listSectionsOut,
      dialog,
    }
    console.log(JSON.stringify(out, null, 2))
  } finally {
    ws?.close()
    chrome.kill('SIGKILL')
  }
}
main().catch((e) => { console.error(e); process.exit(1) })