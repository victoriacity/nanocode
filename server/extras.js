/**
 * Extras module — feature endpoints originally written for single-user
 * mode (settings / auth-status / tts proxy / services health / agents
 * manager / notify ws) extracted here so they can also be mounted by
 * the per-user worker in system mode.
 *
 * Single-user mode (server/index.js):
 *   import { createExtras } from './extras.js'
 *   const extras = createExtras({ store, configDir })
 *   app.use(extras.router)
 *   notifyWss.on('connection', extras.handleNotifyWs)
 *   extras.startWatchers()
 *
 * System mode worker (worker/index.js):
 *   same as above. The router proxies /ws/notify upgrades to the
 *   user's worker like any other WS path; the worker mounts the
 *   notify-ws handler from here.
 *
 * The state previously held in module-level closures of server/index.js
 * (TTS queue, services watcher map, agents config, auth-status cache)
 * is now per-instance, captured in createExtras's closure. That keeps
 * the worker's state isolated from the router's, matching the
 * one-worker-per-uid model the rest of system mode uses.
 */

import express from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

// Version stamp used by the notify-ws to tell browsers the server
// restarted. Computed at module load — the worker process picks up
// a fresh stamp on each respawn, the router on each restart.
export const ASSET_VERSION = String(Date.now())

const VALID_CLI_PROVIDERS = new Set(['claude', 'agent', 'opencode', 'codex'])
const AUTH_CACHE_MS = 60_000

const DEFAULT_SERVICES = [
  { name: 'mblend',      host: '10.18.8.55', port: 5050 },
  { name: 'dccpipeline', host: '10.18.8.55', port: 8765 },
  { name: 'regression',  host: '10.18.8.55', port: 8000 },
  { name: 'nanocode',    host: 'localhost',  port: 3001 },
  { name: 'TTS',         host: 'localhost',  port: 9880 },
]

const SERVICE_CHECK_MS = 30_000
const TTS_BASE = process.env.TTS_URL || 'http://127.0.0.1:9880'

export function createExtras({ store, configDir, qaWatcher } = {}) {
  if (!store) throw new Error('createExtras: { store } required')
  // Where services-config.json / agents-config.json live. The
  // single-user server uses server/, the worker uses
  // $HOME/.nanocode/ — caller passes the right one.
  const SERVICES_CONFIG_PATH = path.join(configDir || '.', 'services-config.json')
  const AGENTS_CONFIG_PATH   = path.join(configDir || '.', 'agents-config.json')

  // --- state -----------------------------------------------------

  let watchedServices = DEFAULT_SERVICES
  try { watchedServices = JSON.parse(readFileSync(SERVICES_CONFIG_PATH, 'utf8')) } catch {}
  const serviceStatus = {}
  for (const s of watchedServices) serviceStatus[s.name] = { status: 'unknown', checkedAt: null }

  let agentsConfig = []
  try { agentsConfig = JSON.parse(readFileSync(AGENTS_CONFIG_PATH, 'utf8')) } catch {}

  let authStatusCache = null
  let authStatusCacheAt = 0

  let ttsQueueTail = Promise.resolve()
  const ttsSerialize = (fn) => {
    const p = ttsQueueTail.then(fn, fn)
    ttsQueueTail = p.catch(() => {})
    return p
  }

  function getTtsConfig() {
    const s = store.getAllSettings()
    return {
      ref_audio_path: s.tts_ref_audio || '',
      prompt_text: s.tts_prompt_text || '',
      prompt_lang: s.tts_prompt_lang || 'zh',
      text_lang: s.tts_text_lang || 'en',
      media_type: s.tts_media_type || 'ogg',
    }
  }

  // --- broadcasting ----------------------------------------------

  const notifyClients = new Set()
  function broadcastNotify(msg) {
    const data = JSON.stringify(msg)
    for (const ws of notifyClients) {
      if (ws.readyState === 1) {
        try { ws.send(data) } catch {}
      }
    }
  }
  function handleNotifyWs(ws) {
    notifyClients.add(ws)
    ws.on('error', () => {})
    ws.on('close', () => notifyClients.delete(ws))
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'server_version', version: ASSET_VERSION })) } catch {}
    } else {
      ws.once('open', () => {
        try { ws.send(JSON.stringify({ type: 'server_version', version: ASSET_VERSION })) } catch {}
      })
    }
  }

  // --- router ----------------------------------------------------

  const router = express.Router()

  router.get('/api/version', (_req, res) => res.json({ version: ASSET_VERSION }))

  router.post('/api/notify/turn-complete', (req, res) => {
    const { elapsed, elapsedSec } = req.body || {}
    const sec = elapsedSec ?? (elapsed != null ? (elapsed / 1000).toFixed(0) : '?')
    qaWatcher?.pushTurnComplete?.({ elapsedSec: sec })
    res.json({ ok: true })
  })

  // Settings
  router.get('/api/settings', (_req, res) => res.json(store.getAllSettings()))
  router.put('/api/settings', (req, res) => {
    const { key, value } = req.body || {}
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value required' })
    }
    if (key === 'cli_provider' && !VALID_CLI_PROVIDERS.has(value)) {
      return res.status(400).json({ error: `Invalid cli_provider: ${value}` })
    }
    store.setSetting(key, value)
    res.json({ ok: true })
  })

  // Auth status (60s cache)
  router.get('/api/auth/status', async (_req, res) => {
    const now = Date.now()
    if (authStatusCache && now - authStatusCacheAt < AUTH_CACHE_MS) {
      return res.json(authStatusCache)
    }
    const result = await new Promise((resolve) => {
      execFile('claude', ['auth', 'status', '--json'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ loggedIn: false, error: err.message })
        try { resolve(JSON.parse(stdout.trim())) }
        catch { resolve({ loggedIn: false, error: 'parse error', raw: stdout.slice(0, 200) }) }
      })
    })
    authStatusCache = result
    authStatusCacheAt = now
    res.json(result)
  })

  // TTS proxy — graceful 503 if GPT-SoVITS isn't reachable.
  router.post('/api/tts', (req, res) => {
    const { text } = req.body || {}
    if (!text) return res.status(400).json({ error: 'text required' })
    ttsSerialize(() => handleTts(req, res, getTtsConfig()))
  })

  router.get('/api/tts/stream', async (req, res) => {
    const { text } = req.query
    if (!text) return res.status(400).json({ error: 'text required' })
    const cfg = getTtsConfig()
    const params = new URLSearchParams({
      text, text_lang: cfg.text_lang, ref_audio_path: cfg.ref_audio_path,
      prompt_text: cfg.prompt_text, prompt_lang: cfg.prompt_lang,
      media_type: cfg.media_type, streaming_mode: 'true',
    })
    try {
      const ttsRes = await fetch(`${TTS_BASE}/tts?${params}`)
      if (!ttsRes.ok) return res.status(502).json({ error: `TTS service ${ttsRes.status}` })
      res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
      res.set('Transfer-Encoding', 'chunked')
      const reader = ttsRes.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { res.end(); return }
          if (!res.write(value)) await new Promise((r) => res.once('drain', r))
        }
      }
      pump().catch(() => res.end())
      req.on('close', () => reader.cancel())
    } catch (err) {
      res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
    }
  })

  router.post('/api/tts/voice', async (req, res) => {
    const { ref_audio_path, prompt_text, prompt_lang } = req.body || {}
    if (!ref_audio_path) return res.status(400).json({ error: 'ref_audio_path required' })
    try {
      const params = new URLSearchParams({ refer_audio_path: ref_audio_path })
      const r = await fetch(`${TTS_BASE}/set_refer_audio?${params}`)
      if (!r.ok) return res.status(502).json({ error: `set_refer_audio ${r.status}` })
      store.setSetting('tts_ref_audio', ref_audio_path)
      if (prompt_text) store.setSetting('tts_prompt_text', prompt_text)
      if (prompt_lang) store.setSetting('tts_prompt_lang', prompt_lang)
      res.json({ ok: true })
    } catch (err) {
      res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
    }
  })

  router.get('/api/tts/status', async (_req, res) => {
    try {
      await fetch(`${TTS_BASE}/tts`, { signal: AbortSignal.timeout(2000) })
      res.json({ available: true, config: getTtsConfig() })
    } catch {
      res.json({ available: false, config: getTtsConfig() })
    }
  })

  // Services watcher
  router.get('/api/services', (_req, res) => res.json(serviceStatus))
  router.get('/api/services-config', (_req, res) =>
    res.json({ services: watchedServices, localIPs: getLocalIPs() })
  )
  router.put('/api/services-config', (req, res) => {
    const { services } = req.body
    if (!Array.isArray(services)) return res.status(400).json({ error: 'services must be array' })
    for (const s of services) {
      if (!s.name || !s.host || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
        return res.status(400).json({ error: `invalid entry: ${JSON.stringify(s)}` })
      }
    }
    watchedServices = services
    for (const s of services) {
      if (!serviceStatus[s.name]) serviceStatus[s.name] = { status: 'unknown', checkedAt: null }
    }
    for (const name of Object.keys(serviceStatus)) {
      if (!services.find((s) => s.name === name)) delete serviceStatus[name]
    }
    try { writeFileSync(SERVICES_CONFIG_PATH, JSON.stringify(services, null, 2)) }
    catch (e) { console.error('[services-config] write failed:', e.message) }
    res.json({ ok: true })
  })

  // Agent manager
  router.get('/api/agents', async (_req, res) => {
    const agents = await Promise.all(agentsConfig.map(async (a) => ({
      ...a,
      status: await checkTmuxWindow(a.tmuxWindow),
    })))
    res.json(agents)
  })
  router.put('/api/agents', (req, res) => {
    const agents = req.body
    if (!Array.isArray(agents)) return res.status(400).json({ error: 'expected array' })
    agentsConfig = agents
    try { writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(agents, null, 2)) } catch {}
    res.json({ ok: true })
  })
  router.get('/api/agents/discover', async (_req, res) => {
    try {
      const { stdout } = await execFileAsync(
        'tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_name}\t#{pane_current_command}'],
        { timeout: 5000 }
      )
      const windows = stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [target, cmd] = line.split('\t')
        const name = target.split(':').slice(1).join(':') || target
        const lc = (name + ' ' + (cmd || '')).toLowerCase()
        let type = 'other'
        if (lc.includes('claude')) type = 'claude'
        else if (lc.includes('codex')) type = 'codex'
        else if (lc.includes('cursor')) type = 'cursor'
        return { name, type, tmuxWindow: target, cmd: cmd || '' }
      })
      res.json(windows)
    } catch { res.json([]) }
  })

  // --- watchers (call startWatchers() after the express mount) --

  let watchersTimer = null
  function startWatchers() {
    if (watchersTimer) return
    setTimeout(() => runServiceChecks(watchedServices, serviceStatus, broadcastNotify), 5000)
    watchersTimer = setInterval(
      () => runServiceChecks(watchedServices, serviceStatus, broadcastNotify),
      SERVICE_CHECK_MS,
    )
    watchersTimer.unref?.()
    qaWatcher?.start?.(broadcastNotify)
  }

  return { router, handleNotifyWs, broadcastNotify, startWatchers, ASSET_VERSION }
}

// --- helpers ----------------------------------------------------

function getLocalIPs() {
  const ips = []
  for (const iface of Object.values(os.networkInterfaces() || {})) {
    for (const addr of iface || []) {
      if (!addr.internal && addr.family === 'IPv4') ips.push(addr.address)
    }
  }
  return ips
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => { sock.destroy(); resolve(true) })
    sock.setTimeout(2000)
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
    sock.on('error', () => resolve(false))
  })
}

async function checkTmuxWindow(target) {
  if (!target) return 'unknown'
  try { await execFileAsync('tmux', ['has-session', '-t', target], { timeout: 2000 }); return 'running' }
  catch { return 'stopped' }
}

async function runServiceChecks(services, status, broadcast) {
  for (const svc of services) {
    const prev = status[svc.name]?.status
    const up = await checkPort(svc.host, svc.port)
    const next = up ? 'up' : 'down'
    const checkedAt = new Date().toISOString()
    status[svc.name] = { status: next, checkedAt }
    if (prev && prev !== 'unknown' && prev !== next) {
      broadcast({ type: 'service_status', name: svc.name, status: next, checkedAt })
    }
  }
}

async function handleTts(req, res, cfg) {
  const { text } = req.body || {}
  const payload = {
    text,
    text_lang: cfg.text_lang,
    ref_audio_path: cfg.ref_audio_path,
    prompt_text: cfg.prompt_text,
    prompt_lang: cfg.prompt_lang,
    media_type: cfg.media_type,
    streaming_mode: false,
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ttsRes = await fetch(`${TTS_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      })
      if (!ttsRes.ok) {
        if (attempt < 2) continue
        const detail = await ttsRes.text().catch(() => '')
        return res.status(502).json({ error: `TTS service ${ttsRes.status}`, detail: detail.slice(0, 200) })
      }
      res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
      res.send(Buffer.from(await ttsRes.arrayBuffer()))
      return
    } catch (err) {
      if (attempt < 2) continue
      res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
    }
  }
}
