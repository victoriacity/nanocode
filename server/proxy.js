/**
 * HTTP + WebSocket proxy: router → user worker over Unix socket.
 *
 * The router authenticates a request, looks up the user's worker socket
 * from the session record, then opens a connection to the worker's HTTP
 * server (which is listening on that Unix socket). Headers pass through
 * with two additions:
 *   x-nano-uid: <numeric>
 *   x-nano-username: <string>
 *
 * The worker may use these for logging; it MUST NOT trust them for
 * authorization — every worker only ever sees one user (the one it
 * belongs to), so authorization is implicit.
 */

import http from 'node:http'

// A single keep-alive HTTP agent for every router→worker request.
//
// With the default globalAgent (keepAlive=false, maxSockets=Infinity)
// a page-load that fires ~13 concurrent asset requests triggers ~13
// brand-new socket() + connect() handshakes against the worker. Under
// burst, some get RST mid-handshake — the proxy then surfaces the
// failure to the browser as
//
//   {"error":"worker unavailable","detail":"ECONNRESET"}
//
// even though the worker is fully healthy. Empirically ~1.7% of
// requests under realistic page-load concurrency.
//
// keepAlive=true reuses warm sockets — no thundering herd. maxSockets
// caps the worker's concurrent inbound at a value its accept queue can
// drain comfortably. maxFreeSockets keeps the pool warm between pages.
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 30_000,
})

// Idempotent methods are safe to retry on a connection-reset error
// (the server can't have committed any state if the connection was
// never established or got RST before the request body was sent).
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE'])

/**
 * Forward an incoming http req/res to the user's worker. One retry
 * on connection-level failures for idempotent methods.
 */
export function proxyHttp(req, res, workerSock, user) {
  attempt(0)

  function attempt(tries) {
    const proxyReq = http.request({
      agent,
      socketPath: workerSock,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: 'worker.local',
        'x-nano-uid': String(user.uid),
        'x-nano-username': user.username,
      },
    })

    proxyReq.on('response', (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      const retryable =
        tries < 1 &&
        !res.headersSent &&
        RETRYABLE_METHODS.has(req.method) &&
        RETRYABLE_CODES.has(err.code)
      if (retryable) {
        return attempt(tries + 1)
      }
      if (!res.headersSent) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'worker unavailable', detail: err.code || err.message }))
      } else {
        res.destroy(err)
      }
    })

    req.pipe(proxyReq)
    req.on('error', () => proxyReq.destroy())
  }
}

/**
 * Forward a WebSocket upgrade to the user's worker.
 */
export function proxyWsUpgrade({ req, socket, head, workerSock, user }) {
  const headers = {
    ...req.headers,
    host: 'worker.local',
    'x-nano-uid': String(user.uid),
    'x-nano-username': user.username,
  }
  const proxyReq = http.request({
    socketPath: workerSock,
    method: 'GET',
    path: req.url,
    headers,
  })

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 101 Switching Protocols\r\n`
    const hdrLines = Object.entries(proxyRes.headers)
      .map(([k, v]) => Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`).join('\r\n') : `${k}: ${v}`)
      .join('\r\n')
    socket.write(statusLine + hdrLines + '\r\n\r\n')
    if (proxyHead && proxyHead.length) socket.write(proxyHead)
    if (head && head.length) proxySocket.write(head)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
    const close = () => {
      try { socket.destroy() } catch {}
      try { proxySocket.destroy() } catch {}
    }
    socket.on('close', close)
    proxySocket.on('close', close)
    socket.on('error', close)
    proxySocket.on('error', close)
  })

  proxyReq.on('response', (proxyRes) => {
    // Worker rejected the upgrade — proxy the HTTP response through.
    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`)
    for (const [k, v] of Object.entries(proxyRes.headers)) socket.write(`${k}: ${v}\r\n`)
    socket.write('\r\n')
    proxyRes.pipe(socket)
  })

  proxyReq.on('error', (err) => {
    socket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nworker unavailable: ${err.code || err.message}`)
    socket.destroy()
  })

  proxyReq.end()
}
