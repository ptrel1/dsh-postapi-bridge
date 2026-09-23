/**
 * ============================================================================
 * dsh-postapi-bridge (DSH 统一网关与鉴权桥梁插件)
 * 1. 机器通道：/api/dsh/v1/* 提供免 Cookie 的纯 POST API (Task/MCP/Health)
 * 2. 人类通道：/login 提供 Web 多用户账号密码管理、登录页与持久化 Session 鉴权
 * ============================================================================
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync as _readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { ROLE_ADMIN, ROLE_USER, UsersStore, SessionsStore } from './users-store.js'

export const name = 'postapi-bridge'
// 迁移 20260907：上游 dsh 0.1.2 移除 ApiProxy 包，宿主侧会话驱动改用 agents 服务
// （范式同官方 packages/webhook/webhook/src/session.ts createWebhookSession）
export const inject = ['webServer', 'agents', 'sessions']

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

// 严格回环判定（20260902 安全加固，PLAN-SEC02 P1-急）：只用 socket 命中回环，
// 绝不经 X-Forwarded-For —— 伪造 XFF:127.0.0.1 无法蒙混；且必须 Host 同为回环，
// 杜绝 frp 直连（socket=127 但 Host=公网域名）时免 token。与 verifyFingerprint 一致。
function isStrictLoopback(req) {
  return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHost(req)
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

// 设备类别分桶（方案一：放宽 UA 跨设备误杀）：把 UA 归一为 desktop/mobile/tablet。
// 会话绑定「设备类别」而非逐字节 UA 哈希——同一用户桌面↔手机切换不会被判失配。
// 仅返回固定几类，BOT/空值归为 other，避免把欧特笛级明细写进会话/日志。
function uaDeviceClass(ua) {
  const s = String(ua || '').toLowerCase()
  if (/ipad|tablet/.test(s)) return 'tablet'
  if (/mobile|iphone|ipod|android|phone/.test(s)) return 'mobile'
  if (/bot|crawl|curl|urllib|python|wget|node|axios|postman|go-http/.test(s)) return 'other'
  return 'desktop'
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
  if (isStrictLoopback(req)) return { ok: true, reason: 'loopback' }
  const ip = bindIpOf(req)
  for (const cidr of whitelist) {
    if (cidrMatch(ip, cidr)) return { ok: true, reason: 'whitelist' }
  }
  if (!session || !session.bindIpPrefix || (!session.bindUaHash && !session.bindUaClass)) return { ok: false, reason: 'legacy' }
  const ipOk = session.bindIpPrefix === ipPrefixOf(ip, ipBits)
  // 方案一：新会话（带 bindUaClass）仅比对设备类别，桌面↔手机切换不误杀；
  // 老会话（仅 bindUaHash，升级前签发）回退逐字节 UA 哈希匹配（保持 fail-closed）。
  const uaOk = session.bindUaClass
    ? session.bindUaClass === uaDeviceClass(headerOf(req, 'user-agent'))
    : session.bindUaHash === uaHashOf(headerOf(req, 'user-agent'))
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
// ⚠️ 版本号真源 = package.json。此处必须同步更新（历史上曾滞后到 0.6.4 而 package 已 0.6.6）。
// 20260922：0.6.7 —— 移除硬编码 sessionSecret 兜底（改 fail-closed，见 apply 内注释）。
const AUDIT_VERSION = '0.6.7'
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
  // 优先显式配置
  if (config?.accessLogDir && typeof config.accessLogDir === 'string' && config.accessLogDir.length) {
    return config.accessLogDir
  }
  // 否则落 DSH 数据目录（稳定，且不被 sync.sh 先删后拷清掉）：
  //   DSH_HOME(如 ~/.dsh-rescue) 或默认 ~/.dsh 下的 data/dsh-postapi-bridge。
  // 之前用 import.meta.url 的相对 node_modules/data —— 插件重部署(sync.sh rm -rf)
  // 会连审计日志一起删，且 npm 安装目录可能不可写 → 静默失败。
  try {
    const dshHome = process.env.DSH_HOME || join(os.homedir?.() || process.env.HOME || '.', '.dsh')
    return join(dshHome, 'data', 'dsh-postapi-bridge')
  } catch {
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

let auditFailPrinted = 0
function appendAccessLog(config, entry) {
  try {
    const dir = auditDataDir(config)
    mkdirSync(dir, { recursive: true })
    const file = dir + '/access-log.jsonl'
    rotateAccessLogIfNeeded(file)
    writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' })
    auditFailPrinted = 0
  } catch (err) {
    // 静默缺口会掩盖攻击溯源；失败不阻断业务，但要可观测(节流)
    if (auditFailPrinted === 0 || auditFailPrinted % 100 === 0) {
      try { console.error('[postapi-audit] append failed: ' + (err && err.message ? err.message : err)) } catch {}
    }
    auditFailPrinted += 1
  }
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

  // 会话 cookie 的 HMAC 签名密钥。**fail-closed：缺失即拒绝启动**。
  //
  // ⚠️ 20260922 安全修复：原先此处有一个硬编码的 64 位十六进制兜底值。
  //   危害：源码公开（本仓库/GitHub/npm），任何使用者若忘记配 sessionSecret 与环境变量，
  //   会**静默回落到这个人人可见的固定值** —— 攻击者读源码即可伪造出通过校验的会话 cookie。
  //   这与本插件其它各处「token 未配则拒绝，杜绝 fail-open」的设计哲学直接矛盾
  //   （见 §机器通道 fail-closed、isStrictLoopback 等），是唯一一处 fail-open。
  //   修法：去掉兜底，三项来源全空时**显式抛错**，宁可起不来也不要以公开密钥提供服务。
  const secret = config?.sessionSecret
    || process.env.DSH_SESSION_SECRET
    || process.env.DSH_SERVER_AUTH_SECRET
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      'dsh-postapi-bridge: 缺少会话签名密钥（fail-closed 拒绝启动）。'
      + '请任选其一配置：config.sessionSecret、环境变量 DSH_SESSION_SECRET 或 DSH_SERVER_AUTH_SECRET。'
      + '切勿使用可猜测的值——它直接用于签发/校验会话 cookie。',
    )
  }
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
  // PLAN-SEC02 §八-待补：loopback 收紧 + 启动 fail-fast。
  // machineLocalAllow：严格回环也仅放行 /health 与白名单项，未列入的本地 /task → 401
  // （不放行 = 默认空；合法本机探活显式列入，非一刀切）。
  const machineLocalAllow = Array.isArray(config?.machineLocalAllow) ? config.machineLocalAllow : []
  // apiToken 为空 → 机器通道整体拒启用(fail-fast)，但仍不影响人类通道/登录页
  if (!apiToken) {
    try { console.error('[postapi-audit] DSH_GATEWAY_TOKEN missing: machine channel disabled (fail-fast)') } catch {}
  }
  // P0 指纹绑定配置：ipPrefixBits 默认 16（方案一放宽，缓解移动网络切基站/家庭多出口误杀；
  // 配 24 更严、16 更宽松，仍可由 config.ipPrefixBits 覆盖）；fingerprintWhitelist 放行家庭/办公多出口
  const fpIpBits = config?.ipPrefixBits || 16
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
  // 原生 BrowserAuth 衔接（20260907）：dsh 0.1.2 起 /api 鉴权主力是原生签名 cookie，
  // 其唯一铸取入口是启动日志里的 ?token= URL（token 随每次重启更换）。
  // 登录密码验证通过后，从 supervisor 日志解析「最新一条」token，302 到相对路径
  // /?token=... —— 用户感知仍是输密码登录，底层自动完成原生铸 cookie。
  // 相对 Location 自动继承用户当前访问的域名/协议（公网域名、IP:53080、localhost 皆可）。
  // 本进程监听端口：优先 --port 启动参数，缺省按 DSH web 默认 3080。
  // 用于从日志 token 行里区分「本实例」的启动 token（避免 dsh1/dsh2 串 token → 401）。
  const currentPort = (() => {
    const argv = process.argv || []
    const i = argv.indexOf('--port')
    const raw = i !== -1 ? Number(argv[i + 1]) : NaN
    return Number.isFinite(raw) ? raw : 3080
  })()
  // 从一行日志里提取 token 所属 URL 的端口（日志形如 http://127.0.0.1:<port>/?token=...）。
  const urlPortOf = (text) => {
    const m = text.match(/https?:\/\/[^/:]+:(\d+)/)
    return m ? Number(m[1]) : undefined
  }
  const DSH_LOG_CANDIDATES = ['/main/log/app/dsh-web.log', '/main/log/app/dsh-rescue.log']
  let launchTokenCache = { value: undefined, at: 0 }
  const resolveLatestLaunchToken = () => {
    // 60s 内复用缓存，避免每次登录都全量扫日志
    if (launchTokenCache.value && Date.now() - launchTokenCache.at < 60_000) return launchTokenCache.value
    let best = undefined
    let bestMtime = -1
    for (const f of DSH_LOG_CANDIDATES) {
      try {
        // 注意：原先误用未声明的 fsSync.statSync（ReferenceError 被空 catch 吞掉，
        // 导致本函数恒返 undefined、登录后 302 '/' 无 cookie → 401）。
        // 改用已导入的 statSync；并只认「URL 端口 == 本实例端口」的 token，
        // 从最新一条往旧找，取该文件内本实例最近一次启动 token。
        const st = statSync(f)
        if (st.mtimeMs <= bestMtime) continue
        const text = _readFileSync(f, 'utf8')
        const matches = [...text.matchAll(/dsh web: \S*\?token=([A-Za-z0-9_-]+)/g)]
        if (matches.length === 0) continue
        for (let i = matches.length - 1; i >= 0; i--) {
          if (urlPortOf(matches[i][0]) !== currentPort) continue
          best = matches[i][1]
          bestMtime = st.mtimeMs
          break
        }
      } catch {}
    }
    if (best) launchTokenCache = { value: best, at: Date.now() }
    return best
  }
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
    // P0：签发会话即绑定登录时的 IP 段与设备类别（盗用 cookie 异地即失效）。
    // 方案一放宽：UA 只记设备类别（uaClass）而非逐字节哈希——桌面↔手机切换不误杀；
    // uaHash 仍保留作为老会话兼容/审计参考。
    sessionsStore.create(sessionId, user.username, user.role, maxAgeMs, {
      ipPrefix: ipPrefixOf(bindIpOf(req), fpIpBits),
      uaClass: uaDeviceClass(headerOf(req, 'user-agent')),
      uaHash: uaHashOf(headerOf(req, 'user-agent')),
    })
    setSessionCookie(res, sessionId, secret, maxAgeMs, cookieName)
    // 统一网关登录(20260902):登录成功即铸当日 stepup 解锁 cookie,绑定本次会话 sid,
    // 免去「登录后再单独去 /login/stepup 解锁」这一步。铸币原料与 handleStepup 同源
    // (secret + sid + 当日),被盗 cookie 仍无法凭空铸币;解锁随会话更换/当日切换失效重置。
    const untilMidnight = (() => {
      const d = new Date(); const next = new Date(d); next.setHours(24, 0, 0, 0)
      return Math.floor((next - d) / 1000)
    })()
    res.appendHeader('set-cookie',
      `${STEPUP_COOKIE}=${stepupTokenFor(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${untilMidnight}`)
    // 原生 BrowserAuth 衔接：带最新启动 token 跳转，浏览器自动完成原生铸 cookie。
    // 拿不到 token（日志不可读/无 token 行）则回退原行为，不影响纯 postapi 会话。
    const launchToken = resolveLatestLaunchToken()
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: launchToken ? 'launch-redirect' : 'launch-redirect-miss',
        ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
      })
    } catch {}
    res.writeHead(302, { location: launchToken ? `/?token=${launchToken}` : '/' }).end()
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
    // 管理接口回环豁免同样严格双回环，防伪造 XFF 越权
    const isLoopback = isStrictLoopback(req)
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

    // 机器通道回环豁免必须严格双回环(socket+Host)，拒绝伪造 XFF:127.0.0.1 与 frp 直连免 token
    const isLoopback = isStrictLoopback(req)
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

    // 机器通道整体拒启用(fail-fast)：apiToken 未配置时任何机器方法(含 health 之外)不可用
    if (!apiToken) {
      if (!(req.method === 'GET' && (subPath === '/health' || subPath === ''))) {
        sendJson(res, 503, { ok: false, error: 'machine channel disabled: DSH_GATEWAY_TOKEN not configured' })
        return
      }
    }

    // /health 白名单免 token（PLAN-SEC02 P1：仅 /health 白名单）。健康探测(监控/探活)
    // 不应要求凭据；其它机器通道方法一律 fail-closed 要求 Bearer token。
    const isHealth = req.method === 'GET' && (subPath === '/health' || subPath === '')
    if (isHealth) {
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

    // 机器通道 fail-closed（PLAN-SEC02 P1-急 + §八-待补收口）：
    // ① 非本地(严格回环之外)：一律要求 Bearer token，apiToken 空也拒绝(fail-open 杜绝)；
    // ② 本地(严格回环)：也不再无条件放行——仅放行 config.machineLocalAllow 白名单项与 /health，
    //    未列入的本地 /task → 401（收口 09:19 本地 ping 这类无凭据本地探测）。
    if (!isLoopback) {
      if (!apiToken || !providedToken || !safeEqual(providedToken, apiToken)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid or missing API Token' })
        return
      }
    } else if (subPath !== '/health' && subPath !== '' && !machineLocalAllow.includes(subPath)) {
      // 本地严格回环 + 非 health + 未入白名单：仅当带着匹配的 Bearer apiToken 才放行，
      // 否则 401（收口无凭据的本地探测；本机带 token 的合法脚本不受白名单限制）
      const localTokenOk = apiToken && providedToken && safeEqual(providedToken, apiToken)
      if (!localTokenOk) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized: local task requires machineLocalAllow entry or Bearer token' })
        return
      }
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

    // POST /api/dsh/v1/task 核心执行接口：宿主侧 agents 服务驱动（20260907 迁移，原 ctx.apiProxy 已移除）
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
        // P2（PLAN-SEC02）：非本地机器通道一律强制 cwd=/tmp，禁止自定义工作目录——
        // 防 cwd 逃逸（攻击者曾显式传主体目录读/写任意路径）。仅双回环本地放行显式 cwd。
        const cwd = (isLoopback && body.cwd) ? body.cwd : (isLoopback ? process.cwd() : '/tmp')
        if (!isLoopback) {
          bid.untrustedWorkspace = '/tmp'
          if (body.cwd && body.cwd !== '/tmp') {
            bid.cwdDenied = String(body.cwd).slice(0, 120)
          }
        }

        // 迁移 20260907：原 ctx.apiProxy.sessions.create/prompt/history 已随上游
        // ApiProxy 包移除而失效。改为宿主侧 agents 服务：已有会话直接复用，否则
        // ctx.agents.create 建（meta.cwd 圈养工作目录，agentPreset 可经 body.preset 指定）。
        // prompt 驱动与结果提取由下方 followup + session/event 兜底逻辑统一完成。
        let agent = ctx.agents?.get(sessionId)
        if (!agent) {
          const handle = await ctx.agents.create({
            sessionId,
            meta: { cwd, ...(body.preset ? { agentPreset: body.preset } : {}) },
          })
          agent = handle.agent
        }
        if (!agent) throw new Error('agents service unavailable: cannot create session ' + sessionId)

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
