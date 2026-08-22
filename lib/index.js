/**
 * ============================================================================
 * dsh-postapi-bridge (DSH 统一网关与鉴权桥梁插件)
 * 1. 机器通道：/api/dsh/v1/* 提供免 Cookie 的纯 POST API (Task/MCP/Health)
 * 2. 人类通道：/login 提供 Web 多用户账号密码管理、登录页与持久化 Session 鉴权
 * ============================================================================
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ROLE_ADMIN, ROLE_USER, UsersStore, SessionsStore } from './users-store.js'

export const name = 'postapi-bridge'
export const inject = ['webServer', 'agents', 'sessions', 'workspaceRegistry', 'agentDefaultModel']

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
    size += chunk.length
    if (size > maxBytes) {
      throw new Error('request body too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function readJson(req, maxBytes) {
  const body = await readBody(req, maxBytes)
  if (!body) return {}
  return JSON.parse(body)
}

function parseForm(body) {
  const params = new URLSearchParams(body)
  const result = {}
  for (const [k, v] of params.entries()) {
    result[k] = v
  }
  return result
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aHash = createHash('sha256').update(a).digest()
  const bHash = createHash('sha256').update(b).digest()
  return aHash.length === bHash.length && timingSafeEqual(aHash, bHash)
}

function signSessionId(sid, secret) {
  const hmac = createHmac('sha256', secret).update(sid).digest('hex')
  return `${sid}.${hmac}`
}

function verifySignedSessionId(signed, secret) {
  if (typeof signed !== 'string') return undefined
  const dot = signed.lastIndexOf('.')
  if (dot === -1) return undefined
  const sid = signed.slice(0, dot)
  const hmac = signed.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(sid).digest('hex')
  if (hmac.length !== expected.length) return undefined
  if (!timingSafeEqual(Buffer.from(hmac, 'utf-8'), Buffer.from(expected, 'utf-8'))) return undefined
  return sid
}

function readSessionId(req, secret, cookieName) {
  const signed = readCookie(req, cookieName)
  if (!signed) return undefined
  return verifySignedSessionId(signed, secret)
}

function setSessionCookie(res, sid, secret, maxAgeMs, cookieName) {
  const signed = signSessionId(sid, secret)
  const maxAgeSec = Math.floor(maxAgeMs / 1000)
  res.setHeader(
    'set-cookie',
    `${cookieName}=${signed}; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`
  )
}

function clearSessionCookie(res, cookieName) {
  res.setHeader(
    'set-cookie',
    `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  )
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('127.') || address.startsWith('::ffff:127.')) return true
  return false
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const first = ips.split(',')[0].trim()
    if (first) return first
  }
  return req.socket?.remoteAddress || '127.0.0.1'
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(getClientIp(req))
}

function readPreference(ctx) {
  try {
    const raw = ctx.settings?.get('ui-theme', 'preference')
    if (raw === 'light' || raw === 'dark') return raw
  } catch {}
  return DEFAULT_PREFERENCE
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  }).end(JSON.stringify(obj))
}

function loginPage(title, failed, preference, loginPath) {
  const isDark = preference !== 'light'
  const bg = isDark ? '#0d1117' : '#f6f8fa'
  const cardBg = isDark ? '#161b22' : '#ffffff'
  const border = isDark ? '#30363d' : '#d0d7de'
  const text = isDark ? '#e6edf3' : '#1f2328'
  const muted = isDark ? '#8b949e' : '#656d76'
  const primary = '#238636'
  const primaryHover = '#2ea043'
  const errBg = isDark ? '#3d1d24' : '#ffebe9'
  const errBorder = isDark ? '#f85149' : '#ff8182'
  const errText = isDark ? '#f85149' : '#cf222e'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      background-color: ${bg};
      color: ${text};
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
    }
    .login-container {
      width: 100%;
      max-width: 340px;
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .header h1 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.5px;
    }
    .header p {
      margin-top: 6px;
      font-size: 14px;
      color: ${muted};
    }
    .card {
      background-color: ${cardBg};
      border: 1px solid ${border};
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .error-banner {
      background-color: ${errBg};
      border: 1px solid ${errBorder};
      color: ${errText};
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-size: 14px;
      font-weight: 500;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 7px 12px;
      font-size: 14px;
      line-height: 20px;
      color: ${text};
      background-color: ${bg};
      border: 1px solid ${border};
      border-radius: 6px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: #58a6ff;
      box-shadow: 0 0 0 3px rgba(88,166,255,0.3);
    }
    button {
      width: 100%;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      background-color: ${primary};
      border: 1px solid rgba(27,31,36,0.15);
      border-radius: 6px;
      cursor: pointer;
      margin-top: 8px;
      transition: background-color 0.2s;
    }
    button:hover {
      background-color: ${primaryHover};
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: ${muted};
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="header">
      <h1>${title}</h1>
      <p>统一身份与 API 网关认证</p>
    </div>
    <div class="card">
      ${failed ? '<div class="error-banner">用户名或密码错误，或该账户已被禁用</div>' : ''}
      <form method="post" action="${loginPath}">
        <div class="form-group">
          <label for="username">用户名</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit">登录</button>
      </form>
    </div>
    <div class="footer">
      DeepSeek Harness • Multi-User System
    </div>
  </div>
</body>
</html>`
}

export function apply(ctx, config) {
  const store = new UsersStore()
  const sessionsStore = new SessionsStore()

  // 跟踪活跃会话句柄: sessionId -> AgentHandle
  const activeHandles = new Map()

  const secret = config?.sessionSecret || process.env.DSH_SESSION_SECRET || randomBytes(32).toString('hex')
  const cookieName = config?.cookieName || 'dsh_postapi_session'
  const maxAgeMs = (config?.sessionMaxAgeHours || 24) * 60 * 60 * 1000
  const loginPath = config?.loginPath || '/login'
  const logoutPath = config?.logoutPath || '/logout'
  const pageTitle = config?.pageTitle || 'DeepSeek Harness'
  const apiPrefix = config?.apiPrefix || '/api/dsh/v1'
  const apiToken = config?.apiToken || process.env.DSH_GATEWAY_TOKEN || 'Qq13235202993'

  ctx.provide(ACTIVATION_SERVICE, {
    store,
    sessionsStore,
    version: '0.2.0',
  })

  const checkCredential = (username, password) => {
    if (!username || !password) return undefined
    const u = store.get(username)
    if (!u || !u.enabled) return undefined
    if (store.verify(u.username, password)) return u
    return undefined
  }

  const getAuthUser = (req) => {
    const sid = readSessionId(req, secret, cookieName)
    if (!sid) return undefined
    const session = sessionsStore.get(sid)
    if (!session) return undefined
    const user = store.get(session.username)
    if (!user || !user.enabled) return undefined
    return { ...user, role: session.role }
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
    const user = checkCredential(form.username, form.password)
    if (!user) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage(pageTitle, true, readPreference(ctx), loginPath))
      return
    }
    const sessionId = randomUUID()
    sessionsStore.create(sessionId, user.username, user.role, maxAgeMs)
    setSessionCookie(res, sessionId, secret, maxAgeMs, cookieName)
    res.writeHead(302, { location: '/' }).end()
  }

  const handleLogout = (req, res) => {
    const sid = readSessionId(req, secret, cookieName)
    if (sid) {
      sessionsStore.delete(sid)
    }
    clearSessionCookie(res, cookieName)
    res.writeHead(302, { location: loginPath }).end()
  }

  // 3. Admin 用户管理 API
  const handleAdminUsers = async (req, res) => {
    const isLoopback = isLoopbackRequest(req)
    const authUser = getAuthUser(req)
    const isAdmin = isLoopback || (authUser && authUser.role === ROLE_ADMIN)
    if (!isAdmin) {
      sendJson(res, 401, { error: 'Unauthorized: admin access required' })
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
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }

      const action = req.url.split('?')[0].replace('/admin/server-auth/users', '')
      if (action === '/add' || action === '') {
        try {
          const u = store.create({ username: body.username, password: body.password, role: body.role || ROLE_USER })
          sendJson(res, 200, { ok: true, user: { id: u.id, username: u.username, role: u.role, enabled: u.enabled } })
        } catch (e) {
          sendJson(res, 400, { error: e.message })
        }
        return
      }
      if (action === '/password') {
        const ok = store.changePassword(body.username, body.password)
        sendJson(res, ok ? 200 : 404, { ok, error: ok ? undefined : 'user not found' })
        return
      }
      if (action === '/toggle') {
        const enabled = store.toggleEnabled(body.username)
        sendJson(res, enabled !== undefined ? 200 : 404, { ok: enabled !== undefined, enabled })
        return
      }
      if (action === '/remove') {
        const ok = store.remove(body.username)
        sendJson(res, ok ? 200 : 404, { ok, error: ok ? undefined : 'user not found' })
        return
      }
    }
    sendJson(res, 404, { error: 'unknown endpoint' })
  }

  // 4. 机器 POST API 网关
  const handleApiBridge = async (req, res) => {
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

    const isLoopback = isLoopbackRequest(req)
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

    if (req.method === 'GET' && (subPath === '/health' || subPath === '')) {
      sendJson(res, 200, {
        ok: true,
        service: 'dsh-postapi-bridge',
        version: '0.2.0',
        status: 'running',
        isLoopback,
        clientIp: getClientIp(req),
      })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed, use POST' })
      return
    }

    let body = {}
    try {
      body = await readJson(req, 65536)
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' })
      return
    }

    // POST /api/dsh/v1/task 核心执行接口
    if (subPath === '/task') {
      const prompt = body.prompt
      if (!prompt || typeof prompt !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Missing required string field: prompt' })
        return
      }

      try {
        const sessionId = body.sessionId || ('post_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))
        const cwd = body.cwd || process.cwd()

        let handle = activeHandles.get(sessionId)
        if (!handle) {
          // 获取当前系统默认模型配置（如 maiapi2/gemini-3.7-flash-tiered）
          let defaultOpts = { provider: 'maiapi2', model: 'gemini-3.7-flash-tiered' }
          if (ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function') {
            try {
              const sel = ctx.agentDefaultModel.currentSelection()
              if (sel && sel.provider && sel.model) {
                defaultOpts = { provider: sel.provider, model: sel.model }
              }
            } catch {}
          }

          handle = await ctx.agents.create({
            sessionId: sessionId,
            agentOptions: defaultOpts,
            meta: { cwd: cwd },
          })
          activeHandles.set(sessionId, handle)

          // 核心联动：将麦麦的 Session 自动附加到 Web UI 的工作区左侧边栏
          if (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.resolveByPath === 'function') {
            try {
              let ws = await ctx.workspaceRegistry.resolveByPath(cwd)
              if (!ws && typeof ctx.workspaceRegistry.create === 'function') {
                ws = await ctx.workspaceRegistry.create(cwd)
              }
              if (ws && typeof ws.attachSession === 'function') {
                await ws.attachSession(sessionId)
                ctx.logger.info('已成功将麦麦会话 %s 附加到 Web 工作区: %s', sessionId, ws.title || cwd)
              }
            } catch (wsErr) {
              ctx.logger.warning('附加会话到 Web 工作区异常: %s', wsErr)
            }
          }
        }

        const agent = handle.agent

        const userMessage = {
          id: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: prompt }],
        }

        const collectedTexts = []
        const offEvent = ctx.on('session/event', (session, event) => {
          if (session.id === sessionId || session.header?.id === sessionId) {
            if (event.type === 'assistant/message') {
              for (const block of event.data.message.content) {
                if (block.type === 'text') {
                  collectedTexts.push(block.text)
                }
              }
            } else if (event.type === 'assistant/chunk') {
              if (event.data.chunk.type === 'text-delta' && event.data.chunk.text) {
                collectedTexts.push(event.data.chunk.text)
              }
            }
          }
        })

        try {
          agent.followup(userMessage)
          await agent.whenIdle()
        } finally {
          offEvent()
        }

        // 优先从 session 历史中提取，其次从实时监听中提取
        let finalOutput = ''
        if (agent.session) {
          const events = agent.session.events || agent.session.log || []
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (ev.type === 'assistant/message' && ev.data?.message?.content) {
              const textBlocks = ev.data.message.content.filter(b => b.type === 'text').map(b => b.text)
              if (textBlocks.length > 0) {
                finalOutput = textBlocks.join('\n').trim()
                break
              }
            }
          }
        }

        if (!finalOutput && collectedTexts.length > 0) {
          finalOutput = collectedTexts.join('').trim()
        }

        if (!finalOutput && agent.session && typeof agent.session.deriveMessages === 'function') {
          const derived = agent.session.deriveMessages()
          for (let i = derived.length - 1; i >= 0; i--) {
            const m = derived[i]
            if (m.role === 'assistant') {
              const textBlocks = m.content.filter(b => b.type === 'text').map(b => b.text)
              if (textBlocks.length > 0) {
                finalOutput = textBlocks.join('\n').trim()
                break
              }
            }
          }
        }

        if (!finalOutput) {
          finalOutput = '(任务已执行完成，无文本输出)'
        }

        sendJson(res, 200, {
          ok: true,
          sessionId: sessionId,
          status: 'completed',
          result: finalOutput,
          output: finalOutput,
        })
      } catch (err) {
        ctx.logger.error('dsh-postapi-bridge 执行任务异常: %s', err)
        sendJson(res, 500, { ok: false, error: err.message || 'Internal Agent Error' })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: `Unknown sub-route: ${subPath}` })
  }

  // 5. 注册路由与前端拦截
  ctx.effect(() => {
    const disposers = []

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

    disposers.push(
      ctx.webServer.register({ kind: 'exact', path: loginPath, handler: handleLogin }),
      ctx.webServer.register({ kind: 'exact', path: logoutPath, handler: handleLogout }),
      ctx.webServer.register({ kind: 'exact', path: '/admin/server-auth/users', handler: handleAdminUsers }),
      ctx.webServer.register({ kind: 'prefix', path: '/admin/server-auth/users/', handler: handleAdminUsers }),
      ctx.webServer.register({ kind: 'prefix', path: apiPrefix, handler: handleApiBridge })
    )

    return () => {
      for (const d of disposers) {
        if (typeof d === 'function') d()
      }
    }
  }, 'dsh-postapi-bridge: combined gateway & auth')
}
