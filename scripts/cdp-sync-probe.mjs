#!/usr/bin/env node
/**
 * CDP probe for the redesigned Maestro Sync settings card (mobile + desktop).
 * - Fresh user-data-dir per probe; authenticates via the live process token,
 *   sets the session id + viewport, opens the sidebar (mobile) then Settings.
 * - Navigates to the Maestro Sync section, screenshots the card, reports
 *   overflow + key geometry at 390 and 1440 widths.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const TOKEN = process.env.DSH_WEB_TOKEN || 'L3L3mRdW6jqHK_RUCa20XSGLK6Z_YeHCgHUPNMDvhvU'
const TOKEN_URL = `http://127.0.0.1:3080/?token=${TOKEN}`
const SESSION_ID = process.env.DSH_SESSION_ID || 'session-5674e8fd-f84a-4437-b648-b660fe59dbc9'
const CHROME = '/opt/google/chrome/chrome'
const SCREENSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'screenshots')

function allocPort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

let msgId = 0
function rpc(ws, method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id === id) {
        ws.removeEventListener('message', onMsg)
        data.error ? reject(new Error(data.error.message)) : resolve(data.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(ws, expression) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}

async function shot(ws, path) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(join(SCREENSHOT_DIR, path), Buffer.from(r.data, 'base64'))
  console.log('  screenshot ->', join(SCREENSHOT_DIR, path))
}

async function click(ws, x, y) {
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(300)
}

async function queryStats(ws) {
  return evalJs(
    ws,
    `(() => {
      const doc = document.documentElement;
      const syncCard = document.querySelector('[data-sync-root]');
      const syncList = document.querySelector('[data-sync-filetables]');
      const cols = document.querySelectorAll('[data-sync-dcol]');
      return {
        vw: doc.clientWidth,
        vh: doc.clientHeight,
        overflowX: doc.scrollWidth - doc.clientWidth,
        overflowY: doc.scrollHeight - doc.clientHeight,
        scrollW: doc.scrollWidth,
        scrollH: doc.scrollHeight,
        hasCard: !!syncCard,
        cardW: syncCard ? Math.round(syncCard.getBoundingClientRect().width) : null,
        cardTop: syncCard ? Math.round(syncCard.getBoundingClientRect().top) : null,
        cardBottom: syncCard ? Math.round(syncCard.getBoundingClientRect().bottom) : null,
        hasFileTables: !!syncList,
        fileTablesW: syncList ? Math.round(syncList.getBoundingClientRect().width) : null,
        colCount: cols.length,
        visibleCols: Array.from(cols).filter((c) => getComputedStyle(c).display !== 'none').length,
        logo: !!document.querySelector('[data-maestro-logo]'),
        title: syncCard ? (syncCard.querySelector('div')?.textContent || '').slice(0, 40) : '',
        statsTiles: document.querySelectorAll('[data-sync-stat]').length,
      };
    })()`,
  )
}

async function probe(width, height, mobile, label) {
  console.log(`\n=== probe ${label} ${width}x${height} mobile=${mobile} ===`)
  const port = await allocPort()
  const userData = mkdtempSync(join(tmpdir(), 'dsh-sync-probe-'))
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--window-size=1440,900', 'about:blank'],
    { stdio: 'ignore' },
  )
  try {
    let target = null
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
        target = list.find((t) => t.type === 'page')
        if (target) break
      } catch {}
    }
    if (!target) throw new Error('no chrome page target')
    const ws = await new Promise((res, rej) => {
      const w = new WebSocket(target.webSocketDebuggerUrl)
      w.onopen = () => res(w)
      w.onerror = rej
    })

    await rpc(ws, 'Page.enable')
    await rpc(ws, 'Runtime.enable')
    await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile, hasTouch: mobile })
    await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage['dsh.sessions.current'] = JSON.stringify({ sessionId: ${JSON.stringify(SESSION_ID)} });`,
    })
    await rpc(ws, 'Page.navigate', { url: TOKEN_URL })
    await sleep(4500)

    // Mobile: the left sidebar is an off-canvas rail — open it via JS click
    if (mobile) {
      const opened = await evalJs(ws, `(() => { const b = document.querySelector('button[aria-label="Open sidebar"]'); if (b) { b.click(); return true; } return false; })()`)
      console.log('  open sidebar (JS):', opened)
      await sleep(1200)
    }

    // Open settings — sidebar footer "Settings" row (JS click bypasses offscreen geometry)
    const settingsBtn = await evalJs(
      ws,
      `(() => {
        const els = Array.from(document.querySelectorAll('button, [role="button"]'));
        const hit = els.find((el) => {
          const label = el.getAttribute('aria-label') || el.title || (el.textContent || '');
          return label.trim().toLowerCase() === 'settings';
        });
        if (!hit) return null;
        hit.click();
        return { text: (hit.textContent || '').trim().slice(0, 20) };
      })()`,
    )
    if (!settingsBtn) throw new Error('settings trigger not found')
    console.log('  settings clicked:', JSON.stringify(settingsBtn))
    await sleep(1400)

    // Navigate to the Maestro Sync settings section
    const syncNav = await evalJs(
      ws,
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;
        const btns = Array.from(dialog.querySelectorAll('button'));
        const hit = btns.find((b) => (b.textContent || '').trim() === 'Maestro Sync' || (b.getAttribute('aria-label') || '') === 'Maestro Sync');
        if (!hit) return null;
        hit.click();
        return { text: 'Maestro Sync' };
      })()`,
    )
    if (syncNav) {
      console.log('  nav clicked:', JSON.stringify(syncNav))
    } else {
      console.log('  [warn] Maestro Sync nav row not found')
    }
    await sleep(2200)

    const stats = await queryStats(ws)
    console.log('  settings:', JSON.stringify(stats))
    await shot(ws, `sync-settings-${label}.png`)

    ws.close()
    return { label, settings: stats }
  } catch (e) {
    console.log('  [error]', e.message)
    return { label, error: e.message }
  } finally {
    chrome.kill('SIGKILL')
  }
}

const results = []
results.push(await probe(390, 844, true, 'mobile'))
results.push(await probe(1440, 900, false, 'desktop'))
console.log('\n=== SUMMARY ===')
for (const r of results) console.log(JSON.stringify(r))
