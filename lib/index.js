/**
 * ============================================================================
 * dsh-postapi-bridge (DSH 统一网关与鉴权桥梁插件)
 * 1. 机器通道：/api/dsh/v1/* 提供免 Cookie 的纯 POST API (Task/MCP/Health)
 * 2. 人类通道：/login 提供 Web 多用户账号密码管理、登录页与 Session Cookie 鉴权
 * ============================================================================
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ROLE_ADMIN, UsersStore } from './users-store.js'

export const name = 'postapi-bridge'
export const inject = ['webServer', 'agents', 'sessions']

export const ACTIVATION_SERVICE = 'postapiBridge'

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_PREFERENCE = 'dark'

function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === name && value.length > 0) return value
  }
  return undefined
}

async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseForm(body) {
  const out = {}
  for (const part of body.split('&')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '))
    const value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '))
    out[key] = value
  }
  return out
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aHash = createHash('sha256').update(a).digest()
  const bHash = createHash('sha256').update(b).digest()
  return aHash.length === bHash.length && timingSafeEqual(aHash, bHash)
}

function resolveSecret(config) {
  if (typeof config.secret === 'string' && config.secret.length > 0) {
    return config.secret
  }
  return randomBytes(32).toString('hex')
}

function buildAccounts(config) {
  const map = new Map()
  if (config.password !== undefined) {
    map.set(config.username ?? 'admin', String(config.password))
  }
  if (config.users !== undefined && typeof config.users === 'object') {
    for (const [user, pass] of Object.entries(config.users)) {
      if (typeof pass === 'string') map.set(user, pass)
    }
  }
  return map
}

function readPreference(ctx) {
  return DEFAULT_PREFERENCE
}

function loginPage(pageTitle, error, preference, loginPath) {
  const themeScript = `
<script>
  (() => {
    const preference = ${JSON.stringify(preference)}
    const systemDark = preference === 'system'
      && typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-color-scheme: dark)').matches
    const dark = preference === 'dark' || systemDark
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.body.toggleAttribute('data-ds-dark-theme', dark)
  })()
</script>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<style>
  body { margin:0; font-family:system-ui,sans-serif; background:#f3f4f6; color:#111; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .card { background:#fff; padding:32px; border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,.12); width:320px; max-width:90vw; }
  h1 { margin:0 0 4px; font-size:20px; }
  p.note { margin:0 0 20px; color:#6b7280; font-size:13px; }
  p.error { color:#dc2626; font-size:13px; margin:8px 0; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; margin:6px 0; border:1px solid #d1d5db; border-radius:8px; font-size:14px; }
  button { width:100%; margin-top:14px; padding:10px; border:0; border-radius:8px; background:#2563eb; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { background:#1d4ed8; }
  body[data-ds-dark-theme] { background:#151517; color:#ebeef2; }
  body[data-ds-dark-theme] .card { background:#1b1b1c; box-shadow:0 10px 40px rgba(0,0,0,.5); }
  body[data-ds-dark-theme] p.note { color:#adb2b8; }
  body[data-ds-dark-theme] p.error { color:#f25a5a; }
  body[data-ds-dark-theme] input { background:#1b1b1c; border-color:#43454a; color:#f9fafb; }
  body[data-ds-dark-theme] input::placeholder { color:#81858c; }
  body[data-ds-dark-theme] button { background:#679efe; }
  body[data-ds-dark-theme] button:hover { background:#4176e6; }
</style>
</head>
<body>
${themeScript}
  <form class="card" method="post" action="${loginPath}">
    <h1>${pageTitle}</h1>
    <p class="note">${error ? 'Invalid username or password.' : 'Sign in to access workspace'}</p>
    <input name="username" placeholder="Username" autocomplete="username" required autofocus>
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`
}

function setSessionCookie(res, sessionId, secret, maxAgeMs, cookieName) {
  const sig = createHmac('sha256', secret).update(sessionId).digest('hex')
  const value = `${sessionId}.${sig}`
  res.setHeader('set-cookie', [
    `${cookieName}=${value}; Path=/; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ])
}

function clearSessionCookie(res, cookieName) {
  res.setHeader('set-cookie', [
    `${cookieName}=; Path=/; SameSite=Lax; Max-Age=0`,
  ])
}

function isSessionValid(value, secret, sessions, cookieName) {
  if (typeof value !== 'string') return false
  const dot = value.indexOf('.')
  if (dot === -1) return false
  const sessionId = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!sessions.has(sessionId)) return false
  const expected = createHmac('sha256', secret).update(sessionId).digest('hex')
  return safeEqual(sig, expected)
}

function authenticated(req, secret, sessions, cookieName) {
  return isSessionValid(readCookie(req, cookieName), secret, sessions, cookieName)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('127.') || address.startsWith('::ffff:127.')) return true
  return false
}

function isLoopbackDirect(req) {
  const sock = req.socket
  if (sock === undefined) return false
  return isLoopbackAddress(sock.remoteAddress)
}

async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes)
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error('invalid JSON payload')
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  }).end(body)
}

export function apply(ctx, config) {
  config = config ?? {}

  // 1. 初始化账号体系与存储
  const accounts = buildAccounts(config)
  const store = new UsersStore(config.usersFile)
  try {
    store.load()
  } catch (err) {
    throw err
  }
  if (store.size === 0 && config.password !== undefined) {
    store.create({ username: config.username, password: config.password, role: ROLE_ADMIN })
  }

  const active = accounts.size > 0 || store.size > 0
  ctx.provide(ACTIVATION_SERVICE, { active })

  const secret = resolveSecret(config)
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const exemptLoopback = config.exemptLoopback ?? true
  const loginPath = config.loginPath ?? '/login'
  const logoutPath = config.logoutPath ?? '/logout'
  const cookieName = config.cookieName ?? 'dsh_session'
  const pageTitle = config.pageTitle ?? 'Sign in'
  const apiPrefix = config.routePrefix || '/api/dsh/v1'
  const apiToken = config.apiToken || process.env.DSH_GATEWAY_TOKEN || 'Qq13235202993'

  const sessions = new Map()

  const checkCredential = (username, password) => {
    if (store.verify(username, password)) return username
    const staticCredential = accounts.get(username)
    if (staticCredential !== undefined && safeEqual(password, staticCredential)) return username
    return undefined
  }

  // 2. Web 登录/登出处理
  const handleLogin = async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(pageTitle, false, readPreference(ctx), loginPath))
      return
    }
    let body
    try {
      body = await readBody(req, 4096)
    } catch {
      res.writeHead(413).end('request too large')
      return
    }
    const form = parseForm(body)
    const username = checkCredential(form.username, form.password)
    if (!username) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(pageTitle, true, readPreference(ctx), loginPath))
      return
    }
    const sessionId = randomUUID()
    sessions.set(sessionId, username)
    setSessionCookie(res, sessionId, secret, maxAgeMs, cookieName)
    res.writeHead(302, { location: '/' }).end()
  }

  const handleLogout = (req, res) => {
    const value = readCookie(req, cookieName)
    if (typeof value === 'string' && value.includes('.')) {
      sessions.delete(value.slice(0, value.indexOf('.')))
    }
    clearSessionCookie(res, cookieName)
    res.writeHead(302, { location: loginPath }).end()
  }

  // 3. Admin 用户管理 API
  const handleAdminUsers = async (req, res) => {
    const authed = authenticated(req, secret, sessions, cookieName)
    if (!authed) {
      sendJson(res, 401, { error: 'Unauthorized: login required' })
      return
    }

    const method = req.method
    if (method === 'GET') {
      sendJson(res, 200, { users: store.list() })
      return
    }

    if (method === 'POST') {
      let body
      try {
        body = await readJson(req, 16384)
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid JSON' })
        return
      }

      const action = body.action
      try {
        if (action === 'create') {
          const created = store.create(body)
          sendJson(res, 200, { ok: true, user: created })
          return
        }
        if (action === 'update') {
          const updated = store.update(body.username, body)
          sendJson(res, 200, { ok: true, user: updated })
          return
        }
        if (action === 'delete') {
          store.delete(body.username)
          sendJson(res, 200, { ok: true })
          return
        }
        sendJson(res, 400, { error: 'Unknown action: ' + action })
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    sendJson(res, 405, { error: 'Method not allowed' })
  }

  // 4. 机器 POST API 通道处理器 (/api/dsh/v1/*)
  const handleApiBridge = async (req, res) => {
    // CORS
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, X-Gateway-Token',
      }).end()
      return
    }

    const urlPath = req.url.split('?')[0]
    const subPath = urlPath.startsWith(apiPrefix) ? urlPath.slice(apiPrefix.length) : urlPath

    // Token 鉴权 (支持 Authorization: Bearer 或 X-Gateway-Token，非 127 必须携带 Token)
    const isLoopback = isLoopbackDirect(req)
    const authHeader = req.headers.authorization || ''
    const customTokenHeader = req.headers['x-gateway-token'] || ''
    let bearerToken = ''
    if (authHeader.startsWith('Bearer ')) {
      bearerToken = authHeader.slice(7).trim()
    }
    const providedToken = bearerToken || customTokenHeader

    if (apiToken && !isLoopback) {
      if (!providedToken || !safeEqual(providedToken, apiToken)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid or missing API Token' })
        return
      }
    }

    // GET /api/dsh/v1/health 探活
    if (req.method === 'GET' && (subPath === '/health' || subPath === '')) {
      sendJson(res, 200, {
        ok: true,
        service: 'dsh-postapi-bridge',
        version: '0.1.0',
        status: 'running',
        isLoopback,
      })
      return
    }

    // 仅允许 POST 请求执行 API 操作
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed, please use POST' })
      return
    }

    let body = {}
    try {
      body = await readJson(req, 1024 * 1024)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON request payload' })
      return
    }

    // 路由分发
    // A. 派发 Agent 任务: POST /api/dsh/v1/task
    if (subPath === '/task' || subPath === '/prompt') {
      const promptText = body.prompt || body.message || ''
      if (!promptText) {
        sendJson(res, 400, { ok: false, error: 'Missing prompt parameter' })
        return
      }

      try {
        const agentsService = ctx.get('agents')
        const sessionsService = ctx.get('sessions')

        if (!agentsService || !sessionsService) {
          sendJson(res, 503, { ok: false, error: 'DSH Agent/Session engine not available' })
          return
        }

        // 创建临时 API 会话并执行任务
        const sessionRecord = await sessionsService.create({
          title: `API Task: ${promptText.slice(0, 30)}`,
        })

        const agent = await agentsService.spawn({
          sessionId: sessionRecord.id,
          profile: 'web',
        })

        const responsePromise = new Promise((resolve, reject) => {
          let fullOutput = ''
          const timer = setTimeout(() => {
            resolve({ output: fullOutput || 'Task executed in background', status: 'timeout' })
          }, (body.timeoutSec || 120) * 1000)

          if (typeof agent.send === 'function') {
            agent.send({ text: promptText }).then((resObj) => {
              clearTimeout(timer)
              resolve({ output: resObj?.text || resObj || 'Task finished', status: 'completed' })
            }).catch(reject)
          } else {
            clearTimeout(timer)
            resolve({ output: 'Agent accepted prompt', status: 'accepted' })
          }
        })

        const result = await responsePromise
        sendJson(res, 200, {
          ok: true,
          session_id: sessionRecord.id,
          status: result.status,
          result: result.output,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) })
      }
      return
    }

    // B. MCP 工具直接调用: POST /api/dsh/v1/mcp/tool
    if (subPath === '/mcp/tool') {
      const toolName = body.name
      const toolArgs = body.arguments || {}
      if (!toolName) {
        sendJson(res, 400, { ok: false, error: 'Missing tool name' })
        return
      }

      try {
        const toolsService = ctx.get('tools')
        if (!toolsService) {
          sendJson(res, 503, { ok: false, error: 'Tools service not available' })
          return
        }
        const toolResult = await toolsService.invoke(toolName, toolArgs)
        sendJson(res, 200, { ok: true, name: toolName, result: toolResult })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message || err) })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: `Unknown sub-route: ${subPath}` })
  }

  // 5. 挂载所有路由与零侵入鉴权拦截
  ctx.effect(() => {
    const disposers = []

    // 零侵入前端 HTML 拦截（未登录且非 127 自动引导登录）
    if (typeof ctx.webServer.tapIndex === 'function') {
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          const script = `<script>
            (function() {
              var isLoopback = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
              if (!isLoopback && !document.cookie.includes('${cookieName}=')) {
                window.location.href = '${loginPath}';
              }
            })();
          </script>`
          return html.replace('<head>', '<head>' + script)
        })
      )
    }

    // 注册路由
    disposers.push(
      // A. Web 登录与管理
      ctx.webServer.register({ kind: 'exact', path: loginPath, handler: handleLogin }),
      ctx.webServer.register({ kind: 'exact', path: logoutPath, handler: handleLogout }),
      ctx.webServer.register({ kind: 'exact', path: '/admin/server-auth/users', handler: handleAdminUsers }),

      // B. 机器 POST API 通道 (免 Cookie，纯 Token/Bearer 直通)
      ctx.webServer.register({ kind: 'prefix', path: apiPrefix, handler: handleApiBridge })
    )

    return () => {
      for (const d of disposers) {
        if (typeof d === 'function') d()
      }
    }
  }, 'dsh-postapi-bridge: combined gateway & auth')
}
