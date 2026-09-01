/**
 * ============================================================================
 * dsh-postapi-bridge (DSH 统一网关与鉴权桥梁插件)
 * 1. 机器通道：/api/dsh/v1/* 提供免 Cookie 的纯 POST API (Task/MCP/Health)
 * 2. 人类通道：/login 提供 Web 多用户账号密码管理、登录页与持久化 Session 鉴权
 * ============================================================================
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { ROLE_ADMIN, ROLE_USER, UsersStore, SessionsStore } from './users-store.js'

export const name = 'postapi-bridge'
export const inject = ['webServer', 'apiProxy', 'agents', 'sessions']

export const ACTIVATION_SERVICE = 'postapiBridge'

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_PREFERENCE = 'dark'

function readCookie(req, name) {
  const headers = req?.headers
  if (!headers) return undefined
  const header = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie
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

// ==================== P0 会话指纹绑定（PLAN-20260901-SEC01） ====================
// 目标：cookie 异地/异 UA 使用即失效。设计要点：
// 1. 绑定 IP 用「XFF 最后一跳」：公网入口 nginx 会把真实客户端 IP 追加到
//    X-Forwarded-For 末尾，伪造的伪造头只会出现在链首，取最后一跳可防伪造；
// 2. IPv4 默认取 /24（可用 config.ipPrefixBits 调成 16 降低移动网络误杀）；
//    IPv6 取前 4 组（/64）；
// 3. UA 只存 sha256 前 16 位指纹，不存原文（防日志泄露）；
// 4. 白名单网段（config.fingerprintWhitelist，CIDR 数组）跳过校验，loopback 恒放行；
// 5. 升级前签发的旧会话没有指纹字段 → 一律 fail-closed 拒绝（重新登录即恢复）。

function uaHashOf(ua) {
  return createHash('sha256').update(String(ua || '')).digest('hex').slice(0, 16)
}

function bindIpOf(req) {
  // XFF 最后一跳 = 离我们最近的受信代理（本方 nginx）所见的地址
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  if (Array.isArray(xff) && xff.length) {
    const parts = String(xff[xff.length - 1]).split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return req.socket?.remoteAddress || '127.0.0.1'
}

function ipPrefixOf(ip, bits = 24) {
  if (!ip) return ''
  // 先剥离 IPv4-mapped 前缀（::ffff:a.b.c.d），避免被误判为原生 IPv6
  const raw = String(ip).replace(/^::ffff:(?=[0-9]+\.)/, '')
  if (raw.includes(':')) {
    // IPv6：按冒号分组取前 4 组（近似 /64），忽略 :: 展开的精确性——够做指纹即可
    return raw.split(':').filter(Boolean).slice(0, 4).join(':')
  }
  const v4 = raw
  const octets = v4.split('.')
  if (octets.length !== 4) return v4
  const n = Math.max(0, Math.min(32, bits))
  const keep = Math.floor(n / 8)
  return octets.slice(0, keep).join('.')
}

function cidrMatch(ip, cidr) {
  const [base, maskStr] = String(cidr).split('/')
  const mask = maskStr === undefined ? 32 : parseInt(maskStr, 10)
  if (!base || !ip) return false
  if (base.includes(':') || ip.includes(':')) return ipPrefixOf(ip, 64) === ipPrefixOf(base, 64)
  const toInt = (s) => s.split('.').reduce((acc, o) => (acc << 8) + (parseInt(o, 10) || 0), 0) >>> 0
  const m = mask >= 32 ? 0xffffffff : (0xffffffff << (32 - mask)) >>> 0
  return ((toInt(ip) ^ toInt(base)) & m) === 0
}

/**
 * 指纹校验：返回 { ok, reason }。reason ∈ loopback | whitelist | match | legacy | mismatch
 */
function isLoopbackHost(req) {
  const host = headerOf(req, 'host').split(':')[0].toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function verifyFingerprint(req, session, whitelist = [], ipBits = 24) {
  // 安全修复(20260901审查): 回环放行必须 socket 与 Host 双回环。
  // frp 直连(53080→127.0.0.1:3080)时 socket 恒为 127.0.0.1 且无 XFF，
  // 若仅凭 socket 判回环，盗用 cookie 经 http://IP:53080 可绕过指纹校验。
  if (isLoopbackRequest(req) && isLoopbackHost(req)) return { ok: true, reason: 'loopback' }
  const ip = bindIpOf(req)
  for (const cidr of whitelist) {
    if (cidrMatch(ip, cidr)) return { ok: true, reason: 'whitelist' }
  }
  if (!session || !session.bindIpPrefix || !session.bindUaHash) return { ok: false, reason: 'legacy' }
  const ipOk = session.bindIpPrefix === ipPrefixOf(ip, ipBits)
  const uaOk = session.bindUaHash === uaHashOf(headerOf(req, 'user-agent'))
  return ipOk && uaOk ? { ok: true, reason: 'match' } : { ok: false, reason: 'mismatch' }
}

// 仅供 test/ 单元测试使用：导出 P0 纯函数（不暴露任何运行时状态）
export const __p0Helpers = { ipPrefixOf, uaHashOf, cidrMatch, verifyFingerprint }

// ==================== P1 高危接口 step-up（PLAN-20260901-SEC01） ====================
// 目标：会话有效 ≠ 可执行高危操作。四类配置面/导出接口要求「当日密码铸币」的
// stepup cookie（绑定 sid），被盗 cookie 无密码即无法通过。
// 设计取舍（与计划书的 sha256(secret+date) 差异）：客户端自动可算的证明攻击者
// 同样可算，无增量安全——故改为登录页密码换签，等价「重输密码」的当日免输版。
// 已知限制：核心门禁对未过校验固定返回 401（无 428 挑战通道），前端表现同未
// 登录；用户访问 /login/stepup 完成当日解锁。

const STEPUP_COOKIE = 'dsh_stepup'
// 默认高危方法（相对 /api/ 前缀的方法名）
const DEFAULT_STEPUP_PATHS = [
  'credentials.set', 'credentials.unset', 'credentials.describe',
  'settings.update', 'session.export', 'workspace.archiveSession',
]

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
}

function stepupTokenFor(sid) {
  return createHmac('sha256', secretSafe()).update('stepup|' + sid + '|' + todayKey()).digest('hex')
}

// secret 在 apply 作用域内，模块级工具经此桥接（避免把 secret 提升到模块作用域）
let __secretRef = () => 'insecure'
function secretSafe() { return __secretRef() }

function readStepupCookie(req) {
  return readCookie(req, STEPUP_COOKIE)
}

function verifyStepup(req, sid) {
  const provided = readStepupCookie(req)
  if (!provided || !sid) return false
  return safeEqual(provided, stepupTokenFor(sid))
}

/**
 * 请求路径是否命中高危方法清单。只认 /api/<method> 一级方法名；
 * fetch(Request) 合成对象没有 url（核心 nodeRequest 剥离），此时不拦——
 * 正常浏览器流程全部走 route handler 分支（带真实 url），足够覆盖。
 */
function isStepupPath(req, paths) {
  const url = typeof req?.url === 'string' ? req.url : ''
  if (!url.startsWith('/api/')) return false
  const method = url.slice(5).split('?')[0].split('/')[0]
  return paths.includes(method)
}

// P1审查修复: stepup 铸币防爆破——按 IP 记失败，5 次锁 10 分钟（内存态，重启即清）
const stepupFails = new Map()
function stepupThrottled(ip) {
  const rec = stepupFails.get(ip)
  if (!rec) return false
  if (Date.now() > rec.until) { stepupFails.delete(ip); return false }
  return true
}
function stepupRecordFail(ip) {
  const rec = stepupFails.get(ip) || { count: 0, until: 0 }
  rec.count += 1
  if (rec.count >= 5) { rec.until = Date.now() + 10 * 60 * 1000; rec.count = 0 }
  stepupFails.set(ip, rec)
}

// ==================== v0.3.0 溯源审计 ====================
const AUDIT_VERSION = '0.6.2'  // P0指纹+P1 stepup+P2续期+审查修复(伪回环/节流/崩溃)
const ACCESS_LOG_MAX_BYTES = 5 * 1024 * 1024  // 单文件上限 5MB
const ACCESS_LOG_KEEP = 3                      // 保留回滚数 .1 / .2 / .3

function tokenFingerprint(token) {
  if (!token || typeof token !== 'string') return 'none'
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

function headerOf(req, name) {
  if (typeof req.headers.get === 'function') return req.headers.get(name) || ''
  return req.headers[name] || ''
}

function readChannelMap(config) {
  // 通道映射：token -> 通道名。来源优先级：env DSH_GATEWAY_CHANNELS(JSON) 作为默认，config.channels 覆盖。
  let map = {}
  const envRaw = process.env.DSH_GATEWAY_CHANNELS
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw)
      if (parsed && typeof parsed === 'object') map = { ...parsed }
    } catch {}
  }
  if (config?.channels && typeof config.channels === 'object') {
    map = { ...map, ...config.channels }
  }
  return map
}

function resolveChannel(req, providedToken, config) {
  const hdr = headerOf(req, 'x-dsh-channel').trim()
  if (hdr) return { value: hdr.slice(0, 64), via: 'header' }
  const map = readChannelMap(config)
  if (providedToken) {
    for (const [tok, name] of Object.entries(map)) {
      if (typeof tok === 'string' && tok && safeEqual(tok, providedToken)) {
        return { value: String(name).slice(0, 64), via: 'token-map' }
      }
    }
  }
  const ua = headerOf(req, 'user-agent')
  if (/python-urllib|python-requests|aiohttp|httpx/i.test(ua)) return { value: 'python-client', via: 'ua' }
  if (/curl\//i.test(ua)) return { value: 'curl', via: 'ua' }
  return { value: isLoopbackRequest(req) ? 'local-unknown' : 'unknown', via: 'default' }
}

function auditDataDir(config) {
  if (config?.accessLogDir && typeof config.accessLogDir === 'string' && config.accessLogDir.length) {
    return config.accessLogDir
  }
  try {
    const u = new URL('../data', import.meta.url)
    return fileURLToPath(u)
  } catch {
    // cordis 加载环境下 import.meta.url 可能不是合法 file URL：兜底落到当前工作目录
    return join(process.cwd(), 'dsh-postapi-bridge-data')
  }
}

function rotateAccessLogIfNeeded(file) {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size < ACCESS_LOG_MAX_BYTES) return
    for (let i = ACCESS_LOG_KEEP - 1; i >= 1; i--) {
      const from = file + '.' + i
      const to = file + '.' + (i + 1)
      if (existsSync(from)) renameSync(from, to)
    }
    renameSync(file, file + '.1')
  } catch {}
}

function appendAccessLog(config, entry) {
  try {
    const dir = auditDataDir(config)
    mkdirSync(dir, { recursive: true })
    const file = dir + '/access-log.jsonl'
    rotateAccessLogIfNeeded(file)
    writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' })
  } catch {}
}

function buildAuditBase(req, subPath, isLoopback, providedToken, config) {
  const ip = getClientIp(req)
  const xff = headerOf(req, 'x-forwarded-for')
  const ch = resolveChannel(req, providedToken, config)
  return {
    version: AUDIT_VERSION,
    ts: Date.now(),
    iso: new Date().toISOString(),
    method: req.method,
    subPath,
    ip,
    xff,
    loopback: isLoopback,
    host: headerOf(req, 'host'),
    xForwardedHost: headerOf(req, 'x-forwarded-host'),
    xForwardedProto: headerOf(req, 'x-forwarded-proto'),
    channel: ch.value,
    channelVia: ch.via,
    caller: tokenFingerprint(providedToken),
    ua: headerOf(req, 'user-agent').slice(0, 120),
    sessionId: null,
    promptPreview: null,
    durationMs: null,
    status: null,
    error: null,
  }
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

  // v0.3.0：在 apply 作用域提前捕获模块级 sendJson，供 handleApiBridge 内遮挡时引用（避免 TDZ）
  const origSendJson = sendJson

  const secret = config?.sessionSecret || process.env.DSH_SESSION_SECRET || process.env.DSH_SERVER_AUTH_SECRET || 'a47e156cc1fb7ad1e5bf7768ebf84555fbbcf6bfe408447f0fd3402f1588f225'
  const cookieName = config?.cookieName || 'dsh_postapi_session'
  // P1：stepup cookie 铸币材料为服务端 secret（经桥接供工具函数使用）
  __secretRef = () => secret
  const stepupPaths = Array.isArray(config?.stepupPaths) ? config.stepupPaths : DEFAULT_STEPUP_PATHS
  const maxAgeMs = (config?.sessionMaxAgeHours || 24) * 60 * 60 * 1000
  const loginPath = config?.loginPath || '/login'
  const logoutPath = config?.logoutPath || '/logout'
  const pageTitle = config?.pageTitle || 'DeepSeek Harness'
  const apiPrefix = config?.apiPrefix || '/api/dsh/v1'
  const apiToken = config?.apiToken || process.env.DSH_GATEWAY_TOKEN || ''
  // P0 指纹绑定配置：ipPrefixBits=24（可调 16 降低移动网络误杀）；白名单网段放行家庭/办公多出口
  const fpIpBits = config?.ipPrefixBits || 24
  const fpWhitelist = Array.isArray(config?.fingerprintWhitelist) ? config.fingerprintWhitelist : []

  /**
   * 统一会话查找 + 指纹校验入口（sessionAuth 与 getAuthUser 共用，保证两条鉴权
   * 路径行为一致）。指纹不匹配 → 记录失配事件，连续 3 次吊销会话（防爆破锁定）。
   * 返回会话对象；失败返回 undefined（调用方按未登录处理）。
   */
  const findSessionVerified = (req) => {
    // 审查修复回归(20260901)：核心对特权方法会以「剥离后的 Fetch 表示」(仅
    // cookie+host，无 url/socket) 做二次鉴权。该分支看不到 IP/UA，无法做指纹
    // 校验——而能走到这里的请求必然已通过 route 分支的完整校验（指纹+stepup），
    // 故此处直接放行，且绝不计入失配（否则正常浏览器操作会话会被误吊销）。
    if (typeof req?.url !== 'string' && req?.socket === undefined) {
      const sid0 = readSessionId(req, secret, cookieName)
      if (!sid0) return undefined
      sessionsStore.load()
      const s0 = sessionsStore.get(sid0)
      return s0
    }
    const sid = readSessionId(req, secret, cookieName)
    if (!sid) return undefined
    // 每次鉴权重新 load 以获取最新的 sessions.json（避免跨进程/热重载写入未同步）
    sessionsStore.load()
    const session = sessionsStore.get(sid)
    if (!session) return undefined
    const verdict = verifyFingerprint(req, session, fpWhitelist, fpIpBits)
    if (verdict.ok) {
      sessionsStore.resetMismatch(sid)
      // P2：用户已被删除/禁用 → 会话一并清除（僵尸会话不残留）
      store.load()
      const user = store.get(session.username)
      if (!user || !user.enabled) {
        sessionsStore.delete(sid)
        return undefined
      }
      // P2：滚动续期——剩余不足 maxAge 一半时顺延至满额（节流写盘）
      if (session.expiresAt - Date.now() < maxAgeMs / 2) {
        sessionsStore.touch(sid, maxAgeMs)
      }
      return session
    }
    // fail-closed：旧会话（legacy）与异指纹（mismatch）都拒绝；mismatch 计数吊销
    const outcome = sessionsStore.recordMismatch(sid, 3)
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION,
        ts: Date.now(),
        iso: new Date().toISOString(),
        event: verdict.reason === 'legacy' ? 'session-legacy-reject' : 'session-fingerprint-mismatch',
        outcome,
        sessionId: sid,
        ip: bindIpOf(req),
        xff: headerOf(req, 'x-forwarded-for'),
        ua: headerOf(req, 'user-agent').slice(0, 120),
        expectPrefix: session.bindIpPrefix || null,
        expectUaHash: session.bindUaHash || null,
      })
      ctx.logger?.warn?.('[postapi-sec] ' + verdict.reason + ' sid=' + sid.slice(0, 8) + ' outcome=' + outcome + ' ip=' + bindIpOf(req))
    } catch {}
    return undefined
  }

  ctx.provide(ACTIVATION_SERVICE, {
    store,
    sessionsStore,
    version: AUDIT_VERSION,
  })

  // 提供 DSH 源码级扩展点：client-connection 开启 requireSession 后，非
  // loopback 的 /api 请求（含配置面 settings.*/credentials.*）都会调用本
  // 服务判定登录态。判定依据是 Cookie 中的会话签名，不依赖 IP——DSH 侧
  // 已用 Host 头判定 loopback 并恒放行，能走到这里的请求必然非回环，若
  // 再判 X-Forwarded-For 反而会被伪造头绕过。
  ctx.provide('sessionAuth', {
    isAuthenticated: (req) => {
      const authHeader = req?.headers?.authorization || (typeof req?.headers?.get === 'function' ? req.headers.get('authorization') : undefined)
      if (apiToken && authHeader === `Bearer ${apiToken}`) return true
      const session = findSessionVerified(req)
      if (!session) return false
      // P1：高危方法额外要求当日密码铸币的 stepup cookie（盗 cookie 无密码不可得）
      if (isStepupPath(req, stepupPaths)) {
        const sid = readSessionId(req, secret, cookieName)
        if (!verifyStepup(req, sid)) {
          try {
            appendAccessLog(config, {
              version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
              event: 'stepup-required', ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
            })
          } catch {}
          return false
        }
      }
      store.load()
      const user = store.get(session.username)
      return !!(user && user.enabled)
    },
  })

  const checkCredential = (username, password) => {
    if (!username || !password) return undefined
    const u = store.get(username)
    if (!u || !u.enabled) return undefined
    if (store.verify(u.username, password)) return u
    return undefined
  }

  const getAuthUser = (req) => {
    const session = findSessionVerified(req)
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
    // P0：签发会话即绑定登录时的 IP 段与 UA 指纹（盗用 cookie 异地/异 UA 即失效）
    sessionsStore.create(sessionId, user.username, user.role, maxAgeMs, {
      ipPrefix: ipPrefixOf(bindIpOf(req), fpIpBits),
      uaHash: uaHashOf(headerOf(req, 'user-agent')),
    })
    setSessionCookie(res, sessionId, secret, maxAgeMs, cookieName)
    res.writeHead(302, { location: '/' }).end()
  }

  // P1：当日高危操作解锁页。密码校验通过 → 铸币绑定当前会话的 stepup cookie
  const handleStepup = async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage('敏感操作解锁', false, readPreference(ctx), loginPath))
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
    const throttleIp = bindIpOf(req)
    if (stepupThrottled(throttleIp)) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }).end('too many attempts, try later')
      return
    }
    const user = checkCredential(form.username, form.password)
    const sid = readSessionId(req, secret, cookieName)
    const session = sid ? sessionsStore.get(sid) : undefined
    // 必须已持有有效会话且密码属于该会话用户——防止用 stepup 当旁路登录
    if (!user || !session || session.username !== user.username) {
      stepupRecordFail(throttleIp)
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'stepup-failed', ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
        })
      } catch {}
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage('敏感操作解锁', true, readPreference(ctx), loginPath))
      return
    }
    const untilMidnight = (() => {
      const d = new Date(); const next = new Date(d); next.setHours(24, 0, 0, 0)
      return Math.floor((next - d) / 1000)
    })()
    res.setHeader('set-cookie',
      `${STEPUP_COOKIE}=${stepupTokenFor(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${untilMidnight}`)
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: 'stepup-granted', ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
      })
    } catch {}
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

    // v0.3.0 溯源审计：请求进来先打 request 底稿；响应时经下方本地 sendJson 包装补记 result。
    // 固化四要素：IP(含XFF链/loopback) · 域名(Host/转发头) · 通道(header/token映射/UA) · 调用方(token指纹/UA)。
    let bid = null
    let auditErr = null
    try {
      bid = buildAuditBase(req, subPath, isLoopback, providedToken, config)
      appendAccessLog(config, { ...bid, event: 'request' })
      ctx.logger?.info?.('[postapi-audit] request ' + JSON.stringify(bid))
    } catch (err) {
      auditErr = err
      try { ctx.logger?.error?.('[postapi-audit] init failed, degraded: ' + ((err && err.stack) || err)) } catch {}
    }

    const sendJson = (res, status, obj) => {
      if (!auditErr && bid) {
        try {
          const dur = typeof bid.durationMs === 'number' ? Date.now() - bid.durationMs : null
          const promptPrev = obj && typeof obj.promptPreview === 'string' ? obj.promptPreview : (obj && typeof obj.result === 'string' ? obj.result.slice(0, 80) : (obj && obj.error ? String(obj.error).slice(0, 80) : null))
          const entry = {
            ...bid,
            event: 'result',
            status,
            sessionId: (obj && obj.sessionId) || bid.sessionId,
            promptPreview: promptPrev,
            durationMs: dur,
            error: (obj && obj.error) ? String(obj.error).slice(0, 120) : null,
          }
          appendAccessLog(config, entry)
          ctx.logger?.info?.('[postapi-audit] result ' + JSON.stringify(entry))
        } catch {}
      }
      return origSendJson(res, status, obj)
    }

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
        version: AUDIT_VERSION,
        status: 'running',
        isLoopback,
        clientIp: getClientIp(req),
        audited: true,
        accessLog: auditDataDir(config) + '/access-log.jsonl',
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

    // POST /api/dsh/v1/task 核心执行接口：直接委托给 Web 前端统一的 ctx.apiProxy
    if (subPath === '/task') {
      const prompt = body.prompt
      if (!prompt || typeof prompt !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Missing required string field: prompt' })
        return
      }

      try {
        const sessionId = body.sessionId || ('post_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))
        // 溯源：把任务标识 + 耗时起点写入审计底稿，响应 result 时一并落盘
        bid.sessionId = sessionId
        bid.promptPreview = String(prompt).slice(0, 80)
        bid.durationMs = Date.now()
        // P2：外部(非回环)机器通道创建的会话，未显式声明工作目录时圈养到 /tmp——
        // 攻击者历来在 tmp 建会话；持 token 的合法脚本需要真实目录会显式传入
        const cwd = body.cwd || (isLoopback ? process.cwd() : '/tmp')
        if (!isLoopback && !body.cwd) {
          bid.untrustedWorkspace = '/tmp'
        }

        // 1. 如果 apiProxy 存在，直接调用官方统一的 session.create（自动挂载工作区、D老师Preset与全套工具）
        if (ctx.apiProxy) {
          try {
            await ctx.apiProxy.sessions.create({
              rpcId: 'rpc_' + Date.now(),
              payload: { sessionId, cwd }
            })
          } catch (createErr) {
            // 已存在则复用
          }

          // 2. 发送 prompt 并由官方引擎完成驱动
          const promptPromise = ctx.apiProxy.sessions.prompt({
            rpcId: 'rpc_' + Date.now(),
            payload: {
              sessionId,
              content: [{ type: 'text', text: prompt }]
            }
          })

          await promptPromise

          const agent = ctx.agents?.get(sessionId)
          if (agent && typeof agent.whenIdle === 'function') {
            await agent.whenIdle()
          }

          // 3. 读取官方格式化历史消息（尝试重试提取确保事件落盘）
          let finalOutput = ''
          for (let attempt = 0; attempt < 10; attempt++) {
            const historyRes = await ctx.apiProxy.sessions.history({
              rpcId: 'rpc_' + Date.now(),
              payload: { sessionId }
            })

            const entries = historyRes?.result?.value?.events || []
            for (let i = entries.length - 1; i >= 0; i--) {
              // historyEntry 包装层结构为 { event: { type, data: { message: ... } } }
              const rawItem = entries[i]
              const ev = rawItem?.event || rawItem
              if (ev?.type === 'assistant/message' && ev.data?.message?.content) {
                const textBlocks = ev.data.message.content.filter(b => b.type === 'text').map(b => b.text)
                if (textBlocks.length > 0) {
                  finalOutput = textBlocks.join('\n').trim()
                  break
                }
              }
            }
            if (finalOutput) break
            await new Promise(r => setTimeout(r, 400))
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
          return
        }

        const userMessage = {
          id: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: prompt }],
        }

        const collectedTurnTexts = []
        let currentStepTexts = []

        const offEvent = ctx.on('session/event', (session, event) => {
          if (session.id === sessionId || session.header?.id === sessionId) {
            if (event.type === 'assistant/message') {
              for (const block of event.data.message.content) {
                if (block.type === 'text') {
                  currentStepTexts.push(block.text)
                }
              }
            } else if (event.type === 'step/end') {
              if (currentStepTexts.length > 0) {
                collectedTurnTexts.push(currentStepTexts.join('\n').trim())
                currentStepTexts = []
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

        if (currentStepTexts.length > 0) {
          collectedTurnTexts.push(currentStepTexts.join('\n').trim())
        }

        // 最终输出：合并当前 Turn 的所有阶段文本或取最后的完整交付
        let finalOutput = collectedTurnTexts.filter(Boolean).join('\n\n').trim()

        if (!finalOutput && agent.session) {
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

        if (!finalOutput && collectedTurnTexts.length > 0) {
          finalOutput = collectedTurnTexts.filter(Boolean).join(String.fromCharCode(10)).trim()
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
      ctx.webServer.register({ kind: 'exact', path: loginPath + '/stepup', handler: handleStepup }),
      ctx.webServer.register({ kind: 'exact', path: logoutPath, handler: handleLogout }),
      // Bug修复(20260901)：原 prefix 注册带尾斜杠在 webServer 下永不匹配，
      // /remove /password /toggle 等 subpath 全部 405。改为无尾斜杠前缀，
      // 同时覆盖 exact 与 subpath。
      ctx.webServer.register({ kind: 'prefix', path: '/admin/server-auth/users', handler: handleAdminUsers }),
      ctx.webServer.register({ kind: 'prefix', path: apiPrefix, handler: handleApiBridge })
    )

    return () => {
      for (const d of disposers) {
        if (typeof d === 'function') d()
      }
    }
  }, 'dsh-postapi-bridge: combined gateway & auth')
}
