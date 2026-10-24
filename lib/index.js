/**
 * ============================================================================
 * dsh-postapi-bridge (DSH 统一网关与鉴权桥梁插件)
 * 1. 机器通道：/api/dsh/v1/* 提供免 Cookie 的纯 POST API (Task/MCP/Health)
 * 2. 人类通道：/login 提供 Web 多用户账号密码管理、登录页与持久化 Session 鉴权
 * ============================================================================
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  createReadStream, existsSync, lstatSync, mkdirSync, readFileSync as _readFileSync,
  realpathSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
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

/**
 * 安全读取 cordis 服务（v1.0.2 根因修复）。
 *
 * ⚠️ 为什么不能直接读 ctx 上的 sessionQuery 属性：
 *   cordis 规定「访问未在 `export const inject` 里声明的服务属性会**直接 throw**」——
 *   报错形如 `cannot get property "sessionQuery" without inject`。
 *   本插件刻意**不**把 sessionQuery 写进 inject（否则精简 profile 里整个插件都不加载），
 *   所以任何对该属性的直接访问（哪怕只是 `x == null` 这种判空）都会先抛 ——
 *   防御判断根本走不到，这正是全天所有「400/500 空响应」的真正根因。
 *
 * ⚠️ 为什么每次都现取、而不在 `apply()` 里缓存一次：
 *   `ctx.get(name)` 默认 strict 模式，**只返回「已激活」的服务**。若 sessionQuery 的
 *   激活时机晚于本插件（cordis 里服务就绪顺序不保证），apply 时取到的会是 undefined，
 *   缓存下来就永久失效了 —— 插件表面上「加载成功」，但所有下载端点永远 503。
 *   现取能自然跟随服务上线；且 `ctx.get()` 本身极轻（一次 Map/属性查找），无性能顾虑。
 *
 * @param {object} ctx cordis 上下文
 * @returns {object|undefined} sessionQuery 服务；未激活/不存在时 undefined（不抛错）
 */
function sessionQueryOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
  } catch {
    // 极端情况（ctx 是精简桩、get 实现差异）也不让它冒泡成 500
    return undefined
  }
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('127.') || address.startsWith('::ffff:127.')) return true
  return false
}

// v0.12.4（审查）：已移除 getClientIp（取 X-Forwarded-For **首跳**）。
// 首跳是客户端可任意伪造的（nginx 只在末尾追加，前面的原样保留），不适合做审计/限流依据。
// 全站统一使用下方的 bindIpOf（取末跳 = 离我们最近的受信代理所见地址）。

// v0.12.4：改用 bindIpOf（末跳）判定，与全站口径一致。
// 保留函数名以兼容既有调用点（resolveChannel 的通道标签推断）。
function isLoopbackRequest(req) {
  return isLoopbackAddress(bindIpOf(req))
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
  // bug 修复(v0.11.0)：**空 UA 必须归 other**，不能落到 desktop。
  // 原实现只在匹配到 bot 关键词时才返回 other，空串会一路走到底返回 'desktop'
  // —— 与上面注释「BOT/空值归为 other」不符。后果很实际：
  //   · v0.11.0 的老会话迁移会因此把「无 UA 的脚本请求」当成 desktop 放行并迁移，
  //     等于给任何裸 HTTP 客户端永久放宽；
  //   · 新会话也会把「无 UA」与「真桌面浏览器」视为同类。
  // 归为 other 后，迁移条件（uaClassActual !== 'other'）自然拒绝这类请求。
  if (s.trim().length === 0) return 'other'
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
 * 指纹校验：返回 { ok, reason, ipOk, uaOk, uaClassExpected, uaClassActual }。
 * reason ∈ loopback | whitelist | match | ip-drift | legacy-migrated | legacy-migrated-ip-drift | legacy | mismatch
 *
 * ⚠️ v0.12.2 安全模型变更（方案 A，用户拍板）—— **不是遗漏，是刻意取舍**：
 *
 *   以前：IP 段是**硬绑定**。cookie 被盗 + 异地使用 → 被拦。
 *         代价：移动网络换基站（60.12.x → 36.28.x → 36.23.x）天天误杀正常用户，
 *         线上实测已出现「用户上传被拒」的故障。
 *   现在：IP 段降级为**软证据**——只决定 reason 是 match 还是 ip-drift（后者留审计痕迹），
 *         **不再一票否决**。UA 设备类别成为唯一硬门。
 *
 *   为什么可以这样放宽：cookie 本身是 HMAC 签名（sessionId.hmac，密钥在服务端），
 *   盗用者必须先真的拿到那枚 cookie。而 IP 带来的边际防护，对移动网络用户的误杀
 *   代价远大于收益。
 *
 *   高危操作仍由 **step-up**（当日密码铸币的 dsh_stepup cookie）独立把守 ——
 *   它是与指纹**完全独立**的第二道门，不因本次放宽而削弱。见 stepupTokenFor / verifyStepup。
 *
 *   想恢复旧行为：配置 config.ipDriftPolicy = 'deny'（见第 5 个参数 ipDriftPolicy）。
 *
 * v0.11.0 遗留：返回值带 ipOk / uaOk，供审计区分「到底是 IP 还是 UA 失配」。
 *
 * @param {object} req 请求
 * @param {object} session 会话记录（含 bindIpPrefix / bindUaHash / bindUaClass）
 * @param {string[]} whitelist CIDR 白名单（命中即放行，跳过一切指纹比对）
 * @param {number} ipBits IP 前缀位数
 * @param {(sid:string, uaClass:string)=>any} onLegacyMigrate 老会话迁移回调（v0.12.2 起不再要求 ipOk）
 * @param {'allow'|'deny'} ipDriftPolicy 'allow'（默认）=IP 漂移放行；'deny'=回到旧行为
 */
function isLoopbackHost(req) {
  const host = headerOf(req, 'host').split(':')[0].toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function verifyFingerprint(req, session, whitelist = [], ipBits = 24, onLegacyMigrate = undefined, ipDriftPolicy = 'allow') {
  // 安全修复(20260901审查): 回环放行必须 socket 与 Host 双回环。
  // frp 直连(53080→127.0.0.1:3080)时 socket 恒为 127.0.0.1 且无 XFF，
  // 若仅凭 socket 判回环，盗用 cookie 经 http://IP:53080 可绕过指纹校验。
  if (isStrictLoopback(req)) return { ok: true, reason: 'loopback', ipOk: true, uaOk: true }
  // ⚠️「伪回环」识别（frp 直连场景）：socket 是回环地址、但 Host 不是回环。
  // 这种请求**不是**本机用户，绝不能被放宽 —— 否则任何拿到 cookie 的人都能借 frp 通道
  // 在任意位置通过（它的 IP 必然「不匹配」）。处理：伪回环一律按 deny 语义。
  const socketAddr = req.socket && req.socket.remoteAddress
  const pseudoLoopback = isLoopbackAddress(socketAddr) && !isLoopbackHost(req)
  const ip = bindIpOf(req)
  for (const cidr of whitelist) {
    if (cidrMatch(ip, cidr)) return { ok: true, reason: 'whitelist', ipOk: true, uaOk: true }
  }
  if (!session || !session.bindIpPrefix || (!session.bindUaHash && !session.bindUaClass)) {
    // 完全没有指纹的老会话：没有任何可比对的依据 → fail-closed，倒逼重新登录一次
    return { ok: false, reason: 'legacy', ipOk: false, uaOk: false }
  }
  const ipOk = session.bindIpPrefix === ipPrefixOf(ip, ipBits)
  const uaActual = headerOf(req, 'user-agent')
  const uaClassActual = uaDeviceClass(uaActual)
  const uaHashActual = uaHashOf(uaActual)
  // 是否允许「UA 类别匹配但 IP 漂移」放行。默认 allow（v0.12.2 方案 A）。
  // 伪回环：无论策略如何都按 deny 处理（见上方注释）。
  const allowDrift = ipDriftPolicy !== 'deny' && !pseudoLoopback

  // ===== 哈希命中判定（v0.12.4 安全修复 H1 的核心）=====
  // match 判据 = UA 类别匹配 **且** 哈希命中（当前哈希或历史集合中的任一）。
  // 为什么必须这样：v0.12.2 的「新会话分支只比 bindUaClass」把熵从逐字节哈希(2^57)
  // 降到了设备类别三选一(2^2)，且迁移后**永久**如此、不可逆。审查指出这是安全降级，
  // 修正为：类别是**必要**条件，哈希仍是**主要**熵来源。
  //
  // 历史集合 bindUaHashHistory（N=3）的作用：浏览器升级版本后 UA 变了，旧哈希仍在历史里，
  // 仍算 match —— 既保留熵，又不会「一升级就走宽松路径」。
  const hashCandidates = []
  if (typeof session.bindUaHash === 'string' && session.bindUaHash) hashCandidates.push(session.bindUaHash)
  if (Array.isArray(session.bindUaHashHistory)) {
    for (const h of session.bindUaHashHistory) {
      if (typeof h === 'string' && h && !hashCandidates.includes(h)) hashCandidates.push(h)
    }
  }
  const uaHashOk = hashCandidates.includes(uaHashActual)

  // 统一判定表（H2 修复也在这里）：
  //   类别不匹配                          → mismatch（**计** mismatchCount，可吊销）
  //   类别匹配 + 哈希命中 + IP 匹配        → match
  //   类别匹配 + 哈希命中 + IP 不匹配       → ip-drift（allow 放行 / deny 拒但**不计数**）
  //   类别匹配 + 哈希未命中 + IP 匹配       → ua-hash-drift（放行，记审计；正常升级路径）
  //   类别匹配 + 哈希未命中 + IP 不匹配     → ua-hash-drift（同上，仍放行）
  //
  // ⚠️ 关于「类别匹配但哈希未命中仍放行」：这是**已明确接受的代价**（v0.12.2 方案 A 的
  // 设计前提就是「IP 与 UA 字节都无法作为硬门，否则移动用户天天被踢」）。
  // 与 v0.12.2 的区别在于：现在有 ua-hash-drift 这个**独立 reason** 可审计、可告警，
  // 而不是无痕地混在 ip-drift 里。若某部署想收紧，用 ipDriftPolicy='deny' 会把
  // 「哈希未命中」也一并按拒绝处理（见下方 denied 分支）。
  const base = {
    ipOk, uaOk: session.bindUaClass ? session.bindUaClass === uaClassActual : false,
    uaClassExpected: session.bindUaClass ?? null, uaClassActual,
    uaHashOk, hashCandidates: hashCandidates.length,
  }

  // ① UA 类别不匹配 → 硬拒（含 'other'：bot/curl/空 UA 永远不可能等于 desktop/mobile/tablet）
  //    老会话（无 bindUaClass）不适用此条，走下方专属分支。
  if (session.bindUaClass && session.bindUaClass !== uaClassActual) {
    return { ok: false, reason: 'mismatch', ...base }
  }

  // ② 老会话（无 bindUaClass）：逐字节比对 + 惰性迁移（迁移时把哈希也刷新，见 H1 修复）
  if (!session.bindUaClass) {
    // 老会话的 uaOk 语义 = 逐字节哈希是否命中（历史上就是这么定义的）
    const legacyBase = { ...base, uaOk: uaHashOk }
    if (uaHashOk) {
      // 字节仍匹配：IP 匹配 → match；IP 漂移 → ip-drift（语义同新会话）
      if (ipOk) return { ok: true, reason: 'match', ...legacyBase }
      return allowDrift
        ? { ok: true, reason: 'ip-drift', ...legacyBase }
        : { ok: false, reason: 'ip-denied', ...legacyBase }
    }
    // 字节已漂移：类别可识别才放行并迁移；'other' 一律拒且不迁移
    if (uaClassActual === 'other') return { ok: false, reason: 'mismatch', ...legacyBase }
    // deny 策略下：IP 不匹配则拒绝，且**不迁移**（拒绝同时改用户状态不可接受）
    if (!ipOk && !allowDrift) return { ok: false, reason: 'ip-denied', ...legacyBase }
    // 放行并迁移 —— 迁移会把 bindUaHash 刷新为当前 UA 哈希（保留熵，见 users-store 注释）
    try { onLegacyMigrate?.(session.sessionId, uaClassActual, uaHashActual) } catch {}
    return {
      ok: true, reason: ipOk ? 'legacy-migrated' : 'legacy-migrated-ip-drift',
      ...legacyBase, uaHashBound: true,
    }
  }

  // ③ 新会话（含已迁移的）：类别已匹配（上面 ① 已排除不匹配）
  //    哈希命中 + IP 匹配 → match（最强）
  if (uaHashOk && ipOk) return { ok: true, reason: 'match', ...base }
  //    哈希命中 + IP 漂移 → ip-drift（allow 放行 / deny 拒但**不计数**，H2 修复）
  if (uaHashOk && !ipOk) {
    return allowDrift
      ? { ok: true, reason: 'ip-drift', ...base }
      : { ok: false, reason: 'ip-denied', ...base }
  }
  //    哈希未命中（UA 版本漂移或被盗同类型 UA）→ ua-hash-drift
  //    deny 策略下视作不可接受 → 拒绝（但用独立 reason，不动 mismatchCount）
  if (ipDriftPolicy === 'deny' || pseudoLoopback) {
    return { ok: false, reason: 'ip-denied', ...base }
  }
  //    放行并在通道里刷新哈希（把当前 UA 纳入历史，避免每次都走这个宽松分支）
  try { onLegacyMigrate?.(session.sessionId, uaClassActual, uaHashActual) } catch {}
  return { ok: true, reason: 'ua-hash-drift', ...base }
}

// 仅供 test/ 单元测试使用：导出 P0 纯函数（不暴露任何运行时状态）
export const __p0Helpers = { ipPrefixOf, uaHashOf, cidrMatch, verifyFingerprint }

// ==================== v0.9.0 交付物临时签名下载（file ticket） ====================
// 目的：给「present 过的交付物」签发一个**有时效的、绑定用户的**下载地址，
// 让客户端（含安卓）能用普通 GET 拉文件，无需再走 Cookie/Bearer 组合鉴权。
//
// 有效期规则（两段独立，**票据状态存服务端**，不写死在 token 里）：
//
//     签发 file-ticket ──► 「待激活」，距 issuedAt < 48h 内有效
//                            │
//     第一次下载请求   ──► 激活：activatedAt = now，此后可用到 now + 5h
//                            │
//       激活后 5h 内     ──► **可任意下载**（含 Range 续传、可重复请求，无次数限制）
//       now >= activatedAt + 5h        ──► 410
//       未激活 且 now >= issuedAt + 48h ──► 410
//       过期后           ──► 用户重新调 file-ticket 拿新票（这是唯一的续期方式）
//
// ⚠️ **清理对象是票据，不是文件**：源文件永远不动、不删。
//   交付物是模型产出的工作区文件，其生命周期属于用户/工作区；本插件只是签发访问
//   凭证，无权也不该在任何过期路径上删除别人目录里的文件（删文件是不可逆操作）。
//
// 为什么 exp 不进 token：签发时还不知道「激活时刻」（= 第一次真正下载的时刻），
// 把 exp 写进 token 就只能以签发时刻预判，与「首次下载起 5h」直接矛盾。
// 故 token 只固化「身份与坐标」，时效一律查服务端状态文件。
// token 仍保留 sid/seq/index/uid：验签后**不查库就能做前置校验**，
// 但它们**不作为最终授权依据**（最终以状态库 + 登录态为准）。
//
// 其余设计要点：
//   ① ticketId 与 token 分离（tid = 随机 16 hex 进载荷，状态存服务端）：
//      日志里可以安全地记 ticketId 用于排查，而 ticketId 本身不能用于下载（仍需签名 token）。
//   ② token 绑定 uid：地址是 bearer 式 URL（会进日志/剪贴板/下载器历史），
//      一旦泄露，绑定 uid + 下载时二次校验登录态，可保证「地址给了别人也用不了」。
//   ③ realpath 比对而非字符串前缀：防 symlink 逃逸（/cwd/link -> /etc 时，
//      startsWith 会误判为在工作区内）。只有 realpath 之后的真实路径落在真实
//      cwd 之内才放行。

const FILE_TICKET_VERSION = 2                    // v2：payload 去掉 exp、新增 ticketId
const FILE_TICKET_STATE_VERSION = 1              // 状态文件格式版本
const FILE_TICKET_DEFAULT_ACTIVATE_HOURS = 48    // 「待激活」上限（自 issuedAt 起算）
const FILE_TICKET_DEFAULT_SESSION_HOURS = 5      // 激活后的可用窗口
const FILE_TICKET_DEFAULT_MAX_MB = 200

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]+$/.test(str)) return undefined
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  try { return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64') } catch { return undefined }
}

/**
 * 编码并签名一个 file ticket。
 * payload = { v, tid, sid, seq, index, uid }（**不含 exp**，见文件头）；
 * token = base64url(payload) + '.' + base64url(HMAC)。
 * 用 base64url 而非 base64：token 要能安全地放在路径段里（+/= 会被路径/查询语义影响）。
 * @returns {{ token: string } | { error: string }}
 */
function signFileTicket(payload, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return { error: 'no-secret' }
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64urlEncode(createHmac('sha256', secret).update(body).digest())
  return { token: body + '.' + sig }
}

/**
 * 校验 file ticket：结构 → 验签 → 版本 → 字段类型。**不判过期**（过期由调用方判，
 * 以便区分 403「伪造/损坏」与 410「过期」两种语义）。
 * 验签用 timingSafeEqual，避免按字节比较泄露签名前缀。
 * @returns {{ ok: true, payload } | { ok: false, reason: 'structure'|'signature'|'version'|'fields' }}
 */
function verifyFileTicket(token, secret) {
  if (typeof token !== 'string') return { ok: false, reason: 'structure' }
  const dot = token.indexOf('.')
  if (dot === -1 || dot === 0 || dot === token.length - 1) return { ok: false, reason: 'structure' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'signature' }
  const expected = b64urlEncode(createHmac('sha256', secret).update(body).digest())
  // 长度不同直接拒（timingSafeEqual 要求等长，否则抛错）
  if (sig.length !== expected.length) return { ok: false, reason: 'signature' }
  if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return { ok: false, reason: 'signature' }
  }
  const raw = b64urlDecode(body)
  if (raw === undefined) return { ok: false, reason: 'structure' }
  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return { ok: false, reason: 'structure' } }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'structure' }
  if (payload.v !== FILE_TICKET_VERSION) return { ok: false, reason: 'version' }
  const { tid, sid, seq, index, uid } = payload
  // ticketId：随机 16 hex（8 字节）。它是服务端状态的键，不是凭据本身——但格式仍严格校验，
  // 否则一个畸形 tid 会被拿去当 JSON 键使用（原型污染/超长键）。
  if (typeof tid !== 'string' || !/^[0-9a-f]{16}$/.test(tid)) return { ok: false, reason: 'fields' }
  if (typeof sid !== 'string' || sid.length === 0 || sid.length > 128) return { ok: false, reason: 'fields' }
  if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, reason: 'fields' }
  if (!Number.isSafeInteger(index) || index < 0) return { ok: false, reason: 'fields' }
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > 128) return { ok: false, reason: 'fields' }
  return { ok: true, payload }
}

/** 生成 ticketId：随机 8 字节 → 16 hex。 */
function newTicketId() {
  return randomBytes(8).toString('hex')
}

/**
 * 判定一张票据此刻的可用性（**纯函数**，不读不写磁盘，便于单测注入 now）。
 *
 * 状态机：
 *   activatedAt === null            → 「待激活」：now < issuedAt + activateHours 可用，到点即激活
 *   activatedAt !== null            → 「已激活」：now < activatedAt + sessionHours 可用
 *
 * 边界口径统一用 `now >= deadline` 判过期（即 deadline 那一刻已失效），
 * 与「有效期 [激活, 激活+5h)」的半开区间语义一致。
 *
 * @param {object} record 票据记录 { issuedAt, activatedAt, ... }
 * @param {number} now 当前时刻（毫秒，可注入）
 * @param {number} activateHours 待激活上限（默认 48）
 * @param {number} sessionHours  激活后窗口（默认 5）
 * @returns {{ state: string, reason?: string, canActivate?: boolean, deadline?: number }}
 */
function ticketStateOf(record, now, activateHours, sessionHours) {
  const ah = Number.isFinite(activateHours) && activateHours > 0 ? activateHours : FILE_TICKET_DEFAULT_ACTIVATE_HOURS
  const sh = Number.isFinite(sessionHours) && sessionHours > 0 ? sessionHours : FILE_TICKET_DEFAULT_SESSION_HOURS
  if (!record || typeof record !== 'object') return { state: 'expired', reason: 'missing' }
  const issuedAt = record.issuedAt
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return { state: 'expired', reason: 'bad-issued-at' }
  const activateDeadline = issuedAt + ah * 3600 * 1000
  if (record.activatedAt === null || record.activatedAt === undefined) {
    if (now >= activateDeadline) return { state: 'expired', reason: 'activate-window-elapsed', deadline: activateDeadline }
    return { state: 'pending', canActivate: true, deadline: activateDeadline }
  }
  const activatedAt = record.activatedAt
  if (!Number.isFinite(activatedAt) || activatedAt <= 0) return { state: 'expired', reason: 'bad-activated-at' }
  const sessionDeadline = activatedAt + sh * 3600 * 1000
  if (now >= sessionDeadline) return { state: 'expired', reason: 'session-window-elapsed', deadline: sessionDeadline }
  return { state: 'active', usable: true, deadline: sessionDeadline }
}

/**
 * RFC 5987 编码 Content-Disposition 里的 filename*。
 * 中文/空格/引号必须百分号编码（encodeURIComponent 已覆盖），
 * 另外额外编码 ' ( ) * —— rfc5987 attr-char 不含这几个，浏览器对它们的容忍度不一。
 */
function rfc5987Encode(name) {
  return encodeURIComponent(String(name || 'download'))
    .replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * 判断 child 的真实路径是否落在 parent 的真实路径之内。
 * **两边都必须先 realpath**：只对 child 做 realpath、parent 用原字符串，
 * 会在 parent 自身含 symlink 时误判（例如 cwd 是 /link -> /real/work）。
 * 用 path.relative 判归属，不用 startsWith（"/a/bc" 会被 "/a/b" 前缀误判）。
 * @returns boolean；任一 realpath 抛错（路径不存在等）即 false（fail-closed）。
 */
function isRealpathInside(childPath, parentPath) {
  let childReal, parentReal
  try { childReal = realpathSync(childPath) } catch { return false }
  try { parentReal = realpathSync(parentPath) } catch { return false }
  const rel = relative(parentReal, childReal)
  if (rel === '') return true
  if (rel === '..') return false
  if (rel.startsWith('..' + sep)) return false
  return !isAbsolute(rel)
}

/**
 * 解析 HTTP Range 头（仅支持单区间 bytes=a-b / bytes=a- / bytes=-n）。
 * 返回 { start, end } | { unsatisfiable: true } | { ignore: true }。
 * ignore=true 用于「多区间/语法不认识」——按 RFC 允许整份返回 200。
 * size 为文件字节数。
 */
function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return { ignore: true }
  const spec = header.slice(6).trim()
  if (spec.includes(',')) return { ignore: true }   // 多区间：不支持，退化为整份
  const m = spec.match(/^(\d*)-(\d*)$/)
  if (!m) return { ignore: true }
  const [, a, b] = m
  if (a === '' && b === '') return { ignore: true }
  let start, end
  if (a === '') {
    // bytes=-n：最后 n 字节
    const n = Number(b)
    if (!Number.isSafeInteger(n) || n <= 0) return { unsatisfiable: true }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Number(b)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { unsatisfiable: true }
    if (end >= size) end = size - 1
  }
  if (!Number.isSafeInteger(size) || size <= 0) return { unsatisfiable: true }
  if (start > end || start >= size) return { unsatisfiable: true }
  return { start, end }
}

// 从 req.url 取一个 query 参数（不依赖 node 的 URL 全量解析，保持轻量）。
// 用 decodeURIComponent 并 try/catch：畸形百分号编码不应让整个请求 500。
function queryOf(req, name) {
  const url = typeof req?.url === 'string' ? req.url : ''
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const search = url.slice(at + 1).split('#')[0]
  for (const part of search.split('&')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq) !== name) continue
    try { return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')) } catch { return undefined }
  }
  return undefined
}


// ==================== v1.5.0 交付物「直链」下载（dl ticket） ====================
// 背景（用户原话）：「你不能做一个卡片然后卡片点击就是直接的下载地址吗」——
// 官方交付物卡片在手机 WebView 里点了没反应，用户拿不到文件。方案 C：
// 插件自己渲染一张**整卡是 <a href download>** 的卡片，点击即由浏览器原生下载，
// 前端不发任何 JS 请求、不经过 POST 签票。
//
// 与 file-ticket（v0.9.0，**保持不动**）的区别 —— 两套票据并存，语义各管一段：
//
//   |            | file-ticket            | dl/<token>（本版）        |
//   |------------|------------------------|---------------------------|
//   | 有效期     | 48h 待激活 + 首下起 5h  | **纯时间窗，签发即计时**   |
//   | 激活       | 首次下载激活            | **不激活**（无服务端状态） |
//   | 次数       | 不限                    | **不限**                  |
//   | 用途       | 复杂分享（可换新票/长尾）| **卡片直链，点击即下**     |
//
// 为什么 dl ticket 把 exp 写进 token 而 file-ticket 不写：
//   file-ticket 的窗口从「第一次下载」起算，签发时**无法预知**激活时刻，只能存服务端状态；
//   dl ticket 的窗口从「签发」起算 → exp 在签发时就是确定的，**纯无状态**即可验签+判过期。
//   无状态是刻意的：/files 一次要给 N 个文件各发一张票，若每张都写状态库，
//   一次列表请求就写 N 次磁盘（且要额外清理）；直链票不需要续期语义，也不该有状态负担。
//
// 安全口径（为什么地址是 bearer 式 URL 仍然安全）：
//   ① token 绑定 uid，下载时**必须**与当前会话用户一致（防转发给外人）；
//   ② 仍需会话 cookie（与 /files 同属人类通道）—— 泄露的 URL 在没有登录态时毫无作用；
//   ③ 过期后 410，不续期，用户回到界面重开卡片即可拿到新直链。
//   ⚠️ 日志里**绝不打印 token**（与 file-ticket 同一条硬红线）。

const DL_TICKET_VERSION = 2                       // v2：字段与 file-ticket 对齐（v 字段）
const DL_TICKET_DEFAULT_HOURS = 48                // 纯时间窗默认 48h（签发即起算）

/**
 * 编码并签名一张直链票。
 * payload = { v, sid, seq, index, uid, exp }（exp = 绝对毫秒时间戳）
 * token   = base64url(payload) + '.' + base64url(HMAC-SHA256(secret, payload))
 *
 * 复用 signFileTicket 的编码方式（base64url + HMAC），但**不复用它的载荷结构**：
 * 两者的时效语义不同（一个靠服务端状态，一个靠 exp），混用一个函数只会让后人误读。
 * @returns {{ token: string } | { error: string }}
 */
function signDownloadTicket(payload, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return { error: 'no-secret' }
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64urlEncode(createHmac('sha256', secret).update(body).digest())
  return { token: body + '.' + sig }
}

/**
 * 校验直链票：结构 → 验签 → 版本 → 字段类型。**不判过期**
 * （过期由调用方判，以便区分 403「伪造」与 410「过期」两种语义，与 /file/<token> 同口径）。
 * @returns {{ ok: true, payload } | { ok: false, reason: 'structure'|'signature'|'version'|'fields' }}
 */
function verifyDownloadTicket(token, secret) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return { ok: false, reason: 'structure' }
  const dot = token.indexOf('.')
  if (dot === -1 || dot === 0 || dot === token.length - 1) return { ok: false, reason: 'structure' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'signature' }
  const expected = b64urlEncode(createHmac('sha256', secret).update(body).digest())
  if (sig.length !== expected.length) return { ok: false, reason: 'signature' }
  if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return { ok: false, reason: 'signature' }
  }
  const raw = b64urlDecode(body)
  if (raw === undefined) return { ok: false, reason: 'structure' }
  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return { ok: false, reason: 'structure' } }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'structure' }
  if (payload.v !== DL_TICKET_VERSION) return { ok: false, reason: 'version' }
  const { sid, seq, index, uid, exp } = payload
  if (typeof sid !== 'string' || sid.length === 0 || sid.length > 128) return { ok: false, reason: 'fields' }
  if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, reason: 'fields' }
  if (!Number.isSafeInteger(index) || index < 0) return { ok: false, reason: 'fields' }
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > 128) return { ok: false, reason: 'fields' }
  if (!Number.isSafeInteger(exp) || exp <= 0) return { ok: false, reason: 'fields' }
  return { ok: true, payload }
}

/**
 * 签发一张直链票 + 组装对外字段（**纯函数**，便于单测与「/files 与独立签发」共用一份实现）。
 *
 * 抽出这个函数的理由：/files 要给每个文件发一张，将来若有别的入口也发直链，
 * 必须走同一条路径 —— 否则「有效期算错一天」这类问题会在两个地方各犯一次。
 *
 * @param {object} args { sid, seq, index, uid, hours, now, secret, apiPrefix }
 * @returns {{ ok: true, url: string, expiresAt: number } | { ok: false, error: string }}
 */
function issueDownloadTicket(args) {
  const { sid, seq, index, uid, hours, now, secret, apiPrefix } = args || {}
  const h = Number.isFinite(hours) && hours > 0 ? hours : DL_TICKET_DEFAULT_HOURS
  if (!Number.isSafeInteger(now) || now <= 0) return { ok: false, error: 'bad-now' }
  // 过期时刻：签发即起算（与 file-ticket 的「待激活 48h」不同，这里没有激活这一步）
  const expiresAt = now + Math.floor(h * 3600 * 1000)
  const payload = { v: DL_TICKET_VERSION, sid, seq, index, uid, exp: expiresAt }
  const signed = signDownloadTicket(payload, secret)
  if (!signed.token) return { ok: false, error: signed.error || 'sign-failed' }
  return {
    ok: true,
    url: (apiPrefix || '/api/dsh/v1') + '/dl/' + signed.token,
    expiresAt,
  }
}

/**
 * 判断一个 downloadUrl 是否「可用于直接下载」的形态。
 * 前端卡片在渲染前用它做最后一道自检：**形态不对就静默不渲染卡片**
 * （宁可少一张卡片，也不要把一个点不开的链接画给用户 —— 用户已经在官方卡片上
 * 吃过一次「点了没反应」的亏）。
 *
 * 只接受文档相对的 `<apiPrefix>/dl/<token>`：
 *   ① 以 / 开头（同源文档相对），不接受 http(s):// 绝对地址；
 *   ② 不含协议相对 //host、不含空白/控制字符；
 *   ③ 末段之前是 /dl/。
 * @returns {boolean}
 */
function isUsableDownloadUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return false
  if (url[0] !== '/') return false
  if (url.startsWith('//')) return false
  if (/[\s\u0000-\u001f]/.test(url)) return false
  if (url.indexOf('/dl/') === -1) return false
  const tail = url.slice(url.lastIndexOf('/dl/') + 4)
  return /^[A-Za-z0-9_.-]+$/.test(tail)
}

// ==================== v0.12.0 会话交付物清单（presented list） ====================
// 背景：官方 deliverables 文件卡片在本环境**不渲染**（客户端 projection 没把该 turn 的
// present 数据投出来，实测零个 [data-presented-file] 节点）。本插件改为**自己渲染**列表：
// 服务端把会话内所有 present 事件整理成清单返回，前端据此画卡片 + 下载按钮。
//
// 数据源：sessionQuery.listEvents(sessionId)（官方公开接口，按 seq 升序返回全部事件）。
// 注意：取服务必须走 sessionQueryOf(ctx) / ctx.get('sessionQuery')，不可直接读属性。
// 校验口径与下载端点**严格一致**：realpath 归属会话 cwd、必须是普通文件、不超 downloadMaxMB。
// 关键取舍：**单条不合格只跳过该条，不整批失败** —— 一个文件被删/超限不应让整张列表变空。

/**
 * 从 **listEvents 的轻量记录** 里筛出 deliverables/presented，按 seq 倒序（最新在最前）。
 *
 * ⚠️ v1.0.3 根因修复：listEvents **不返回 data 载荷**。
 *   官方类型 packages/session-query/session-query/src/types.ts:59 的 SessionEventRecord 只有
 *     { sessionId, seq, type, time, surface }  —— **没有 data 字段**；
 *   官方注释也写明 List **lightweight** raw-log event records（index.ts:265）。
 *
 *   此前本函数从 r.data 里读 files：`const data = r.data; if (!data || !Array.isArray(data.files)) continue`
 *   ⇒ data 恒为 undefined ⇒ 恒 continue ⇒ events 恒为空 ⇒ 接口 200 但 files: []。
 *   **这就是「接口活了但永远空列表」的根因。**
 *
 * 本函数现在**只看 seq/type/time**，拿到的 seq 由调用方逐个 readEvent 取完整事件（含 data）。
 * 因此本函数实现中**不得出现 .data**（静态断言 G5 守着）。
 *
 * @param {Array} records listEvents 的返回值（轻量记录）
 * @returns {Array<{seq:number, type:string, time:number}>} 按 seq 倒序
 */
function pickPresentedEvents(records) {
  const out = []
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.type !== 'deliverables/presented') continue
    if (!Number.isSafeInteger(r.seq)) continue
    out.push({ seq: r.seq, type: r.type, time: typeof r.time === 'number' ? r.time : null })
  }
  out.sort((a, b) => (b.seq || 0) - (a.seq || 0))
  return out
}

/**
 * 把一个 present 事件展开成「候选条目」列表（每文件一条），保持 seq 倒序、事件内 index 升序。
 * ⚠️ 输入必须是 **readEvent 拿到的完整事件**（含 data.files），不是 listEvents 的轻量记录。
 * 只做形状层面的筛选（path 必须非空字符串），文件系统层面的校验由调用方逐条做。
 */
function flattenPresentedFiles(events) {
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    const files = ev.data && Array.isArray(ev.data.files) ? ev.data.files : []
    for (let index = 0; index < files.length; index++) {
      const f = files[index]
      if (!f || typeof f.path !== 'string' || f.path.trim().length === 0) continue
      out.push({
        seq: ev.seq,
        index,
        turn: typeof ev.data.turn === 'number' ? ev.data.turn : null,
        time: typeof ev.time === 'number' ? ev.time : null,
        path: f.path,
        description: typeof f.description === 'string' ? f.description : '',
      })
    }
  }
  return out
}

// 仅供 test/ 单元测试使用：导出 v1.5.0 直链票纯函数
export const __dlTicketHelpers = {
  signDownloadTicket, verifyDownloadTicket, issueDownloadTicket, isUsableDownloadUrl,
  DL_TICKET_VERSION, DL_TICKET_DEFAULT_HOURS,
}

// 仅供 test/ 单元测试使用：导出 v0.12.0 纯函数（presented list）
export const __presentedHelpers = { pickPresentedEvents, flattenPresentedFiles }

// 仅供 test/ 单元测试使用：导出 v0.9.0 纯函数
export const __fileTicketHelpers = {
  signFileTicket, verifyFileTicket, newTicketId, ticketStateOf,
  rfc5987Encode, isRealpathInside, parseRangeHeader, redactAuditPath,
  FILE_TICKET_DEFAULT_ACTIVATE_HOURS, FILE_TICKET_DEFAULT_SESSION_HOURS,
  FILE_TICKET_VERSION, FILE_TICKET_STATE_VERSION,
}

// ==================== 票据状态持久化（file-tickets.json） ====================
// 为什么单独落一个 JSON 而不是塞进 users/sessions：票据是短生命周期、写多读多的
// 临时凭据状态，关注点与用户库不同；独立文件也便于运维直接查看/清理。
// 位置：auditDataDir(config) + /file-tickets.json（与 access-log.jsonl 同目录）。
//
// 文件结构：
//   {
//     "v": 1,
//     "tickets": {
//       "<tid>": { "sid": "...", "seq": 12, "index": 0, "uid": "alice",
//                  "issuedAt": 1730000000000, "activatedAt": null }
//     }
//   }
//
// 并发与落盘：
//   - 落盘用 writeFileSync(tmp) + renameSync 原子替换（沿用 users-store 的做法），
//     避免读者看到半截 JSON；
//   - 激活是「先读后写」的竞争点：本类所有写方法都在**同步**执行段内完成
//     「判空 → 赋值 → 落盘」。Node 是单线程且这里全程无 await，因此同一进程内
//     **天然满足「只允许一次激活，后到者沿用已存在的值」**。这是对运行时模型的
//     显式依赖，将来若把写路径改成异步，必须重新引入锁。
//   - 写失败只记日志、不抛错：**清理/落盘失败远没有「签发/下载失败」严重**，
//     内存态继续服务即可（宁可状态短暂不一致，也不要整条链路不可用）。
class FileTicketStore {
  constructor(dir, fileName) {
    this.dir = dir
    this.path = join(dir, fileName)
    this.state = { v: FILE_TICKET_STATE_VERSION, tickets: {} }
    this.loadedMtime = -1
  }

  /**
   * 惰性读：每次访问前比对 mtime，变了就重读（支持多进程/多实例共享同一文件）。
   * 文件缺失或损坏一律当作空的空库：损坏的票据库不应拖垮插件，
   * 且「当作空」使旧票据全部失效 —— 是 fail-closed 方向。
   */
  load() {
    let mtime = -1
    try { mtime = statSync(this.path).mtimeMs } catch { mtime = -1 }
    if (mtime === this.loadedMtime) return this.state
    this.loadedMtime = mtime
    if (mtime === -1) {
      // 文件不存在：保持当前内存态（可能是刚 put 但还没落盘）
      return this.state
    }
    try {
      const parsed = JSON.parse(_readFileSync(this.path, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.tickets && typeof parsed.tickets === 'object') {
        this.state = { v: FILE_TICKET_STATE_VERSION, tickets: parsed.tickets }
      }
    } catch {
      // 损坏：保持上一次已知状态，不覆盖内存（避免一次读失败就把票据全清掉）
    }
    return this.state
  }

  /** 原子落盘。失败只记日志、返回 false，不抛。 */
  persist(logger) {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      renameSync(tmp, this.path)
      try { this.loadedMtime = statSync(this.path).mtimeMs } catch {}
      return true
    } catch (err) {
      try { logger?.error?.('[postapi-file-ticket] persist failed: ' + (err && err.message ? err.message : err)) } catch {}
      return false
    }
  }

  get(tid) {
    const t = this.load().tickets
    return Object.prototype.hasOwnProperty.call(t, tid) ? t[tid] : undefined
  }

  put(tid, record) {
    this.load().tickets[tid] = record
  }

  delete(tid) {
    const t = this.load().tickets
    if (Object.prototype.hasOwnProperty.call(t, tid)) delete t[tid]
  }

  size() { return Object.keys(this.load().tickets).length }

  /**
   * 清理不可再用的票据。调用时机：插件启动一次 + 每次签发一次（惰性，无需定时器）。
   * 判据与 ticketStateOf 同源，避免「能下却被清」或「不能下却永留」的错位：
   *   activatedAt === null 且 now >= issuedAt + activateHours  → 删
   *   activatedAt !== null 且 now >= activatedAt + sessionHours → 删
   * ⚠️ 只删**票据记录**，绝不触碰源文件。
   * @returns {{ removed:number, kept:number }}
   */
  cleanup(now, activateHours, sessionHours, logger) {
    const tickets = this.load().tickets
    let removed = 0
    for (const tid of Object.keys(tickets)) {
      if (ticketStateOf(tickets[tid], now, activateHours, sessionHours).state === 'expired') {
        delete tickets[tid]
        removed += 1
      }
    }
    if (removed > 0) this.persist(logger)
    return { removed, kept: this.size() }
  }
}

// ==================== v0.8.0 安卓客户端 JSON 登录（mobile-login） ====================
// 背景：安卓客户端（DSH PostAPI）无法提交 HTML 表单，需要一个「可编程」的登录入口：
//   ① POST 账号密码 → 拿到可直接交给 WebView 加载的 launchUrl（内含官方启动令牌）；
//   ② 同时拿到本插件自己的会话 cookie 值，让 WebView 在加载 launchUrl 前先种上，
//      这样「插件会话」与「官方签名 cookie」两套鉴权一次性备齐，减少一次往返。
// 以下两个纯函数只做「输入规范化 + 合法性校验」，不触碰任何运行时状态，便于单测。

/**
 * 规范化客户端期望的 authority（scheme://host 里的 host[:port]）。
 * 优先级：请求体 host > x-forwarded-host > Host 头 > 'localhost'（由调用方传入候选值）。
 * 安全边界：launchUrl 最终会被客户端直接加载，任何注入（换行/空格/路径/凭据/@/?/#）
 * 都会变成 SSRF 或钓鱼面，故严格白名单：只允许单段主机名 + 可选端口。
 *   允许：字母 数字 . - :（覆盖 IPv4、域名、IPv6 字面量的冒号形式）
 *   拒绝：协议相对前缀 //、userinfo @、路径 /、查询 ?、片段 #、空白与换行、下划线以外符号
 * 返回 { ok:true, host } 或 { ok:false }（调用方一律回 400，不透露是哪一段非法）。
 */
function normalizeAuthority(raw) {
  // 只接受字符串：数字/对象等一律视为非法（避免 String() 把奇怪对象序列化成 host）
  if (typeof raw !== 'string') return { ok: false }
  // 先记「有没有被首尾空白包住」：trim 只用于判定，宁可拒绝也不静默清洗，
  // 因为 Header 值里的空白往往是头部折叠/注入的痕迹。
  const trimmed = raw.trim()
  if (trimmed !== raw) return { ok: false }
  const s = raw
  if (!s || s.length > 255) return { ok: false }
  // 只允许 [A-Za-z0-9.:-] 三类字符 + 方括号（IPv6 字面量）：
  //   排除 //（协议相对 URL 可旁路 scheme）、/ ? #（路径/查询/片段）、@（userinfo 钓鱼）、
  //   空格/制表/换行（头部注入）、下划线等其它符号。
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(s)) return { ok: false }
  if (s.startsWith('.') || s.endsWith('.') || s.includes('..')) return { ok: false }

  // IPv6 字面量（形如 [::1] 或 [::1]:3080）：整段校验，端口只允许方括号之后出现
  if (s.startsWith('[')) {
    const m = s.match(/^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/)
    if (!m) return { ok: false }
    if (m[2] !== undefined) {
      const n = Number(m[2])
      if (n < 1 || n > 65535) return { ok: false }
    }
    return { ok: true, host: s }
  }
  if (s.includes('[') || s.includes(']')) return { ok: false }

  // 非方括号形式：最多一个冒号（host:port）。裸 IPv6（多个冒号）必须加方括号才合法
  // —— 否则拼进 URL 后端口归属有歧义（https://::1:3080/ 是无效 URL）。
  const firstColon = s.indexOf(':')
  if (firstColon !== -1) {
    if (s.indexOf(':', firstColon + 1) !== -1) return { ok: false }
    const port = s.slice(firstColon + 1)
    if (!/^\d{1,5}$/.test(port)) return { ok: false }
    const n = Number(port)
    if (n < 1 || n > 65535) return { ok: false }
  }
  return { ok: true, host: s }
}

/**
 * 规范化 scheme。只允许 http/https（launchUrl 走 GET，不需要 ws 等其它协议）。
 * 未提供时按 x-forwarded-proto 推断，仍为空则默认 https（外网入口常态）。
 */
function normalizeScheme(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'undefined') return { ok: false }
  const rawStr = raw || ''
  // 与 normalizeAuthority 同一口径：首尾空白即判非法（头部注入痕迹），不做静默清洗
  if (rawStr.trim() !== rawStr) return { ok: false }
  const s = rawStr.toLowerCase()
  if (!s) return { ok: true, scheme: 'https', from: 'default' }
  if (s !== 'http' && s !== 'https') return { ok: false }
  return { ok: true, scheme: s, from: 'explicit' }
}

// 仅供 test/ 单元测试使用：导出 v0.8.0 纯函数
export const __mobileLoginHelpers = { normalizeAuthority, normalizeScheme }

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
  // bug 修复(v0.8.0)：until === 0 表示「累计中、尚未锁定」，不是「已过期」。
  // 原判据 `Date.now() > rec.until` 在 until=0 时恒为 true → 每次查询都把计数删掉，
  // `count` 永远停在 1，5 次阈值永不触发（stepup 与 mobile-login 的限流实际都失效）。
  // 改为：只有真正设过锁定时刻(until>0)且已过期，才清记录。
  if (rec.until === 0) return false
  if (Date.now() > rec.until) { stepupFails.delete(ip); return false }
  return true
}
function stepupRecordFail(ip) {
  const rec = stepupFails.get(ip) || { count: 0, until: 0 }
  rec.count += 1
  if (rec.count >= 5) { rec.until = Date.now() + 10 * 60 * 1000; rec.count = 0 }
  stepupFails.set(ip, rec)
  // 注：set 回写是必要的（首次失败时 rec 是新对象，不回写则 Map 里没有它）。
  // 计数本身能正常累加；v0.8.0 之前「限流无效」的根因在 stepupThrottled 的
  // until=0 判据（见该函数注释），此处无需改动。
}

// ==================== v0.3.0 溯源审计 ====================
// ⚠️ 版本号真源 = package.json。此处必须同步更新（历史上曾滞后到 0.6.4 而 package 已 0.6.6）。
// 20260922：0.6.7 —— 移除硬编码 sessionSecret 兜底（改 fail-closed，见 apply 内注释）。
const AUDIT_VERSION = '1.9.0'
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

/**
 * v1.3.0：App 分发目录（APK + 版本信息）。
 *
 * 为什么放数据目录而不是插件目录：
 *   · 插件目录在 npm 安装/sync.sh 重部署时会被 `rm -rf` 再拷一份，APK 会丢；
 *   · 数据目录天然不进 git、不被 sync 复制、npm install 也不碰；
 *   · 与审计日志同根（auditDataDir），运维只需记住一个位置。
 *
 * 约定：$DSH_HOME/data/dsh-postapi-bridge/app/
 *   app-latest.apk      —— 最新 APK
 *   app-version.json    —— { version, code, notes, publishedAt, size, sha256, filename }
 *
 * ⚠️ 本插件**只读**这个目录，不负责发布（发布由运维手工放文件）。
 */
function appDistDir(config) {
  return join(auditDataDir(config), 'app')
}

// ⚠️ 固定文件名：不接受任何用户输入参与路径拼接（安全要求 ①）。
const APP_APK_NAME = 'app-latest.apk'
const APP_VERSION_NAME = 'app-version.json'

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

// v0.9.0：审计里的 subPath 必须先脱敏。
// 背景：下载地址形如 <apiPrefix>/file/<token>，token 本体就是可用凭据；
// 若原样写进 access-log.jsonl / 进程日志，等于把「临时密码」永久留档。
// 这里只保留路径形状（/file/<redacted>），token 指纹交给专门的审计字段。
function redactAuditPath(subPath) {
  const s = String(subPath || '')
  const marker = '/file/'
  const at = s.indexOf(marker)
  if (at === -1) return s
  return s.slice(0, at) + marker + '<redacted>'
}

function buildAuditBase(req, subPath, isLoopback, providedToken, config) {
  const ip = bindIpOf(req)
  const xff = headerOf(req, 'x-forwarded-for')
  const ch = resolveChannel(req, providedToken, config)
  return {
    version: AUDIT_VERSION,
    ts: Date.now(),
    iso: new Date().toISOString(),
    method: req.method,
    subPath: redactAuditPath(subPath),
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


// ==================== v1.4.0 客户端日志自动上报（/client-log） ====================
//
// 背景：用户在**安卓 App 的 WebView** 里输入比桌面浏览器卡，但手机上没有 adb，
//   Console 日志根本拉不出来。于是让前端（lib/client.js）把环境快照 / 长任务 /
//   FPS 掉帧 / 错误批量打上来，服务端落盘供远程诊断。
//
// 🔴 为什么端点**免鉴权**（本功能唯一的安全妥协，必须理解清楚）：
//   用户手机上的 /files 返回 401 —— WebView 里没有插件会话 cookie（登录态在 App 侧，
//   与浏览器登录是两条链路）。日志端点若要求 cookie 或 Bearer，用户就**永远传不上来**，
//   “远程诊断”这个唯一目的即落空。因此 /client-log 与 /mobile-login 同级：
//   在**任何 token / cookie 校验之前**分流。
//
//   安全边界由五条共同构成（缺一条都会变成存储型 DoS 面）：
//     ① 单次请求 ≤ 256KB（413），且**边读边计数**，超限立刻断开，不把整个 body 读进内存；
//     ② 每 IP 每小时 ≤ 20 次（429）；
//     ③ 目录总量 ≤ 50MB：超限删最旧文件；
//     ④ 只保留最近 50 个文件；
//     ⑤ 字段白名单 + entries 上限 200 + 🔴 **写盘前脱敏**（redactClientLogText）。
//   残余风险（已明确接受）：匿名者可写**脱敏后的**垃圾数据挤掉旧日志。
//   缓解：条数/体积上限决定“挤掉”需要持续大量请求，且每次都会留下审计记录。

const CLIENT_LOG_MAX_BODY_BYTES = 256 * 1024        // 单次请求体上限
const CLIENT_LOG_MAX_ENTRIES = 200                  // entries 上限（超出保留末尾 = 最新）
const CLIENT_LOG_MAX_FILES = 50                     // 保留最近 N 个文件
const CLIENT_LOG_TOTAL_MAX_BYTES = 50 * 1024 * 1024 // 目录总量上限 50MB
const CLIENT_LOG_RATE_LIMIT = 20                    // 每 IP 每小时次数
const CLIENT_LOG_RATE_WINDOW_MS = 60 * 60 * 1000

// 允许的枚举值。非法值不报错，一律归 unknown —— 日志端点不该为格式问题拒绝一次
// 宝贵的现场数据（客户端可能是老版本）。
const CLIENT_LOG_SOURCES = ['web', 'app']
const CLIENT_LOG_KINDS = ['snapshot', 'perf', 'error', 'flush', 'sidebar-diag']

// 每 IP 每小时计数（内存态、重启即清）。与 stepupFails 同风格，但**独立一张表**：
// stepup 的语义是“失败累计→锁定”，与“任意请求计数→窗口重置”不同，混用会让两套阈值漂移。
const clientLogRate = new Map()

/**
 * 客户端日志限流判定。
 * 窗口语义：首次请求起算固定 1 小时，窗口内第 21 次起拒绝。
 * 过期记录在**下一次命中同一 IP** 时重置（不起定时器，避免多一个后台任务）。
 * @returns {{ allowed: boolean, used: number, resetAt: number }}
 */
function clientLogRateCheck(ip, now) {
  const t = typeof now === 'number' ? now : Date.now()
  const key = String(ip || 'unknown')
  let rec = clientLogRate.get(key)
  if (!rec || t >= rec.resetAt) {
    rec = { count: 0, resetAt: t + CLIENT_LOG_RATE_WINDOW_MS }
    clientLogRate.set(key, rec)
  }
  if (rec.count >= CLIENT_LOG_RATE_LIMIT) {
    return { allowed: false, used: rec.count, resetAt: rec.resetAt }
  }
  rec.count += 1
  return { allowed: true, used: rec.count, resetAt: rec.resetAt }
}

// ---- 脱敏规则（🔴 必须作用在**写盘之前**，不能先写后脱）----
//
// 为什么要脱敏：日志来源是**页面里的一切文本** —— 包括 console.error 的实参，
//   而 DSH 的错误信息里经常夹着请求 URL、Authorization 头、后端回显的 token。
//   这些一旦落盘并被人拉走，等于把会话凭据永久留档。
//
// 覆盖的模式（顺序有意义：先“键值对”再“裸串”，否则 value 会被拆成两半）：
//   A. 键值形态：dsh_postapi_session=xxx / token: xxx / password=xxx / "apiKey":"xxx"
//   B. 请求头形态：Authorization: Bearer xxx（含 Basic / 裸 token）
//   C. 裸的长 hex（32 位以上，可能是 sha256 / HMAC / 签名）
//   D. 裸的长 base64url（32 位以上，可能是随机 token / JWT 段）
//
// 实现约束：纯函数、可单测、**绝不抛错**（正则写错也只应影响脱敏效果，
//   不能让端点 500 —— 那样客户端会静默丢掉现场数据）。

const REDACT_MARK = '<redacted>'

// Authorization: Bearer <cred> / Basic <cred>：只留头名、抹掉值。
// ⚠️ 必须**先于**通用 KV 规则执行：Bearer 值以空格分隔，通用规则只抹到第一个空白，
//    会把 token 本体留在后面。
const RE_AUTHZ = /(["']?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?([A-Za-z0-9._~+/=\-]{8,})/gi
const RE_BEARER = /((?:bearer|basic)\s+)([A-Za-z0-9._~+/=\-]{8,})/gi

// 通用 KV：<敏感键><分隔符><值>。值支持三种引号包裹 + 裸值。
// 键名清单逐个生成正则（而非拼一个巨正则）：便于阅读增删，且每条可独立验证。
const CLIENT_LOG_SECRET_KEYS = [
  'dsh_postapi_session', 'dsh_stepup', 'dsh-auth-[A-Za-z0-9_-]+',
  'authorization', 'cookie', 'set-cookie',
  'token', 'access_token', 'refresh_token', 'id_token',
  'password', 'passwd', 'pwd', 'secret', 'sessionsecret', 'api_?key', 'apikey',
]
// 值形态四选一：双引号串 / 单引号串 / 反引号串 / 裸值（到空白或分隔符为止）。
const CLIENT_LOG_VALUE_PATTERN = "(?:\x22[^\x22]*\x22|\x27[^\x27]*\x27|\x60[^\x60]*\x60|[^\\s\x22\x27\x60;,}]+)"
const RE_SECRET_KV = CLIENT_LOG_SECRET_KEYS.map(function (k) {
  return new RegExp("[\x27\x22]?" + k + "[\x27\x22]?\\s*[:=]\\s*" + CLIENT_LOG_VALUE_PATTERN, "gi")
})
// C：32 位以上连续 hex（前后不能紧贴同类字符，避免把更长的串切一半 —— 那样反而留残片）
const RE_LONG_HEX = /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g
// D：32 位以上 base64url / base64 串（JWT 段、随机 token 都是这个形状）
const RE_LONG_B64 = /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+/=]{32,}={0,2}(?![A-Za-z0-9_\-+/=])/g

/**
 * 对**单个字符串**做脱敏。不抛错（内部 try/catch），非字符串原样返回。
 * 长度控制由调用方（sanitizeClientLogString）负责。
 */
function redactClientLogText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  try {
    let s = text
    s = s.replace(RE_AUTHZ, function (m, head, value) { return head + REDACT_MARK })
    s = s.replace(RE_BEARER, function (m, head, value) { return head + REDACT_MARK })
    for (const re of RE_SECRET_KV) {
      s = s.replace(re, function (m) { return REDACT_MARK })
    }
    s = s.replace(RE_LONG_HEX, REDACT_MARK)
    s = s.replace(RE_LONG_B64, REDACT_MARK)
    return s
  } catch {
    // 脱敏失败 → 返回不含原文的占位：宁丢信息，不泄露凭据。
    return REDACT_MARK
  }
}

// 递归脱敏任意 JSON 值（对象/数组/字符串）。数字/布尔/null 原样。
// 为什么递归而不是只处理已知字段：白名单会演进、错误栈是任意形状，
// 只按名字挑字段脱敏必然漏（例如 stack 里带 URL、extra 里带任意对象）。
function redactClientLogValue(value, depth) {
  const d = typeof depth === 'number' ? depth : 0
  if (d > 6) return REDACT_MARK          // 防环（正常数据远达不到）
  if (typeof value === 'string') return redactClientLogText(value)
  if (Array.isArray(value)) return value.map(function (v) { return redactClientLogValue(v, d + 1) })
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      out[redactClientLogText(k)] = redactClientLogValue(value[k], d + 1)
    }
    return out
  }
  return value
}

/**
 * 强转成“脱敏 + 截断后的短字符串”。
 * ⚠️ 顺序：先脱敏 → 再截断 → **再脱敏**。
 *   · 先截断后脱敏：可能把 32 位 token 截成 31 位而**漏网**；
 *   · 只脱敏一次：截断可能把长串切出新的“32 位 hex”形态。
 * 两次调用都很便宜。
 */
function sanitizeClientLogString(value, max) {
  const lim = typeof max === 'number' ? max : 2000
  let s
  try { s = typeof value === 'string' ? value : String(value) } catch { s = '' }
  if (typeof s !== 'string') s = ''
  s = redactClientLogText(s)
  if (s.length > lim) s = s.slice(0, lim) + '…[truncated]'
  s = redactClientLogText(s)
  return s
}

function clientLogNumber(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (typeof min === 'number' && n < min) return null
  if (typeof max === 'number' && n > max) return null
  return n
}

/**
 * 字段白名单归一化：只保留约定字段，多余字段**丢弃**（不报错）。
 * 输出结构即落盘结构 —— 保证“文件里有什么”可预期。
 */
function normalizeClientLogRecord(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const source = CLIENT_LOG_SOURCES.includes(raw.source) ? raw.source : 'unknown'
  const kind = CLIENT_LOG_KINDS.includes(raw.kind) ? raw.kind : 'unknown'

  const envIn = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {}
  const scr = Array.isArray(envIn.screen) ? envIn.screen : []
  const supportsIn = envIn.supports && typeof envIn.supports === 'object' ? envIn.supports : {}
  const env = {
    screen: [clientLogNumber(scr[0], 0, 100000), clientLogNumber(scr[1], 0, 100000)]
      .filter(function (n) { return n !== null }),
    dpr: clientLogNumber(envIn.dpr, 0, 100),
    deviceMemory: clientLogNumber(envIn.deviceMemory, 0, 1000000),
    hardwareConcurrency: clientLogNumber(envIn.hardwareConcurrency, 0, 1000000),
    supports: { webgl: supportsIn.webgl === true, compression: supportsIn.compression === true },
  }

  // entries：超 200 条**保留最新**（末尾）—— 排障看的是“出事前后那几秒”。
  const all = Array.isArray(raw.entries) ? raw.entries : []
  const kept = all.length > CLIENT_LOG_MAX_ENTRIES ? all.slice(all.length - CLIENT_LOG_MAX_ENTRIES) : all
  const entries = []
  for (const item of kept) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    // 每条 entry 同样走白名单；附加信息（fps/cls/target…）由客户端放进 msg 或 extra，
    // extra 也会被递归脱敏。
    const out = {
      t: clientLogNumber(item.t, 0, Number.MAX_SAFE_INTEGER),
      level: typeof item.level === 'string' ? sanitizeClientLogString(item.level, 16) : null,
      kind: typeof item.kind === 'string' ? sanitizeClientLogString(item.kind, 32) : null,
      duration: clientLogNumber(item.duration, 0, 3600000),
      msg: typeof item.msg === 'string' ? sanitizeClientLogString(item.msg, 2000) : null,
    }
    if (item.extra !== undefined) out.extra = redactClientLogValue(item.extra, 0)
    entries.push(out)
  }

  return {
    v: 1,
    receivedAt: new Date().toISOString(),
    source,
    kind,
    // UA 也脱敏：极少数 UA 字符串里会带 App 注入的自定义 token。
    ua: sanitizeClientLogString(raw.ua, 400),
    env,
    entries,
    // 原始条数保留：排查时要能看出“客户端报了多少、我们收了多少”（截断不可静默）。
    meta: { receivedEntries: all.length, keptEntries: entries.length, truncated: all.length > entries.length },
  }
}

/** client-logs 目录：与审计日志同根，不进 git、不被 sync.sh 清理。 */
function clientLogDir(config) {
  return join(auditDataDir(config), 'client-logs')
}

/**
 * 清理目录：按“文件数 > 50”“总量 > 50MB”两条上限删最旧，直到都达标。
 * 只处理 *.json（本端点自己写的文件），不碰任何其它东西。
 * @returns {{ removed:number, bytes:number, files:number, removedFiles:string[] }}
 */
function pruneClientLogDir(dir, opts) {
  const o = opts || {}
  const maxFiles = typeof o.maxFiles === 'number' ? o.maxFiles : CLIENT_LOG_MAX_FILES
  const maxBytes = typeof o.maxBytes === 'number' ? o.maxBytes : CLIENT_LOG_TOTAL_MAX_BYTES
  const removedFiles = []
  let list
  try {
    list = readdirSync(dir)
      .filter(function (n) { return n.endsWith('.json') && !n.endsWith('.tmp') })
      .map(function (n) {
        try {
          const st = statSync(join(dir, n))
          return { name: n, mtime: st.mtimeMs, size: st.size }
        } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return { removed: 0, bytes: 0, files: 0, removedFiles }
  }
  // 最旧优先（mtime 升序；同 mtime 用文件名兜底 —— 文件名以时间戳开头，天然有序）
  list.sort(function (a, b) { return (a.mtime - b.mtime) || (a.name < b.name ? -1 : 1) })
  let bytes = list.reduce(function (s, f) { return s + f.size }, 0)
  let files = list.length
  for (const f of list) {
    if (files <= maxFiles && bytes <= maxBytes) break
    try {
      unlinkSync(join(dir, f.name))
      bytes -= f.size
      files -= 1
      removedFiles.push(f.name)
    } catch {
      // 删不掉（权限/竞态）就跳过：绝不因此让上报失败
    }
  }
  return { removed: removedFiles.length, bytes, files, removedFiles }
}

/**
 * 原子写盘：先写 .tmp 再 rename，避免读者看到半截 JSON。
 *
 * v1.4.1：tmp 文件名带唯一后缀（pid + 随机）。
 * 旧实现 tmp 恒为 "<target>.tmp" —— 同一目标文件并发写时，两个请求会共用同一个
 * tmp 路径，A 写一半 B 覆盖、B rename 后 A 再 rename 就会 ENOENT（或互相截断）。
 * 文件名本身已保证每次不同，这里再兜一层：即便将来并列写同一文件名也安全。
 */
function writeClientLogFile(dir, fileName, record) {
  const target = join(dir, fileName)
  const tmp = target + '.' + process.pid + '-' + randomBytes(4).toString('hex') + '.tmp'
  const text = JSON.stringify(record, null, 2)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, target)
    return { ok: true, bytes: Buffer.byteLength(text), path: target }
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    return { ok: false, bytes: 0, path: target, error: err && err.message ? err.message : String(err) }
  }
}

/**
 * 文件名：<YYYYMMDD-HHMMSS-mmm>-<16位随机hex>.json
 *
 * v1.4.1 修 bug：旧格式 "<到秒的时间戳>-<sha256(IP) 前 8 位>" 里**唯一的区分量是 IP**，
 * 于是同一 IP 在同一秒内的多次上报必然得到同一个文件名 —— 后一次 rename 直接覆盖
 * 前一次（实测：手机端 snapshot/perf/flush 同秒到达互相吞日志）。
 *
 * 现在两个区分量一起上：
 *   · 时间戳精确到**毫秒**（同秒不同毫秒可见即可区分）；
 *   · 再加 8 字节密码学随机（16 位 hex）—— 同一毫秒内并发也不撞（碰撞概率 ~2^-64）。
 * ⚠️ 绝不用 IP 做唯一性来源：同 IP 高频上报是常态，不是异常。
 * 保留可读的时间前缀：pruneClientLogDir 以 mtime 排序、文件名兜底，前缀保持有序可读。
 *
 * @param {string} ip 仅保留参数位（不再参与命名）；传不传都不影响结果。
 * @param {number} [now] 可注入时钟（测试用）；缺省 Date.now()
 */
function clientLogFileName(ip, now) {
  const t = typeof now === 'number' ? now : Date.now()
  // ⚠️ 不能用 toISOString()：它固定输出 UTC，文件名里的时间会比本地时间差一个时区
  //    （实测 UTC+8 下写 19:33 得 11:33，运维按本地时间找文件会找不到）。
  //    这里用**本地时间**格式化，与审计日志的本地时间直觉保持一致。
  const d = new Date(t)
  const pad = function (n, w) { return String(n).padStart(w || 2, '0') }
  const stamp = pad(d.getFullYear(), 4) + pad(d.getMonth() + 1) + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    + '-' + pad(d.getMilliseconds(), 3)
  const rand = randomBytes(8).toString('hex')
  return stamp + '-' + rand + '.json'
}

// 仅供 test/ 单元测试使用：导出 v1.4.1 纯函数（不暴露运行时状态）
export const __clientLogHelpers = {
  redactClientLogText, redactClientLogValue, sanitizeClientLogString,
  normalizeClientLogRecord, pruneClientLogDir, clientLogRateCheck, clientLogFileName,
  writeClientLogFile, clientLogDir, clientLogRate,
  CLIENT_LOG_MAX_BODY_BYTES, CLIENT_LOG_MAX_ENTRIES, CLIENT_LOG_MAX_FILES,
  CLIENT_LOG_TOTAL_MAX_BYTES, CLIENT_LOG_RATE_LIMIT, CLIENT_LOG_RATE_WINDOW_MS,
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
  // v1.3.0：APK 分发大小上限（MB）。读文件前先 stat，超限直接 413。
  // 默认 200MB —— 足够任何正常安卓包；配 0 表示不限制（不建议）。
  const appApkMaxMB = Number.isFinite(config?.appApkMaxMB) && config.appApkMaxMB >= 0 ? config.appApkMaxMB : 200
  // v0.12.2 IP 漂移策略：'allow'（默认，方案 A）/ 'deny'（回到「IP 不匹配即拒」的旧行为）。
  // 默认必须是 allow —— 这正是本次安全模型变更的目的（移动网络换基站不再误杀）。
  // 'deny' 留给「某台机器想收紧」的场合，不用改代码即可切换。
  // 非法值一律回退 'allow'：写错了不该导致全部用户被踢。
  const ipDriftPolicy = config?.ipDriftPolicy === 'deny' ? 'deny' : 'allow'

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
    // v0.11.0：老会话惰性迁移回调。只在「IP 段匹配 + UA 设备类别可识别」时被调用，
    // 由 verifyFingerprint 内部判定（它已算好 ipOk / uaClassActual，避免两处重复判定而漂移）。
    // 迁移成功后该会话立即拥有 bindUaClass，下次走新分支，故这里是**一次性**的。
    // v0.12.4（审查 H1）：回调多带一个 uaHash —— 迁移不止写类别，还要把 bindUaHash
    // 刷新到当前 UA 并把旧哈希推进历史集合，保证迁移后**熵不降级**。
    const verdict = verifyFingerprint(req, session, fpWhitelist, fpIpBits, (sid0, uaClass, uaHash) => {
      const ok0 = sessionsStore.migrateUaClass(sid0, uaClass, uaHash)
      if (ok0) {
        try {
          appendAccessLog(config, {
            version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
            event: 'session-ua-class-migrated',
            sessionId: sid0,
            ip: bindIpOf(req),
            ua: headerOf(req, 'user-agent').slice(0, 120),
            uaClass, uaHash: uaHash || null, bindUaHashBefore: session.bindUaHash || null,
          })
        } catch {}
        ctx.logger?.info?.('[postapi-sec] legacy-ua-migrated sid=' + sid0.slice(0, 8) + ' uaClass=' + uaClass)
      }
      return ok0
    }, ipDriftPolicy)

    // v0.12.2：IP 漂移放行时留审计痕迹（**不吊销**）。
    // 位置刻意放在 `if (verdict.ok)` **之前**、且在主拒绝路径的 recordMismatch **之前**：
    //   ① 这是「放行了但要让人知道」的事件，不是拒绝事件；先记痕再走放行流程；
    //   ② ip-drift 的 verdict.ok 恒为 true，所以下面的 `if (verdict.ok)` 分支会正常放行，
    //      而 recordMismatch 只存在于 `if (verdict.ok)` 之后的拒绝路径里 —— 结构上
    //      ip-drift 永远走不到它（静态断言 13/13b 守这一点）。
    // reason 覆盖三种 ip-drift 变体（新会话漂移 / 老会话字节仍匹配漂移 / 老会话迁移且漂移）。
    // v0.12.4：把 ua-hash-drift（类别对、哈希未命中）也纳入留痕 —— 这是「看似正常但
    // 指纹其实不匹配」的信号，比 ip-drift 更值得关注（可能是同类型 UA 的盗用）。
    if (verdict.reason === 'ip-drift' || verdict.reason === 'legacy-migrated-ip-drift'
      || verdict.reason === 'ua-hash-drift') {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'session-ip-drift',
          reason: verdict.reason,
          sessionId: sid,
          expectPrefix: session.bindIpPrefix || null,
          actualIp: bindIpOf(req),
          actualPrefix: ipPrefixOf(bindIpOf(req), fpIpBits),
          ipBits: fpIpBits,
          uaOk: verdict.uaOk,
          uaHashOk: verdict.uaHashOk,
          uaClassExpected: verdict.uaClassExpected ?? null,
          uaClassActual: verdict.uaClassActual ?? null,
          ua: headerOf(req, 'user-agent').slice(0, 120),
          policy: ipDriftPolicy,
          // 说明：本事件表示「IP 变了但 UA 类别对得上，按方案 A 放行」。
          // 若同一 sessionId 短期内大量出现，值得人工关注（可能是 cookie 泄露）。
        })
      } catch {}
      ctx.logger?.info?.('[postapi-sec] ip-drift sid=' + sid.slice(0, 8)
        + ' expect=' + (session.bindIpPrefix || 'none') + ' actual=' + ipPrefixOf(bindIpOf(req), fpIpBits))
    }

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
    // fail-closed：拒绝路径。
    // ⚠️ v0.12.4 安全修复（审查 H2）：**只有真正「UA 类别不匹配」才计入 mismatchCount**。
    // 背景：deny 策略下「类别正确、仅 IP 漂移」此前返回 reason:'mismatch'，被这里当成
    // 真实失配累加 → 3 次即吊销 → 移动用户配了 deny 后当天被踢。
    // 现在 deny 场景用独立 reason 'ip-denied'，走「拒绝但只审计不计数」的分支。
    // 同理 'ua-hash-drift' 若因 deny 被拒，也不计数（它不是「有人在猜指纹」，
    // 而是「用户换了浏览器版本」或「同类型 UA 盗用」—— 后者靠审计告警，不靠自动吊销）。
    const isCountableMismatch = verdict.reason === 'mismatch' || verdict.reason === 'legacy'
    const outcome = isCountableMismatch
      ? sessionsStore.recordMismatch(sid, 3)
      : 'not-counted'
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION,
        ts: Date.now(),
        iso: new Date().toISOString(),
        event: verdict.reason === 'legacy' ? 'session-legacy-reject'
          : isCountableMismatch ? 'session-fingerprint-mismatch'
          : 'session-fingerprint-denied',
        outcome,
        sessionId: sid,
        ip: bindIpOf(req),
        xff: headerOf(req, 'x-forwarded-for'),
        ua: headerOf(req, 'user-agent').slice(0, 120),
        // —— 以下两项为既有字段，**保持原样**（append-only，勿删，避免破坏已有日志消费）
        expectPrefix: session.bindIpPrefix || null,
        expectUaHash: session.bindUaHash || null,
        // —— v0.11.0 新增：拆出「到底是 IP 还是 UA 失配」，此前只有笼统 outcome 只能猜。
        //   ipOk=false → 换网络/换出口；uaOk=false 且 ipOk=true → UA 漂移（老会话常见）。
        ipOk: verdict.ipOk,
        uaOk: verdict.uaOk,
        // UA 类别：老会话 uaClassExpected 为 null（未绑定过类别）；迁移相关时两者都有意义。
        uaClassExpected: verdict.uaClassExpected ?? null,
        uaClassActual: verdict.uaClassActual ?? null,
        bindUaClass: session.bindUaClass || null,
        ipBits: fpIpBits,
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
  // v1.7.9：日志路径改为「环境变量 > $DSH_HOME/logs > 本机既有路径」三级回退。
  //
  // 为什么需要：本函数从 DSH 启动日志里抓 launch token（mobile-login 后要拿它
  //   才不 401）。原实现把 /main/log/app/... 写死，换一台机器就失效。
  //   但也不能直接删 —— 那是本项目实际部署位置，删了当前实例就登录不了。
  //   ⇒ 先读环境变量（别人可覆盖），再用 $DSH_HOME/logs（标准位置），
  //     最后兜底到既有路径（保证本部署不变）。
  //
  // 用法：DSH_LOG_PATHS=/var/log/dsh/a.log,/var/log/dsh/b.log
  const DSH_LOG_CANDIDATES = (() => {
    const fromEnv = typeof process.env.DSH_LOG_PATHS === 'string'
      ? process.env.DSH_LOG_PATHS.split(',').map((s) => s.trim()).filter(Boolean)
      : []
    if (fromEnv.length > 0) return fromEnv
    const home = process.env.DSH_HOME
    const standard = home
      ? [join(home, 'logs', 'dsh-web.log'), join(home, 'logs', 'dsh-rescue.log')]
      : []
    // 本机既有路径放最后：它是兜底，不是首选（换机器时前两级会先命中）。
    return [...standard, '/main/log/app/dsh-web.log', '/main/log/app/dsh-rescue.log']
  })()
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
      // 已登录直通(20261021)：用户已持有有效会话时，访问 /login 直接进入使用页，
      // 不再重复展示登录表单。
      // 背景：DSH 0.2.x 起根路径 "/" 由宿主在更早的层直接返回 401 纯文本
      // ("dsh web authentication required")，本插件经 tapIndex 注入的前端跳转
      // 拿不到 HTML、已失效。故把 /login 作为稳定的认证入口：
      //   已登录 -> 302 回使用页；未登录 -> 正常渲染表单。
      // 校验复用 findSessionVerified（含指纹/过期/用户禁用检查，与全站鉴权同一口径），
      // 不用「cookie 是否存在」这种弱判断，避免伪造 cookie 被放行。
      const session = findSessionVerified(req)
      if (session) {
        try {
          appendAccessLog(config, {
            version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
            event: 'login-page-already-authenticated', ip: bindIpOf(req),
            ua: headerOf(req, 'user-agent').slice(0, 120),
          })
        } catch {}
        // 带最新启动 token 跳转，顺带补齐原生 BrowserAuth cookie（与登录成功后同一逻辑）
        const launchToken = resolveLatestLaunchToken()
        res.writeHead(302, { location: launchToken ? `/?token=${launchToken}` : '/' }).end()
        return
      }
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


  // ==================== v0.8.0 安卓客户端 JSON 登录 ====================
  /**
   * POST <apiPrefix>/mobile-login —— 机器可编程的登录入口（返回 JSON，不重定向）。
   *
   * 请求体：{ username, password, scheme?: 'http'|'https', host?: '期望的 authority' }
   * 成功 200：{ ok, username, role, launchUrl, sessionCookie:{name,value,maxAgeSeconds}, expiresAt }
   *
   * 为什么它「不需要 Bearer token」：
   *   它本身就是登录入口，若再要求网关 token，就等于「登录前必须先登录」——
   *   客户端拿不到任何凭据也就无从调用。安全性由另一条腿保证：**按 IP 限流**
   *   + 失败不透露具体原因（见下）。放行范围严格限定为「POST + 该子路径」，
   *   其它子路径与其它方法一律保持原有的 fail-closed 语义。
   *
   * 为什么失败不区分「用户不存在 / 密码错 / 账号被禁用」：
   *   任何区分都会变成**用户名枚举**的信道（攻击者可先确认哪些账号存在，
   *   再集中爆破）。故统一 401 'Invalid credentials'，与 checkCredential 的
   *   「三合一 undefined」口径一致。
   *
   * 为什么限流复用 stepupFails / stepupThrottled / stepupRecordFail：
   *   stepup 铸币口本来就是「密码换凭据」的同型攻击面，已有一套按 IP 计数的
   *   5 次锁 10 分钟机制（内存态、重启即清）。移动登录是新开的同类入口，
   *   再写一份计数器只会让两份阈值各自漂移；复用同一张表还能让「stepup 与
   *   mobile-login 的爆破尝试合并计数」，对攻击者更不利。
   *
   * 审计：成功 mobile-login-ok / 失败 mobile-login-failed / 限流 mobile-login-throttled。
   *   **绝不记录密码**，也不记录 sessionCookie 值（那是可直接冒用的凭据）。
   */
  const handleMobileLogin = async (req, res, sendJson) => {
    const throttleIp = bindIpOf(req)
    const ua = headerOf(req, 'user-agent').slice(0, 120)

    // ① 先限流，再解析请求体：被锁期间连密码校验都不做（省 CPU，也避免
    //    「响应耗时差异」泄露账号是否存在）。
    if (stepupThrottled(throttleIp)) {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'mobile-login-throttled', ip: throttleIp, ua,
        })
      } catch {}
      sendJson(res, 429, { ok: false, error: 'too many attempts, try later' })
      return
    }

    let body
    try {
      // 与其它机器接口同一读取口径；登录体很小，4KB 足够
      body = await readJson(req, 4096)
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' })
      return
    }
    if (!body || typeof body !== 'object') body = {}

    // ② 字段类型校验（明确的 400，便于客户端排查；不含任何凭据内容回报）
    for (const field of ['username', 'password']) {
      if (typeof body[field] !== 'string' || body[field].length === 0) {
        sendJson(res, 400, { ok: false, error: 'Missing required string field: ' + field })
        return
      }
    }

    // ③ 凭据校验：失败与「禁用」共用一条路径，不区分原因（防枚举）
    const user = checkCredential(body.username, body.password)
    if (!user) {
      stepupRecordFail(throttleIp)
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'mobile-login-failed', ip: throttleIp, ua,
          // 只记「尝试的用户名」，绝不记密码——用于排查「谁在猜谁的号」
          usernameAttempt: String(body.username).slice(0, 64),
        })
      } catch {}
      sendJson(res, 401, { ok: false, error: 'Invalid credentials' })
      return
    }

    // ④ 启动令牌：DSH 官方门禁只认 GET /?token=<token>，拿不到就无法铸造官方
    //    cookie，launchUrl 会退化成「登录后仍 401」。故此处 fail-closed 回 503。
    const launchToken = resolveLatestLaunchToken()
    if (typeof launchToken !== 'string' || launchToken.length === 0) {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'mobile-login-failed', ip: throttleIp, ua,
          reason: 'launch-token-unavailable', username: user.username,
        })
      } catch {}
      sendJson(res, 503, { ok: false, error: 'mobile login disabled: launch token unavailable (check dsh web log)' })
      return
    }

    // ⑤ authority / scheme：优先级 请求体 > 转发头 > Host > localhost。
    //    合法性校验失败一律 400 —— 这一段会拼进 launchUrl，不允许任何注入。
    const hostCandidate = (typeof body.host === 'string' && body.host.trim())
      ? body.host
      : (headerOf(req, 'x-forwarded-host') || headerOf(req, 'host') || 'localhost')
    const hostVerdict = normalizeAuthority(hostCandidate)
    if (!hostVerdict.ok) {
      // 非法 host 不属于「密码错」，不计入爆破失败数，但要在审计里留痕
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'mobile-login-failed', ip: throttleIp, ua,
          reason: 'invalid-host', username: user.username,
        })
      } catch {}
      sendJson(res, 400, { ok: false, error: 'Invalid field: host' })
      return
    }
    const schemeRaw = (typeof body.scheme === 'string' && body.scheme.trim())
      ? body.scheme
      : (headerOf(req, 'x-forwarded-proto') || '')
    const schemeVerdict = normalizeScheme(schemeRaw)
    if (!schemeVerdict.ok) {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'mobile-login-failed', ip: throttleIp, ua,
          reason: 'invalid-scheme', username: user.username,
        })
      } catch {}
      sendJson(res, 400, { ok: false, error: 'Invalid field: scheme' })
      return
    }

    // ⑥ 签发插件会话：绑定参数与 handleLogin 完全一致（同一条指纹口径），
    //    否则客户端带着这个 cookie 回来会被 verifyFingerprint 判失配。
    const sessionId = randomUUID()
    const session = sessionsStore.create(sessionId, user.username, user.role, maxAgeMs, {
      ipPrefix: ipPrefixOf(throttleIp, fpIpBits),
      uaClass: uaDeviceClass(headerOf(req, 'user-agent')),
      uaHash: uaHashOf(headerOf(req, 'user-agent')),
    })

    // ⑦ 返回给客户端的 cookie 值与 setSessionCookie 写入的完全同源（signSessionId），
    //    属性也保持一致（Path=/; SameSite=Lax；沿用现有行为，不加 HttpOnly——
    //    本插件的 tapIndex 脚本要靠 document.cookie 判断登录态）。
    const signedSession = signSessionId(sessionId, secret)
    const maxAgeSeconds = Math.floor(maxAgeMs / 1000)

    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: 'mobile-login-ok', ip: throttleIp, ua,
        username: user.username, role: user.role,
        sessionId,                       // sid（非签名值）
        host: hostVerdict.host, scheme: schemeVerdict.scheme,
        schemeVia: schemeVerdict.from,
      })
    } catch {}
    ctx.logger?.info?.('[postapi-sec] mobile-login ok user=' + user.username
      + ' ip=' + throttleIp + ' host=' + hostVerdict.host + ' scheme=' + schemeVerdict.scheme)

    sendJson(res, 200, {
      ok: true,
      username: user.username,
      role: user.role,
      launchUrl: schemeVerdict.scheme + '://' + hostVerdict.host + '/?token=' + launchToken,
      sessionCookie: { name: cookieName, value: signedSession, maxAgeSeconds },
      expiresAt: session.expiresAt,
    })
  }


  // ==================== v1.4.0 客户端日志免鉴权接收（/client-log） ====================
  /**
   * POST <apiPrefix>/client-log —— 客户端自动上报的日志落盘（免 cookie / 免 Bearer）。
   *
   * 为什么免鉴权：见文件上方「v1.4.0 客户端日志自动上报」段的说明 —— 手机 WebView 里
   *   没有插件会话 cookie，要求鉴权等于让用户永远传不上来。安全性靠五条限额（脱敏、
   *   256KB/次、20 次/时/IP、50 文件、50MB）+ 审计留痕保证，不靠凭据。
   *
   * 请求体（字段白名单，其余丢弃）：
   *   { source, kind, ua, env:{screen,dpr,deviceMemory,hardwareConcurrency,supports}, entries:[...] }
   *
   * 响应：
   *   200 { ok:true, stored:true, file:<文件名>, bytes, entries, truncated, pruned }
   *   400 非法 JSON；405 非 POST；413 超 256KB；429 频次超限；500 落盘失败（不抛给客户端细节）
   *
   * ⚠️ 读 body 必须用 readBody（边读边计数）而不是 readJson(req, max)：
   *   readJson 超限时直接 throw，我们拿不到“超限”与“非法 JSON”的区分，也来不及先回 413；
   *   这里读原文 → 判长度 → 再 JSON.parse，三段各自回自己的状态码。
   */
  // 可注入时钟：仅供 test/ 把"同一毫秒内的并发上报"这类场景做成**确定性**用例
  //（真实并发下 5 个请求会散落在相邻几毫秒，测不出"强制同毫秒撞名"这一条）。
  // 生产恒为 Date.now —— config.now 未提供时行为完全一致。
  // 注：变量名带 clientLog 前缀，避免与下方 v0.9.0 下载票据段的 nowFn 同名撞车。
  const clientLogNow = typeof config?.now === 'function' ? config.now : () => Date.now()

  const handleClientLog = async (req, res, sendJson) => {
    const ip = bindIpOf(req)
    const uaHeader = headerOf(req, 'user-agent').slice(0, 200)

    // ① 限流最先做：不消耗任何 IO，且被限时连 body 都不读（避免被大包拖住）
    const rate = clientLogRateCheck(ip)
    if (!rate.allowed) {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'client-log-throttled', ip, ua: uaHeader, limit: CLIENT_LOG_RATE_LIMIT,
          windowMs: CLIENT_LOG_RATE_WINDOW_MS, resetAt: rate.resetAt,
        })
      } catch {}
      sendJson(res, 429, { ok: false, error: 'too many uploads, try later' })
      return
    }

    // ② 读原始 body：超 256KB → 413（不把超限内容读进内存，readBody 会抛）
    let rawText
    try {
      rawText = await readBody(req, CLIENT_LOG_MAX_BODY_BYTES)
    } catch {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'client-log-rejected', reason: 'too-large', ip, ua: uaHeader,
          limitBytes: CLIENT_LOG_MAX_BODY_BYTES,
        })
      } catch {}
      sendJson(res, 413, { ok: false, error: 'payload too large (max ' + CLIENT_LOG_MAX_BODY_BYTES + ' bytes)' })
      return
    }
    const rawBytes = Buffer.byteLength(rawText)

    // ③ 解析
    let body
    try {
      body = rawText ? JSON.parse(rawText) : {}
    } catch {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'client-log-rejected', reason: 'bad-json', ip, ua: uaHeader, bytes: rawBytes,
        })
      } catch {}
      sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' })
      return
    }

    // ④ 白名单归一化 + 🔴 脱敏（均发生在写盘之前；normalizeClientLogRecord 内部
    //    对每个字符串字段调用 sanitizeClientLogString，即“脱敏后才落盘”）
    const record = normalizeClientLogRecord(body)
    const dir = clientLogDir(config)
    const fileName = clientLogFileName(ip, clientLogNow())
    const written = writeClientLogFile(dir, fileName, record)

    if (!written.ok) {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'client-log-write-failed', ip, ua: uaHeader, bytes: rawBytes,
          error: String(written.error || 'unknown').slice(0, 200),
        })
      } catch {}
      // 注意：这里**回 500**，客户端按“失败静默不重试”处理；不回 200 以免“以为写成功了”。
      sendJson(res, 500, { ok: false, error: 'storage unavailable' })
      return
    }

    // ⑤ 落盘后再清理：先写后清保证“最新一份一定在”（即使清理过程中进程被杀）。
    const pruned = pruneClientLogDir(dir)

    // ⑥ 审计：只记元信息，🔴 **绝不记日志内容本身**（内容已在文件里，且可能含用户文本）
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: 'client-log-received', ip, ua: uaHeader,
        source: record.source, kind: record.kind,
        bytes: rawBytes, storedBytes: written.bytes,
        entries: record.entries.length,
        receivedEntries: record.meta.receivedEntries,
        truncated: record.meta.truncated,
        file: fileName,
        prunedFiles: pruned.removed,
        usedInWindow: rate.used,
      })
    } catch {}
    ctx.logger?.info?.('[postapi-client-log] received ip=' + ip + ' kind=' + record.kind
      + ' entries=' + record.entries.length + ' bytes=' + rawBytes + ' file=' + fileName
      + (pruned.removed > 0 ? ' pruned=' + pruned.removed : ''))

    sendJson(res, 200, {
      ok: true,
      stored: true,
      file: fileName,
      bytes: written.bytes,
      entries: record.entries.length,
      truncated: record.meta.truncated,
      pruned: pruned.removed,
    })
  }


  // ==================== v0.9.0 交付物临时下载 ====================
  // 三项配置：非正数/非数字一律回退默认（配置写错不应让功能整体不可用）
  const downloadActivateHours = Number(config?.downloadActivateWindowHours) > 0
    ? Number(config.downloadActivateWindowHours) : FILE_TICKET_DEFAULT_ACTIVATE_HOURS
  const downloadSessionHours = Number(config?.downloadSessionHours) > 0
    ? Number(config.downloadSessionHours) : FILE_TICKET_DEFAULT_SESSION_HOURS
  const downloadMaxMB = Number(config?.downloadMaxMB) > 0
    ? Number(config.downloadMaxMB) : FILE_TICKET_DEFAULT_MAX_MB
  const downloadMaxBytes = Math.floor(downloadMaxMB * 1024 * 1024)
  // v1.5.0 直链票有效期（小时，默认 48）：**签发即起算**，不激活、不限次。
  // 与 downloadActivateWindowHours / downloadSessionHours 是两套独立语义
  // （那两项只服务 file-ticket，本项只服务 /dl/<token>）；
  // 故意不复用同一个配置键 —— 让「调了 file-ticket 的窗口却影响了直链」这种幻觉不可能发生。
  const dlTicketHours = Number(config?.dlTicketHours) > 0
    ? Number(config.dlTicketHours) : DL_TICKET_DEFAULT_HOURS
  // 可注入的时钟：仅供 test/ 驱动「48h / 5h」时间旅行，生产恒为 Date.now。
  // 之所以做成可注入而不是在代码里读全局 Date.now，是为了让时间相关逻辑可单测，
  // 不必真的 sleep 5 小时。config.now 未提供时完全走系统时钟。
  const nowFn = typeof config?.now === 'function' ? config.now : () => Date.now()
  // 票据状态库：与 access-log 同目录（$DSH_HOME/data/dsh-postapi-bridge/）
  const ticketStore = new FileTicketStore(auditDataDir(config), 'file-tickets.json')
  ticketStore.load()
  // 启动时清理一次（失败不影响启动：sweep 内部已 try/catch 落盘错误）
  try { ticketStore.cleanup(nowFn(), downloadActivateHours, downloadSessionHours, ctx.logger) } catch {}

  /**
   * 读取某会话中 seq 处 deliverables/presented 事件的第 index 个文件声明。
   *
   * 走官方公开服务 sessionQuery.readEvent（packages/session-query/session-query/src/index.ts:355）：
   * 它既能读「活会话」也能读「已持久化的历史会话」（内部 _corpus.load），
   * 正是官方 present-open 路由自己用的通道（packages/client/ui-deliverables/src/present-open.ts:79）。
   * 不自己解析 session 日志文件：事件存储格式属于宿主内部约定，插件侧复刻必然漂移。
   *
   * @returns {{ ok:true, file, session, event } | { ok:false, reason:'not-found'|'unavailable' }}
   */
  // ===== v0.11.1 下载能力启动自检 =====
  // 为什么需要：20261022 线上排查时「下载能不能用」只有真发一次请求才知道 ——
  // 如果宿主 profile 没装 session-query（本插件对它是可选依赖），download 会 503，
  // 但此前既不打日志也不影响插件加载，运维完全无感。
  // 这条日志在 apply 阶段就打出，让「能力是否就绪」在重启后第一眼可见。
  // 注意：只读探针，不改变任何行为；sessionQuery 缺失时下载端点仍是 503（fail-closed）。
  try {
    const sq = sessionQueryOf(ctx)
    const sessionQueryReady = Boolean(sq && typeof sq.readEvent === 'function')
    ctx.logger?.info?.('[postapi-download] ready: sessionQuery='
      + (sessionQueryReady ? 'available' : 'MISSING')
      + ' maxMB=' + downloadMaxMB
      + ' activateHours=' + downloadActivateHours
      + ' sessionHours=' + downloadSessionHours
      + ' dlHours=' + dlTicketHours
      + ' ticketStore=' + (typeof ticketStore?.persist === 'function' ? 'ok' : 'MISSING'))
    if (!sessionQueryReady) {
      ctx.logger?.warn?.('[postapi-download] sessionQuery 缺失：/file-ticket 与 /file/<token> 将返回 503；'
        + '该服务由 @deepseek-ai/dsh-session-query(-sqlite) 提供，需在 profile 中装配')
    }
  } catch (err) {
    // 自检本身绝不允许影响插件加载
    try { ctx.logger?.warn?.('[postapi-download] ready-check failed: ' + (err && err.message ? err.message : err)) } catch {}
  }

  /**
   * 读取单个 present 事件的**完整记录**（含 data）。
   *
   * 为什么需要：listEvents 只返回轻量记录（无 data），拿不到 files 载荷；
   * 必须再用 readEvent 按 seq 取一次完整事件。下载端点（readPresentedFile）与
   * 清单端点（handlePresentedList）共用这条路径，保证两边对「事件长什么样」的理解一致。
   *
   * @returns {{ok:true, event:object, cwd:string|undefined} | {ok:false, reason:string}}
   *   reason: 'unavailable'（服务未装配）/ 'event-unreadable'（单条读取失败）
   */
  const readPresentedEvent = async (sessionId, seq) => {
    const sq = sessionQueryOf(ctx)
    if (!sq || typeof sq.readEvent !== 'function') return { ok: false, reason: 'unavailable' }
    let window
    try {
      window = await sq.readEvent({ sessionId, seq, before: 0, after: 0 })
    } catch {
      return { ok: false, reason: 'event-unreadable' }
    }
    const event = window && window.target
    if (!event || !event.data || !Array.isArray(event.data.files)) {
      return { ok: false, reason: 'event-unreadable' }
    }
    const cwd = window && window.session && typeof window.session.cwd === 'string' ? window.session.cwd : undefined
    return { ok: true, event, cwd }
  }

  const readPresentedFile = async (sessionId, seq, index) => {
    // 每次现取（不在 apply 时缓存）：sessionQuery 可能晚于本插件激活，见 sessionQueryOf 注释
    const sq = sessionQueryOf(ctx)
    if (!sq || typeof sq.readEvent !== 'function') {
      // 宿主未装配 session-query（如精简 profile）→ 整个功能不可用，fail-closed
      return { ok: false, reason: 'unavailable' }
    }
    let window
    try {
      window = await sq.readEvent({ sessionId, seq, before: 0, after: 0 })
    } catch {
      // 会话不存在 / 该 seq 无事件 / 存储读取失败，统一按 not-found 处理（不区分，防探测）
      return { ok: false, reason: 'not-found' }
    }
    const target = window?.target
    if (!target || target.type !== 'deliverables/presented') return { ok: false, reason: 'not-found' }
    const files = target.data && Array.isArray(target.data.files) ? target.data.files : []
    const file = files[index]
    // 文件声明形状校验（与官方 isPresentedFile 口径一致：path 必须是非空字符串）
    if (!file || typeof file.path !== 'string' || file.path.trim().length === 0) {
      return { ok: false, reason: 'not-found' }
    }
    return { ok: true, file, session: window.session, event: target }
  }

  /**
   * 把 present 声明的（可能相对的）路径解析成真实绝对路径，并校验它落在会话 cwd 内。
   *
   * 为什么必须 realpath 而非字符串前缀：
   *   交付物路径来自模型输出，工作区内完全可以存在指向外部的符号链接
   *   （甚至模型自己就能建一个）。若用 resolvedPath.startsWith(cwd) 判断，
   *   /cwd/link -> /etc/passwd 会被判为「在工作区内」而放行，等于把任意文件读
   *   暴露给了下载接口。只有对**文件路径与 cwd 同时**做 realpath 再判归属
   *   （isRealpathInside）才能堵住这个洞。
   *
   * @returns {{ ok:true, absPath } | { ok:false, reason:'escape'|'missing'|'not-file' }}
   */
  const resolveSafeFilePath = (filePath, sessionCwd) => {
    if (typeof sessionCwd !== 'string' || sessionCwd.length === 0) return { ok: false, reason: 'missing' }
    // 相对路径按会话 cwd 解析（与官方 present 语义一致：PresentedFile.path 相对 Session cwd）
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(sessionCwd, filePath)
    // ⚠️ v1.5.0 归类修复：**先判存在性，再判归属**。
    //   isRealpathInside 对「路径不存在」（realpath ENOENT）与「路径在 cwd 之外」都返回 false，
    //   而调用方把 false 一律翻成 'escape'（403）。后果实测：文件被删除后，
    //   下载端点返回 **403 Forbidden** 而不是 404，/files 也把 skippedReasons 记成
    //   path-escape —— 用户看到的是「没权限」，实际只是文件没了，排查方向被彻底带偏。
    //   故这里先用 lstat 判存在：不存在 → 'missing'（404），存在再走 realpath 归属判定。
    //   安全性不变：lstat/realpath 对符号链接的判定仍由 isRealpathInside 完成，
    //   这一步只把「不存在」从「越权」里剥离出来。
    let lstat
    try { lstat = lstatSync(abs) } catch { return { ok: false, reason: 'missing' } }
    // 符号链接本身不直接拒：它可能指向 cwd 内的合法文件（如相对软链）。
    // 但归属判定必须基于**真实路径**（isRealpathInside 内部 realpath 双向比对），
    // 指向 cwd 之外的软链会在那一步被判为 escape。
    if (!isRealpathInside(abs, sessionCwd)) return { ok: false, reason: 'escape' }
    void lstat
    // realpath 之后再 stat：必须是一般文件；目录/设备/FIFO 一律拒绝（防「打开一个管道卡住」）
    let real
    try { real = realpathSync(abs) } catch { return { ok: false, reason: 'missing' } }
    let st
    try { st = statSync(real) } catch { return { ok: false, reason: 'missing' } }
    if (!st.isFile()) return { ok: false, reason: 'not-file' }
    return { ok: true, absPath: real, size: st.size }
  }

  /**
   * GET <apiPrefix>/files?sessionId=<sid> —— 会话内交付物清单（元数据，**不签发票据**）。
   *
   * ⚠️ query 参数是 **sessionId**。注意：`sid` 是宿主网关的保留参数名（会用被拦成空白 400），
   *   千万别图省事改成 sid —— 详见 handler 内的实测判据注释。
   *
   * ⚠️ v0.12.3：对外路径是 /files（原 /presented 与宿主 present.open 路由冲突被劫持）。
   *    函数名 handlePresentedList 保留不改（内部命名，不影响对外契约）。
   *
   * 为什么需要这个接口：官方 deliverables 文件卡片在本环境不渲染，前端无法从官方数据源
   * 拿交付物列表。改为本插件自渲染后，前端需要一份「这个会话有哪些交付物」的清单。
   *
   * 为什么不直接返回下载地址：保持「48h 待激活 + 首下起 5h」票据规则不变 ——
   * 列表只给元数据，用户真点下载时才走 file-ticket 签票，票据生命周期语义零改动。
   *
   * 数据源：sessionQuery.listEvents（官方公开接口，冷读/活读都支持）。
   * 校验：与下载端点同口径（realpath 归属 cwd、普通文件、≤ downloadMaxMB）。
   *   **单条不合格只跳过该条**并在 skippedReasons 里记原因，不让整张列表失败。
   */
  // v0.12.1：session 由调用方（handleApiBridge 的人类通道分流）传入。
  // **不要在这里再调 findSessionVerified** —— 二次校验会再跑一遍指纹比对，
  // 若恰好不匹配就会给 mismatch 计数 +1，3 次即吊销会话（正常用户会被莫名踢掉）。
  // 保留 verifySession 兜底参数是为了直接调用（测试/未来新调用点）仍安全。
  const handlePresentedList = async (req, res, sendJson, verifiedSession) => {
    const session = verifiedSession || findSessionVerified(req)
    if (!session) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: login required' })
      return
    }
    // ⚠️ query 参数用 **sessionId**。
    //
    // 【v1.0.1 更正】v1.0.0 曾把参数改成 `sid`，那是**错的** —— 真正被宿主 API 网关保留的
    // 名字是 `sid`，不是 `sessionId`。已改回 sessionId。
    //
    // 实测判据（20261022，v1.0.0 线上，同一条路径只换参数名，值均为真实会话 ID）：
    //   无参数               → 400 size=56  Missing required query param: sid   ✅ 进了 handler
    //   ?sid=<真实ID>        → 400 size=0                                        ❌ 没进 handler
    //   ?sessionId=<真实ID>  → 400 size=56  Missing required query param: sid   ✅ 进了 handler
    //   ?session=<真实ID>    → 400 size=56                                       ✅
    //   ?session_id=<真实ID> → 400 size=56                                       ✅
    //   ?id=<真实ID>         → 400 size=56                                       ✅
    //   ?q=<真实ID>          → 400 size=56                                       ✅
    //
    // **决定性判据**：在 handler 入口加临时诊断日志，`?sid=` 时**零输出**（请求根本没进来）；
    // 其它参数名都有输出。⇒ `sid` 是宿主网关的保留参数名（网关拿它做自己的会话解析，
    // 值不认识就直接返回空白 400），`sessionId` 不是保留名。
    //
    // 【为什么 v1.0.0 会判反】当时看到 `?sessionId=x → 400 size=0`，但那是 v0.12.x 时代：
    // 那时 handler 用的正是 sessionId，请求**进了** handler，是内部 `listEvents` 抛异常导致
    // 空响应 —— 与「被网关拦截」是两码事。把两个时期、两种原因的现象混在了一起。
    // 这个内部异常已在 v1.0.1 一并查清（见 handlePresentedList 内注释）。
    //
    // 另注：POST /file-ticket 的 **body** 里也用 sessionId 字段 —— body 不是 query，
    // 与本次改动无关，保持原样（两条路径字段名因此一致，反而更不容易搞混）。
    const sessionId = queryOf(req, 'sessionId')
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: 'Missing required query param: sessionId' })
      return
    }
    // sessionQuery 缺失 → 503，与下载端点同口径（fail-closed，不假装成空列表）
    // v1.0.2：必须用 ctx.get() 安全探测 —— 直接读服务属性会 throw（见 sessionQueryOf 注释）
    const sq = sessionQueryOf(ctx)
    if (!sq || typeof sq.listEvents !== 'function') {
      sendJson(res, 503, { ok: false, error: 'files list disabled: session query service unavailable' })
      return
    }

    let records
    try {
      records = await sq.listEvents(sessionId)
    } catch {
      // 会话不存在 / 存储读取失败 → 统一 404（不区分，防探测会话是否存在）
      sendJson(res, 404, { ok: false, error: 'session not found' })
      return
    }
    if (!Array.isArray(records)) {
      sendJson(res, 404, { ok: false, error: 'session not found' })
      return
    }

    // 取会话 cwd：listEvents 的记录不含这些信息，cwd 只能从 readEvent 的
    // window.session.cwd 拿（与下载端点 readPresentedFile 同源）。
    // 由于下面本来就要逐个 readEvent 取 data，cwd 顺带从第一个成功的事件里取，
    // 不再单独多发一次探针请求。
    // v1.0.3：pickPresentedEvents 现在只返回 {seq,type,time}（listEvents 无 data）。
    // 真正的 files 载荷必须逐个 readEvent 取 —— 见 readPresentedEvent 注释。
    const eventRefs = pickPresentedEvents(records)

    // 逐个取完整事件。**单条失败只跳过该条**（与「单文件不合格只跳过」同一原则），
    // 不让一个坏事件把整张清单打空。并行发起减少往返（readEvent 之间互不依赖）。
    const unreadable = { count: 0 }
    const settled = await Promise.all(eventRefs.map((ref) => readPresentedEvent(sessionId, ref.seq)))
    const events0 = []
    let headCwd
    for (const r of settled) {
      if (!r.ok) { unreadable.count++; continue }
      events0.push(r.event)
      if (headCwd === undefined && typeof r.cwd === 'string') headCwd = r.cwd
    }
    if (events0.length === 0) {
      // 会话存在但没有任何交付物：正常空列表（不是错误）
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'files-list', ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
          uid: session.username, sid: sessionId, events: 0, candidates: 0, files: 0,
          skipped: unreadable.count,
          skippedReasons: unreadable.count ? { 'event-unreadable': unreadable.count } : {},
        })
      } catch {}
      sendJson(res, 200, {
        ok: true, sessionId, files: [], skipped: unreadable.count,
        skippedReasons: unreadable.count ? { 'event-unreadable': unreadable.count } : {},
      })
      return
    }
    // ⚠️ v0.12.4（审查 M6）：这里是「cwd 必须存在」，**不是**会话归属校验。
    // 历史上注释写成「非 admin 必须通过会话 cwd 归属判断」，与实现不符（实现只判非空）。
    // 已改为如实描述：cwd 是后续 resolveSafeFilePath 做路径归属校验的前提，缺了就 fail-closed；
    // 真正的「会话属于谁」由宿主 sessionQuery 的可见性负责（见 file-ticket 处同样说明）。
    // 不按 role 区分：admin 与非 admin 在这一点上行为一致（admin 也没有额外的归属信息可用）。
    if (!headCwd) {
      sendJson(res, 403, { ok: false, error: 'Forbidden: session workspace unavailable' })
      return
    }

    const events = events0
    const candidates = flattenPresentedFiles(events)
    const files = []
    const skippedReasons = {}
    const bump = (reason) => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1 }
    // v1.0.3：readEvent 失败的 present 事件计入 skippedReasons（不整批失败）
    if (unreadable.count > 0) { for (let i = 0; i < unreadable.count; i++) bump('event-unreadable') }

    // v1.5.0：清单现在就给**可直接点的下载地址**（dl 直链票）。
    // 为什么清单要签票（与原设计「清单只给元数据、点下载才签票」不同）：
    //   用户的核心诉求是「卡片点击 = 直接下载」。直链必须**在渲染卡片时就已经存在**，
    //   否则又回到「点击 → 发请求换地址」的老路（官方卡片正是那样点了没反应）。
    //   代价是清单不再「零票据」，但 dl 票是**无状态**的（exp 写在 token 里）：
    //   不写磁盘、不建索引、没有可增长的票据库，一次列表只多几次 HMAC 计算。
    // ⚠️ 同一轮请求内用**同一个 issuedAt**：一次清单里的所有直链同时过期，
    //    用户看到的是「这批一起失效」，而不是互相差几毫秒。
    const dlIssuedAt = nowFn()
    for (const cand of candidates) {
      // 路径安全与文件校验：与下载端点共用 resolveSafeFilePath（realpath 双向比对）
      const safe = resolveSafeFilePath(cand.path, headCwd)
      if (!safe.ok) { bump('path-' + safe.reason); continue }
      if (safe.size > downloadMaxBytes) { bump('too-large'); continue }
      // 直链票：绑定**当前会话用户**（session.username），下载时二次比对 uid。
      // 这里用 session.username 而非任何客户端传入的值 —— 用户身份只来自已验签的会话。
      const dl = issueDownloadTicket({
        sid: sessionId,
        seq: cand.seq,
        index: cand.index,
        uid: session.username,
        hours: dlTicketHours,
        now: dlIssuedAt,
        secret,
        apiPrefix,
      })
      // 签发失败（无签名密钥等）→ **该条不跳过**，只是不带 downloadUrl：
      // 文件本身可用（ticketUrl 仍在），跳过会让用户以为文件没了。
      if (!dl.ok && dl.error !== 'no-secret') { bump('dl-' + dl.error) }
      files.push({
        seq: cand.seq,
        index: cand.index,
        turn: cand.turn,
        time: cand.time,
        // path：**绝对路径**（已 realpath）。前端只用来显示/去重，不参与任何文件操作。
        path: safe.absPath,
        name: basename(safe.absPath),
        description: cand.description,
        size: safe.size,
        // v1.5.0：直链（卡片 href）。**不含任何 POST 步骤，点击即浏览器原生下载**。
        // 缺失时前端会静默不渲染卡片（见 lib/client.js 的 TurnDeliverablesLinks）。
        downloadUrl: dl.ok ? dl.url : null,
        downloadExpiresAt: dl.ok ? dl.expiresAt : null,
        // ticketUrl 保留（兼容旧前端）：只是端点地址，不含令牌
        ticketUrl: apiPrefix + '/file-ticket',
      })
    }

    const skipped = candidates.length - files.length
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: 'files-list',
        ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
        uid: session.username, sid: sessionId,
        events: events.length, candidates: candidates.length,
        files: files.length, skipped, skippedReasons,
        // 注意：清单不含任何 token/票据，故无需脱敏；但仍不记录文件内容
      })
    } catch {}

    sendJson(res, 200, {
      ok: true,
      sessionId,
      files,
      // skipped 与原因摘要放在顶层，便于前端/运维判断「列表是不是被裁剪过」
      skipped,
      skippedReasons,
    })
  }

  // ==================== v1.3.0 App 在线更新（分发两个端点） ====================
  //
  // 用途：安卓 App 需要在线更新。用户已排除 npm / 会话 present / 独立文件服务器，
  //   最终选定「数据目录放文件 + 本插件只读分发」：
  //     $DSH_HOME/data/dsh-postapi-bridge/app/app-latest.apk
  //     $DSH_HOME/data/dsh-postapi-bridge/app/app-version.json
  //
  // 🔴 安全设计（三条硬约束，改动时不许放宽）：
  //   ① **路径固定**：文件名是编译期常量，不接受任何用户输入参与拼接；
  //   ② **realpath 校验**：解析出的真实路径必须仍在 appDistDir 内 —— 防止 app 目录
  //      被 symlink 到别处时读到任意文件（只做字符串前缀判断是不够的）；
  //   ③ **不列目录**：只能取两个固定名字，任何其它路径一律 404。
  //
  // 鉴权：与 /files 同属「人类通道」（会话 cookie），不放公网脚本。
  //   鉴权本身由 handleApiBridge 的人类通道分流统一完成，这里收到的已经是校验过的会话。

  /**
   * 把「读取分发目录里的固定文件」这件事收口到一处。
   * 返回 { ok:true, real, stat } 或 { ok:false, reason, status }。
   *
   * reason 取值：
   *   'not-configured' —— 目录或文件不存在（503，fail-closed：不假装有内容）
   *   'escape'         —— realpath 落在 appDistDir 之外（403，可能是 symlink 攻击）
   *   'not-file'       —— 存在但不是普通文件（404）
   *   'too-large'      —— 超过 appApkMaxMB（413）
   */
  const resolveAppFile = (config, name, maxBytes) => {
    const dir = appDistDir(config)
    const target = join(dir, name)
    let real, dirReal
    try {
      real = realpathSync(target)
      dirReal = realpathSync(dir)
    } catch {
      // 目录或文件不存在 —— 分发未配置
      return { ok: false, reason: 'not-configured', status: 503 }
    }
    // ② realpath 归属校验：真实路径必须仍在分发目录内。
    //    用 path.relative 而非 startsWith —— 后者会把 /a/app-evil 当成 /a/app 的子路径。
    const rel = relative(dirReal, real)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, reason: 'escape', status: 403 }
    }
    let st
    try { st = statSync(real) } catch { return { ok: false, reason: 'not-configured', status: 503 } }
    if (!st.isFile()) return { ok: false, reason: 'not-file', status: 404 }
    // ③ 大小上限：读之前先 stat，避免把一个巨型文件读进内存
    if (maxBytes > 0 && st.size > maxBytes) return { ok: false, reason: 'too-large', status: 413, size: st.size }
    return { ok: true, real, stat: st }
  }

  /**
   * GET <apiPrefix>/app-version —— 返回最新 App 版本信息。
   *
   * 语义：
   *   · 没有 app-version.json → **503**（fail-closed，不返回假数据）；
   *   · JSON 非法 / 缺必填字段 → **503** + 明确原因；
   *   · 正常 → 200 + { version, code, notes, publishedAt, size, sha256, filename, url }。
   *
   * 为什么 503 而不是 404：404 会让客户端以为「地址错了」，
   *   而这里表达的是「服务端还没配置分发」，语义不同。
   */
  const handleAppVersion = (req, res, sendJson, verifiedSession) => {
    const session = verifiedSession || findSessionVerified(req)
    if (!session) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: login required' })
      return
    }
    const denied = (status, error, reason) => {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'app-version', outcome: 'deny', reason, status,
          uid: session.username, ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
        })
      } catch {}
      sendJson(res, status, { ok: false, error })
    }

    const found = resolveAppFile(config, APP_VERSION_NAME, 0)   // 版本文件很小，不设上限
    if (!found.ok) {
      if (found.reason === 'not-configured') return denied(503, 'app distribution not configured', found.reason)
      if (found.reason === 'escape') return denied(403, 'Forbidden: app dist path escapes', found.reason)
      return denied(404, 'app version not found', found.reason)
    }

    let raw
    // 注意：readFileSync 在本文件里以别名 _readFileSync 导入（见文件头部 import），用别名。
    try { raw = _readFileSync(found.real, 'utf8') } catch { return denied(503, 'app version unreadable', 'unreadable') }
    let meta
    try { meta = JSON.parse(raw) } catch { return denied(503, 'app version malformed: invalid JSON', 'invalid-json') }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return denied(503, 'app version malformed: not an object', 'invalid-shape')
    }
    // 必填字段：version（字符串）与 code（整数）。其余可选但会透传。
    if (typeof meta.version !== 'string' || meta.version.length === 0) {
      return denied(503, 'app version malformed: missing version', 'missing-version')
    }
    if (!Number.isSafeInteger(meta.code)) {
      return denied(503, 'app version malformed: missing code', 'missing-code')
    }

    // APK 是否真的就位 —— 版本信息说有，但文件没了时要让客户端知道（否则点了下载才 404）
    const apk = resolveAppFile(config, APP_APK_NAME, 0)
    const apkReady = apk.ok

    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: 'app-version', outcome: 'ok',
        uid: session.username, ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
        appVersion: meta.version, appCode: meta.code, apkReady,
      })
    } catch {}

    sendJson(res, 200, {
      ok: true,
      version: meta.version,
      code: meta.code,
      notes: typeof meta.notes === 'string' ? meta.notes : '',
      publishedAt: Number.isSafeInteger(meta.publishedAt) ? meta.publishedAt : null,
      size: apkReady ? apk.stat.size : (Number.isSafeInteger(meta.size) ? meta.size : null),
      sha256: typeof meta.sha256 === 'string' ? meta.sha256 : null,
      filename: typeof meta.filename === 'string' ? meta.filename : (meta.version + '.apk'),
      // 相对路径：客户端按自己的 baseUrl 拼接，避免把 host 写死
      url: apiPrefix + '/app-latest.apk',
      // 额外提示：版本信息存在但 APK 缺失时，客户端可据此提示运维
      apkReady,
    })
  }

  /**
   * GET <apiPrefix>/app-latest.apk —— 直接流式返回 APK。
   *
   * 与 /file/<token> 的区别：
   *   · **不走 file-ticket**：这是公开分发，不需要 48h 待激活 / 5h 窗口那套时效；
   *   · 鉴权仍走人类通道（会话 cookie），认证逻辑由上游分流完成。
   *
   * Range 复用 parseRangeHeader（与 /file/<token> 同一份实现，不另写一套）——
   *   安卓下载器普遍会发 Range 做断点续传，必须支持。
   */
  const handleAppApk = async (req, res, verifiedSession) => {
    const session = verifiedSession || findSessionVerified(req)
    if (!session) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized: login required' }))
      return
    }
    const maxBytes = appApkMaxMB * 1024 * 1024
    const found = resolveAppFile(config, APP_APK_NAME, maxBytes)
    const record = (outcome, extra) => {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'app-download', outcome,
          uid: session.username, ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
          ...extra,
        })
      } catch {}
    }
    if (!found.ok) {
      record('deny', { reason: found.reason })
      const map = {
        'not-configured': [404, 'app not found'],
        'not-file': [404, 'app not found'],
        'escape': [403, 'Forbidden'],
        'too-large': [413, 'app exceeds size limit'],
      }
      const [status, error] = map[found.reason] || [500, 'app unavailable']
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error }))
      return
    }

    const size = found.stat.size
    const mtime = found.stat.mtime
    // 文件名给客户端看：优先用 version.json 里的 filename（可含中文），否则用固定名。
    // ⚠️ 只影响 Content-Disposition，**不参与任何路径拼接**（安全要求 ①）。
    let displayName = APP_APK_NAME
    try {
      const metaRaw = _readFileSync(join(appDistDir(config), APP_VERSION_NAME), 'utf8')
      const m = JSON.parse(metaRaw)
      if (m && typeof m.filename === 'string' && m.filename.length > 0 && m.filename.length < 200) {
        displayName = m.filename
      }
    } catch {}

    const baseHeaders = {
      'content-type': 'application/vnd.android.package-archive',
      // RFC5987：filename* 用 UTF-8 百分号编码，中文文件名不会乱码
      'content-disposition': "attachment; filename*=UTF-8''" + rfc5987Encode(displayName),
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'last-modified': new Date(mtime).toUTCString(),
    }

    const range = parseRangeHeader(headerOf(req, 'range'), size)
    if (range && range.unsatisfiable) {
      record('deny', { reason: 'range-unsatisfiable', size })
      res.writeHead(416, { ...baseHeaders, 'content-range': 'bytes */' + size })
      res.end()
      return
    }
    const useRange = range && !range.ignore && Number.isSafeInteger(range.start)
    const start = useRange ? range.start : 0
    const end = useRange ? range.end : size - 1
    const chunkSize = size === 0 ? 0 : end - start + 1

    const headers = { ...baseHeaders, 'content-length': String(chunkSize) }
    if (useRange) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size
    record('ok', { size, range: useRange ? (start + '-' + end) : null })
    res.writeHead(useRange ? 206 : 200, headers)
    if (chunkSize === 0) { res.end(); return }

    await new Promise((resolve) => {
      const stream = createReadStream(found.real, { start, end })
      stream.on('error', () => { try { res.destroy() } catch {} resolve() })
      stream.on('end', resolve)
      stream.pipe(res)
    })
  }



  /**
   * POST <apiPrefix>/file-ticket —— 为一条 present 记录签发临时下载地址。
   *
   * 鉴权：必须已登录（findSessionVerified，与全站同一口径：签名 + 指纹 + 用户启用）。
   * 本端点**不受**机器通道 Bearer 豁免影响，调用方在 handleApiBridge 内、token 校验之后。
   */
  // 注意：body 由 handleApiBridge 统一解析后传入（Request 是可读流，只能消费一次；
  // 若在此处再 readJson 会读到空串 → 全部字段判缺失）。
  // v0.12.1：session 由人类通道分流传入（理由同 handlePresentedList）。
  const handleFileTicket = async (req, res, sendJson, body, verifiedSession) => {
    const session = verifiedSession || findSessionVerified(req)
    if (!session) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: login required' })
      return
    }
    if (!body || typeof body !== 'object') body = {}
    const { sessionId, seq, index } = body
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      sendJson(res, 400, { ok: false, error: 'Missing required string field: sessionId' })
      return
    }
    if (!Number.isSafeInteger(seq) || seq < 0) {
      sendJson(res, 400, { ok: false, error: 'Missing required integer field: seq' })
      return
    }
    if (!Number.isSafeInteger(index) || index < 0) {
      sendJson(res, 400, { ok: false, error: 'Missing required integer field: index' })
      return
    }

    const found = await readPresentedFile(sessionId, seq, index)
    if (!found.ok) {
      const status = found.reason === 'unavailable' ? 503 : 404
      sendJson(res, status, {
        ok: false,
        error: found.reason === 'unavailable'
          ? 'file download disabled: session query service unavailable'
          : 'presented file not found',
      })
      return
    }

    const filePath = found.file.path
    const cwd = found.session?.cwd
    // ⚠️ v0.12.4（审查 M6）：这里**没有**会话归属校验，如实说明。
    //
    // 历史上这里写过 `isRealpathInside(cwd, cwd)` —— 两个参数相同，恒为 true，
    // 只等价于「cwd 存在且可 realpath」，**没有任何归属判断**。但它看起来像一道防线，
    // 后人会信任它，这比没有检查更危险（假防护 > 无防护）。故删除并如实记录。
    //
    // 当前实际的安全前提：
    //   ① 必须已登录（findSessionVerified）；
    //   ② 宿主 sessionQuery 自己的会话可见性/隔离（本插件不重复实现，也不假设其强度）；
    //   ③ 文件路径必须落在该会话 cwd 之内（resolveSafeFilePath 的 realpath 双向比对）。
    // 即：**能登录的人可以为自己能读到的任意会话签发票据**。若将来需要严格的
    // 「会话属于该用户」判定，得由宿主 sessionQuery 暴露会话 owner，或本插件自行
    // 维护 sessionId→username 映射 —— 届时再补，不在此处留假的检查。
    if (!cwd) {
      // cwd 缺失 → 无法做后续的路径归属校验，直接拒绝（fail-closed）
      sendJson(res, 403, { ok: false, error: 'Forbidden: session workspace unavailable' })
      return
    }

    const safe = resolveSafeFilePath(filePath, cwd)
    if (!safe.ok) {
      const status = safe.reason === 'escape' ? 403 : 404
      sendJson(res, status, {
        ok: false,
        error: safe.reason === 'escape' ? 'Forbidden: path escapes session workspace' : 'presented file unavailable',
      })
      return
    }
    if (safe.size > downloadMaxBytes) {
      sendJson(res, 413, { ok: false, error: 'file too large: ' + safe.size + ' > ' + downloadMaxBytes })
      return
    }

    // 签发：生成 ticketId，并把「票据状态」写进服务端库。
    // 注意 exp **不在** token 里 —— 签发时还不知道激活时刻（见文件头说明）。
    // 这里记的 issuedAt 是「签发票据的时刻」（用户主动申请的那一下），
    // 48h 等待期从这里起算：文件是会话里已有的，用户随时可以再申请一张新票。
    const issuedAt = nowFn()
    const tid = newTicketId()
    // 惰性清理：每次签发顺带扫一遍，避免票据库无限增长（不需要额外定时器）
    try { ticketStore.cleanup(issuedAt, downloadActivateHours, downloadSessionHours, ctx.logger) } catch {}
    ticketStore.put(tid, {
      sid: sessionId, seq, index, uid: session.username,
      issuedAt, activatedAt: null,
    })
    if (!ticketStore.persist(ctx.logger)) {
      // 落盘失败 → 票据无法被后续请求查到，直接失败比发一张「注定 410」的票更诚实
      sendJson(res, 503, { ok: false, error: 'file download disabled: ticket store unavailable' })
      return
    }
    const payload = { v: FILE_TICKET_VERSION, tid, sid: sessionId, seq, index, uid: session.username }
    const signed = signFileTicket(payload, secret)
    if (!signed.token) {
      ticketStore.delete(tid)
      ticketStore.persist(ctx.logger)
      sendJson(res, 503, { ok: false, error: 'file download disabled: no signing secret' })
      return
    }
    const filename = basename(safe.absPath)
    // 对外返回的 expiresAt 是「待激活」的截止时刻（48h）。真正的下载窗口要等首次下载才确定，
    // 客户端据此知道这张票最晚什么时候必须开始用。
    const pendingDeadline = issuedAt + downloadActivateHours * 3600 * 1000
    try {
      appendAccessLog(config, {
        version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
        event: 'file-ticket-issued',
        ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
        // 记 ticketId（可安全排查），但绝不记 token 本身（token 才是可用凭据）
        uid: session.username, tid, sid: sessionId, seq, index,
        filename, size: safe.size, issuedAt, pendingDeadline,
      })
    } catch {}
    sendJson(res, 200, {
      ok: true,
      url: apiPrefix + '/file/' + signed.token,
      // ⚠️ 故意**不返回 ticketId**：它是服务端状态库的键，属于内部实现细节。
      // 暴露它会让攻击者能构造请求去探测「某张票是否存在」，也会把内部键空间
      // 变成对外契约（将来换 key 方案即为破坏性变更）。客户端只需要 url。
      issuedAt,
      // 待激活截止 = issuedAt + activateWindowHours：必须在此刻**之前**发起第一次下载。
      activateDeadline: pendingDeadline,
      // ⚠️ 歧义字段，仅为向后兼容保留：
      //   expiresAt 的真实语义是「**待激活**截止时刻」，不是「下载有效期」。
      //   真正的下载有效期 = 首次下载时刻(activatedAt) + sessionHours，签发时无法预知。
      //   新客户端请读 activateDeadline / sessionHours，忽略 expiresAt。
      //   待下一个大版本（0.10.x）移除该字段。
      expiresAt: pendingDeadline,
      activateWindowHours: downloadActivateHours,
      sessionHours: downloadSessionHours,
      filename,
      size: safe.size,
    })
  }

  /**
   * GET <apiPrefix>/file/<token> —— 按 ticket 流式下载。
   *
   * 校验顺序严格 fail-closed（**顺序本身是安全语义**，见每步注释）：
   *   1 解析结构 → 403（连签名段都解析不出，直接拒，不进入任何 IO）
   *   2 验签 → 403（伪造/篡改；timingSafeEqual）
   *   3 查票据状态 → 不存在则 410（已清理/从未存在，语义上就是过期）
   *   4 未激活：超 48h → 410；否则**当场激活并立即落盘**（必须在读文件之前）
   *   5 已激活：超 activatedAt + windowHours → 410
   *   6 登录态 → 401（先于「是不是本人」，防未登录探测 uid 有效性）
   *   7 uid 一致 → 403
   *   8 present 记录 → 404
   *   9 realpath 归属 → 403
   *  10 大小上限 → 413
   *
   * 为什么激活要早于鉴权：激活代表「这张票被使用了」，是票据自身的生命周期事件，
   * 与「谁在用」无关。若等鉴权通过才激活，攻击者用一个未登录请求就能无限延长
   * 「待激活」票据的 48h 计时（每次都推后），反而拖长票据存活期。
   * 也因此：未登录请求确实会消耗掉一次激活机会 —— 这是有意取舍，票据本就该
   * 只能由持票人使用，泄露给别人的票被激活后，原主仍能在 5h 内使用（窗口共享）。
   *
   * 次数语义：激活后 5h 内**不限次数**（Range 续传、重复请求都允许），
   * 因此这里不做任何「已下载过就拒绝」的判断；唯一的终止条件是时间窗。
   */
  // v0.12.1：session 由人类通道分流传入，避免二次指纹比对（理由同 handlePresentedList）。
  const handleFileDownload = async (req, res, token, verifiedSession) => {
    const deny = (status, reason, extra) => {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'file-download-denied', reason, status,
          ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
          ...extra,
        })
      } catch {}
      const msg = status === 410 ? 'link expired' : 'Forbidden'
      sendJson(res, status, { ok: false, error: msg })
    }

    // 1. 结构
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
      deny(403, 'structure')
      return
    }
    // 2. 验签
    const verdict = verifyFileTicket(token, secret)
    if (!verdict.ok) {
      deny(403, verdict.reason)
      return
    }
    const { tid, sid, seq, index, uid } = verdict.payload
    const now = nowFn()

    // 3. 票据状态（不存在 = 已被清理或从未存在 → 410）
    const ticket = ticketStore.get(tid)
    if (!ticket) {
      deny(410, 'ticket-missing', { tid, sid, seq, index })
      return
    }
    // 令牌与状态必须指向同一坐标（防「用 A 票的 token 配 B 票的状态」，虽然签名已保证，
    // 但状态库是外部文件、可能被运维手工改过，这里做一次一致性校验）
    if (ticket.sid !== sid || ticket.seq !== seq || ticket.index !== index || ticket.uid !== uid) {
      deny(403, 'ticket-mismatch', { tid })
      return
    }

    // 4/5. 生命周期判定 + 首次激活
    const state = ticketStateOf(ticket, now, downloadActivateHours, downloadSessionHours)

    if (state.state === 'expired') {
      deny(410, state.reason, { tid, sid, seq, index })
      return
    }
    if (state.state === 'pending') {
      // 【为什么激活要早于鉴权】激活是票据自身的生命周期事件，与「谁在用」无关。
      // 若把激活挪到鉴权之后，未登录探测就能反复刷新 48h 计时 —— 攻击者在第 47h59m
      // 匿名探一下就能把票的等待期再续下去，票据永远不过期。
      // 现在「第一次被访问即激活」把票据生命周期**锁死在首次访问那一刻**，
      // 这正是我们要的正确性保证，而不是缺陷：
      //   · 泄露出去的票被别人先激活 → 原主仍能在同一 5h 窗口内使用（窗口共享，不额外损失）；
      //   · 但它绝不会因此获得额外的 48h 延期。
      //
      // 并发说明（显式依赖运行时模型）：Node 是单线程，且本段**没有任何 await**，
      // 所以「判空 → 赋值 → 落盘」三步之间不会插入另一个请求的处理。
      // 若某个请求先到，另一请求在此处读到的 activatedAt 就不是 null，直接沿用，
      // **绝不覆盖** —— 满足「只允许一次激活、以第一次写入为准」。
      // ⚠️ 若将来把这条写路径改成异步（await 落盘），必须重新引入互斥。
      if (ticket.activatedAt === null || ticket.activatedAt === undefined) {
        ticket.activatedAt = now
        ticketStore.put(tid, ticket)
        // 立即落盘：激活代表「票已开始使用」，进程崩溃后不该退回未激活（否则等于白送 48h）
        ticketStore.persist(ctx.logger)
        try {
          appendAccessLog(config, {
            version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
            event: 'file-ticket-activated',
            ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
            tid, sid, seq, index, uid,
            issuedAt: ticket.issuedAt, activatedAt: now,
            sessionDeadline: now + downloadSessionHours * 3600 * 1000,
          })
        } catch {}
      }
    }
    const activatedAt = ticket.activatedAt

    // 6. 登录态（已由分流传入则直接复用；否则兜底自查，供直接调用场景）
    const session = verifiedSession || findSessionVerified(req)
    if (!session) {
      deny(401, 'not-authenticated', { tid })
      return
    }
    // 7. 绑定用户
    if (session.username !== uid) {
      deny(403, 'uid-mismatch', { tid, sid, seq, index, ticketUid: uid })
      return
    }
    // 8. present 记录
    const found = await readPresentedFile(sid, seq, index)
    if (!found.ok) {
      deny(404, 'present-record-missing', { tid, sid, seq, index })
      return
    }
    // 9. realpath 归属
    const safe = resolveSafeFilePath(found.file.path, found.session?.cwd)
    if (!safe.ok) {
      deny(safe.reason === 'escape' ? 403 : 404, 'path-' + safe.reason, { tid, sid, seq, index })
      return
    }
    // 10. 大小上限
    if (safe.size > downloadMaxBytes) {
      deny(413, 'too-large', { tid, sid, seq, index, size: safe.size })
      return
    }

    const filename = basename(safe.absPath)
    const rangeHeader = headerOf(req, 'range')
    const range = parseRangeHeader(rangeHeader, safe.size)

    // 审计：流式响应只能在连接结束时统计（bytes 由 finish/close 决定）
    let written = 0
    let logged = false
    let plannedStart = 0
    let plannedEnd = safe.size - 1
    const logOnce = (status) => {
      if (logged) return
      logged = true
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'file-download',
          ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
          uid: session.username, tid, sid, seq, index,
          filename, status, bytes: written, size: safe.size,
          activatedAt,
          range: typeof rangeHeader === 'string' ? rangeHeader.slice(0, 64) : null,
        })
      } catch {}
    }
    res.on('finish', () => logOnce(res.statusCode))
    res.on('close', () => logOnce(res.statusCode))

    // 416：区间不可满足，必须带 Content-Range: bytes */size
    if (range.unsatisfiable) {
      res.writeHead(416, {
        'content-type': 'application/json; charset=utf-8',
        'content-range': 'bytes */' + safe.size,
        'accept-ranges': 'bytes',
      }).end(JSON.stringify({ ok: false, error: 'range not satisfiable' }))
      return
    }

    const disposition = "attachment; filename*=UTF-8''" + rfc5987Encode(filename)
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': disposition,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    }
    let status = 200
    if (range.start !== undefined) {
      plannedStart = range.start
      plannedEnd = range.end
      status = 206
      headers['content-range'] = 'bytes ' + plannedStart + '-' + plannedEnd + '/' + safe.size
    }
    headers['content-length'] = String(plannedEnd - plannedStart + 1)

    const stream = createReadStream(safe.absPath, { start: plannedStart, end: plannedEnd })
    stream.on('data', (chunk) => { written += chunk.length })
    stream.on('error', () => {
      // 文件在 stat 之后被删/不可读：已开始拉流，只能中断连接（不写 body）
      logOnce(500)
      res.destroy()
    })

    res.writeHead(status, headers)
    stream.pipe(res)
  }

  /**
   * GET <apiPrefix>/dl/<token> —— v1.5.0 **直链下载**（卡片点击即下载）。
   *
   * 与 /file/<token> 的分工见文件头「v1.5.0 交付物直链下载」表格：
   *   本端点**无服务端状态**（票据库完全不参与），有效期 exp 直接写在 token 里，
   *   签发即起算、不激活、不限次。Range 续传照旧支持（复用 parseRangeHeader）。
   *
   * 校验顺序严格 fail-closed（**顺序本身是安全语义**）：
   *   1 结构 → 403（连签名段都解析不出，不进入任何 IO）
   *   2 验签 → 403（伪造/篡改，timingSafeEqual）
   *   3 过期 → 410（先于鉴权：过期是 token 自身属性，与「谁在用」无关，
   *                 且这样「过期」的提示不会被 401 混淆成「没登录」）
   *   4 登录态 → 401（已由人类通道分流传入；未登录不得探测 uid 是否存在）
   *   5 uid 一致 → 403（防把地址转发给外人）
   *   6 present 记录 → 404（seq/index 不存在；伪造坐标也止步于此）
   *   7 realpath 归属 → 403（防 symlink 逃逸）
   *   8 大小上限 → 413
   *
   * 为什么第 3 步（过期）在第 4 步（登录）之前：
   *   用户手机上最常见的场景是「链接放了几天后点开」 —— 此时该看到「链接已过期」，
   *   而不是「请先登录」。过期判定不泄露任何信息（token 本来就是用户自己持有的），
   *   折衷是：未登录者可用过期/未过期区分 token 新旧 —— 但 token 已在本人手里，
   *   这个区分不构成额外泄露面。
   */
  // session 由 handleApiBridge 的人类通道分流传入，避免二次指纹比对（理由同 handlePresentedList）。
  const handleDownloadByToken = async (req, res, token, verifiedSession) => {
    const deny = (status, reason, extra) => {
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'dl-denied', reason, status,
          ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
          ...extra,
        })
      } catch {}
      // 410 的文案必须**明确**：手机用户看到「link expired」才知道该回界面重开卡片，
      // 而不是反复点同一个死链。其余一律「Forbidden」，不区分原因（防探测）。
      const msg = status === 410
        ? 'download link expired (dl ticket has a fixed time window from issuance)'
        : (status === 401 ? 'Unauthorized: login required' : 'Forbidden')
      sendJson(res, status, { ok: false, error: msg })
    }

    // 1. 结构
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
      deny(403, 'structure')
      return
    }
    // 2. 验签
    const verdict = verifyDownloadTicket(token, secret)
    if (!verdict.ok) {
      deny(403, verdict.reason)
      return
    }
    const { sid, seq, index, uid, exp } = verdict.payload

    // 3. 过期（纯时间窗，签发即起算；边界口径与 file-ticket 一致：now >= exp 即失效）
    const now = nowFn()
    if (now >= exp) {
      deny(410, 'expired', { sid, seq, index, exp, now })
      return
    }

    // 4. 登录态
    const session = verifiedSession || findSessionVerified(req)
    if (!session) {
      deny(401, 'not-authenticated', { sid, seq, index })
      return
    }
    // 5. 绑定用户（地址是 bearer 式 URL，可能被转发/进剪贴板）
    if (session.username !== uid) {
      deny(403, 'uid-mismatch', { sid, seq, index, ticketUid: uid })
      return
    }
    // 6. present 记录
    const found = await readPresentedFile(sid, seq, index)
    if (!found.ok) {
      deny(found.reason === 'unavailable' ? 503 : 404, 'present-record-' + found.reason, { sid, seq, index })
      return
    }
    // 7. realpath 归属（文件路径与会话 cwd 双向 realpath，防符号链接逃逸）
    //    只有 'escape'（真实路径落在 cwd 之外）是 403 —— 那是**越权尝试**；
    //    'missing'（文件被删/改名）与 'not-file'（目录/FIFO 等）都是 404：
    //    文件本来就不存在，不是权限问题。把 404 混成 403 会让用户误以为要重新登录。
    const safe = resolveSafeFilePath(found.file.path, found.session?.cwd)
    if (!safe.ok) {
      deny(safe.reason === 'escape' ? 403 : 404, 'path-' + safe.reason, { sid, seq, index })
      return
    }
    // 8. 大小上限
    if (safe.size > downloadMaxBytes) {
      deny(413, 'too-large', { sid, seq, index, size: safe.size })
      return
    }

    const filename = basename(safe.absPath)
    const rangeHeader = headerOf(req, 'range')
    const range = parseRangeHeader(rangeHeader, safe.size)

    // 审计：直链是「一次性渲染、可能被反复点」，记录粒度到「谁在什么时候下了哪个文件」即可。
    // ⚠️ 绝不记 token 本身（它是可用凭据）；坐标 + filename 足够排查。
    let written = 0
    let logged = false
    const logOnce = (status) => {
      if (logged) return
      logged = true
      try {
        appendAccessLog(config, {
          version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
          event: 'dl-download',
          ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120),
          uid: session.username, sid, seq, index,
          filename, status, bytes: written, size: safe.size, exp,
          range: typeof rangeHeader === 'string' ? rangeHeader.slice(0, 64) : null,
        })
      } catch {}
    }
    res.on('finish', () => logOnce(res.statusCode))
    res.on('close', () => logOnce(res.statusCode))

    // 416：区间不可满足，必须带 Content-Range: bytes */size（与 /file/<token> 同口径）
    if (range.unsatisfiable) {
      res.writeHead(416, {
        'content-type': 'application/json; charset=utf-8',
        'content-range': 'bytes */' + safe.size,
        'accept-ranges': 'bytes',
      }).end(JSON.stringify({ ok: false, error: 'range not satisfiable' }))
      return
    }

    let status = 200
    let start = 0
    let end = safe.size - 1
    const headers = {
      'content-type': 'application/octet-stream',
      // RFC5987：中文文件名不会乱码；attachment 保证浏览器走下载而非就地打开
      'content-disposition': "attachment; filename*=UTF-8''" + rfc5987Encode(filename),
      'accept-ranges': 'bytes',
      // 直链是凭据化地址：不缓存（避免手机 WebView 把「已过期」的响应缓存住）
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    }
    if (range.start !== undefined) {
      start = range.start
      end = range.end
      status = 206
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + safe.size
    }
    headers['content-length'] = String(end - start + 1)

    const stream = createReadStream(safe.absPath, { start, end })
    stream.on('data', (chunk) => { written += chunk.length })
    stream.on('error', () => {
      // 文件在 stat 之后被删/不可读：已开始拉流，只能中断连接（不写 body）
      logOnce(500)
      res.destroy()
    })

    res.writeHead(status, headers)
    stream.pipe(res)
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
  /**
   * v1.8.0：给插件自建的会话补上模型选择。
   *
   * ==================== 为什么必须有这一步 ====================
   * ctx.agents.create() 直接建 agent，**绕过了官方 session-controller 的 selectModel 链路**，
   * 于是会话上没有 modelSelection。后果不是「用默认模型」，而是**整轮直接失败**：
   *
   *   turn/end.reason = { kind: 'error',
   *     error: { message: 'prompt variable "{{model}}" has no value for this assembly
   *                       (section "deployment:persona-prefix")' } }
   *
   * system prompt 的 persona-prefix 段要渲染 {{model}}，拿不到值就抛错，
   * 用户看到的是「任务已执行完成，无文本输出」—— 一个看起来成功、实际什么都没做的假象。
   *
   * ==================== 为什么这样修 ====================
   * 官方 selectModel（packages/api/session-controller/src/commands.ts:150）最终也是调
   * agents.selectForNextRequest(agent, selection)；我们直接调同一个方法，
   * 只是把「选哪个模型」交给宿主默认值（ctx.agentDefaultModel.currentSelection()），
   * 不自己发明模型 ID —— 换了部署/换了 provider，这里自动跟着走。
   *
   * ==================== 失败策略 ====================
   * 拿不到默认模型或服务缺失时**不拦**：让 followup 照常跑，由 Host 报它自己的错。
   * 理由：这里只负责「补上用户本来会有的东西」，不是鉴权/前置条件检查；
   *       悄悄吞掉异常会让「为什么还是没输出」变成更难查的问题。
   *       但要留一行日志，否则又是一次静默失败。
   */
  const applyDefaultModelSelection = (agent, sessionId) => {
    try {
      const def = ctx.get('agentDefaultModel')
      if (!def || typeof def.currentSelection !== 'function') {
        ctx.logger?.warn?.('postapi: agentDefaultModel unavailable; session %s may fail with {{model}}', sessionId)
        return false
      }
      const sel = def.currentSelection()
      if (!sel || !sel.provider || !sel.model) {
        ctx.logger?.warn?.('postapi: no default model selection; session %s may fail with {{model}}', sessionId)
        return false
      }
      // 服务名是 'sessionController'（packages/api/session-controller/src/index.ts:139
      //   super(ctx, 'sessionController', { namespace: 'session' })），
      // selectForNextRequest 挂在它的 .agents（ApiSessionAgentController）上。
      // ⚠️ 不是 ctx.get('agents') —— 那个是 AgentLoop 的 agent 注册表，没有这个方法。
      const sc = ctx.get('sessionController')
      const agents = sc && sc.agents
      if (!agents || typeof agents.selectForNextRequest !== 'function') {
        ctx.logger?.warn?.('postapi: sessionController.agents.selectForNextRequest unavailable; session %s may fail', sessionId)
        return false
      }
      agents.selectForNextRequest(agent, sel)
      return true
    } catch (e) {
      ctx.logger?.warn?.('postapi: apply default model threw for %s: %s', sessionId, e && e.message ? e.message : e)
      return false
    }
  }

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

    // ⚠️ v0.8.0 分流点：/mobile-login 必须在任何 token 校验之前处理。
    // 理由（三层）：
    //   ① 它是「登录入口」，客户端此刻还没有任何凭据——若放在 token 校验之后，
    //      等于要求「登录前先登录」，端点永远不可达；
    //   ② 因此它必须同时绕开下面两处限制：apiToken 未配置时的整体 fail-fast（503）、
    //      以及 isLoopback 分支的白名单/令牌判定。放行条件严格限定为
    //      「method === 'POST' 且 subPath === '/mobile-login'」——GET/其它方法同名路径
    //      仍会落到后面原有的 401/405 逻辑，fail-closed 语义不变；
    //   ③ 安全性不靠 token，而由 handleMobileLogin 内部的**按 IP 限流**（复用
    //      stepupFails，5 次锁 10 分钟）+ 统一 401 不区分原因来保证。
    // 位置要求：必须早于下面的 `if (!apiToken)` 与 `if (!isLoopback)` —— test/ 内
    // 有静态断言校验「本分流行号 < token 校验行号」，防止后人挪动顺序。
    const isMobileLogin = req.method === 'POST' && subPath === '/mobile-login'
    if (isMobileLogin) {
      await handleMobileLogin(req, res, sendJson)
      return
    }
    // ---- v1.4.0：/client-log 免鉴权分流（与 /mobile-login 同级）----
    // 位置要求（与 mobile-login 完全同源的理由，且有静态断言守护行号）：
    //   必须早于下面的 `if (!apiToken)` fail-fast、`isHumanEndpoint` 的 cookie 校验
    //   以及 `if (!isLoopback)` 的 Bearer 校验 —— 否则用户的 WebView（无 cookie、非回环、
    //   也无 Bearer）会拿到 401/503，日志永远传不上来，整个远程诊断功能失效。
    // 安全性不靠凭据，靠 handleClientLog 内部的五条限额 + 写盘前脱敏 + 审计留痕。
    // 只放行 POST + 精确子路径；GET 同名路径仍落到后面的 503/405（fail-closed 不变）。
    const isClientLog = req.method === 'POST' && subPath === '/client-log'
    if (isClientLog) {
      await handleClientLog(req, res, sendJson)
      return
    }

    // ==================== v0.12.1 人类通道端点分流 ====================
    // 问题（线上实测）：/files（原 /presented）与 /file-ticket 原本落在下面的**机器通道**判定里，
    // 非回环要求 Authorization: Bearer <apiToken>。但这两个端点是给**已登录的人类用户**
    // 用的 —— 浏览器同源 fetch 带的是会话 cookie（dsh_postapi_session），从不带 Bearer。
    // 于是必然 401：
    //   panel skip: http status=401
    //   {"ok":false,"error":"Unauthorized: local task requires machineLocalAllow entry or Bearer token"}
    //
    // 分流范围（人类通道 = 认会话 cookie，不认 machine token）：
    //   · POST /file-ticket   签发票据
    //   · GET  /files         交付物清单（v0.12.3 起；原 /presented 被宿主路由劫持）
    //   · GET  /file/<token>  下载（票据验签 + 绑定 uid + 会话 cookie 三层，与 machine token 无关；
    //                          不分流的话浏览器点下载按钮同样 401）
    //   · GET  /dl/<token>    **直链下载（v1.5.0）**：卡片 href 直接指向它，
    //                          浏览器原生下载，前端不发请求；票据验签 + exp + uid + cookie 四层
    //
    // 位置：必须在 `if (!apiToken)` fail-fast 与 `if (!isLoopback)` 之前，否则仍被挡。
    // 非人类通道端点（/task、/health 等）语义完全不变。
    //
    // 鉴权来源（按优先级，浏览器路径优先）：
    //   ① 有效的会话 cookie（findSessionVerified：签名 + 指纹 + 用户启用 + 滚动续期）
    //   ② 回环请求 + 正确的 Bearer apiToken（本地 curl/脚本调试便利）
    //      —— 仅严格回环可用；非回环即使带 token 也**不再**走这条路（避免把
    //      人类端点的鉴权面扩到公网脚本上；脚本请改用 /task 机器通道）。
    //      且对 /file/<token> 不提供此兜底（票据绑真实 uid，伪身份无意义且扩大鉴权面）。
    //   两条都不满足 → 401（fail-closed）。
    //
    // 为什么把 session 传进 handler 而不让它自己再查一遍：
    //   findSessionVerified 内含指纹比对与 mismatch 计数，二次调用会让失败计数翻倍，
    //   连续 3 次就吊销会话 —— 正常用户会被莫名踢掉。故只校验一次，结果传下去。
    const isFileDownload = req.method === 'GET' && subPath.startsWith('/file/')
    // v1.5.0：直链下载（卡片 href）。与 /file/<token> 同属人类通道（会话 cookie），
    // 区别在票据语义：/dl 是纯时间窗、无服务端状态；/file 是两段式、有状态。
    // 两者**并存**，不互相替代 —— /file 的语义一个字节都不改（现有分享路径继续可用）。
    const isDirectDownload = req.method === 'GET' && subPath.startsWith('/dl/')
    // v0.12.3：清单端点由 '/presented' 改名为 '/files'。
    // 原因：'/presented' 这个**精确路径**在 GET 时被宿主某条路由拦下（实测返回裸 400、
    // 响应体为空、无 content-type，且不存在的 sessionId 也一样 400 —— 说明根本没进我们的
    // handler）。宿主 present-open.ts 的 handlePresentOpen 会对 GET 校验 sessionId+seq+index，
    // 缺参数直接 `new Response('Invalid Presented file coordinates.', { status: 400 })`，
    // 与观察完全吻合。改名零风险，不做别名（被劫持的路径做别名也不会生效）。
    // v1.3.0：/app-version 与 /app-latest.apk 也属人类通道（与 /files 同鉴权）。
    //   App 下载是**真人**在浏览器/App 里点的，不该要求 Bearer；也不走 file-ticket
    //   （公开分发不需要 48h/5h 时效）。
    const APP_ENDPOINTS = ['/app-version', '/app-latest.apk']
    const HUMAN_ENDPOINTS = ['/file-ticket', '/files', '/chat/stream', '/sessions', '/chat/history', '/chat/cancel', ...APP_ENDPOINTS]
    const isHumanEndpoint = HUMAN_ENDPOINTS.includes(subPath) || isFileDownload || isDirectDownload
    if (isHumanEndpoint) {
      // 方法守卫：与端点语义对齐（/file-ticket 是 POST 签发，其余是 GET）
      if (!isFileDownload && !isDirectDownload) {
        // v1.8.0：/chat/stream 也是 POST（要带 prompt 请求体）。
        const expectedMethod = (subPath === '/file-ticket' || subPath === '/chat/stream' || subPath === '/chat/cancel') ? 'POST' : 'GET'
        if (req.method !== expectedMethod) {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed, use ' + expectedMethod })
          return
        }
      }
      // ① 会话 cookie（浏览器主路径）
      let humanSession = findSessionVerified(req)
      // ② 回环 + Bearer 兜底（本地调试；绝不在此重新读取请求体，body 已在上方解析）
      //    对 /file/<token> **不提供**该兜底：下载票据绑定真实 uid，用一个伪身份去下载
      //    既无意义（票据 uid 对不上必 403）又扩大了鉴权面，直接让它走 cookie 失败路径。
      //    v1.5.0 起 /dl/<token> 同样不提供该兜底（理由相同：票绑真实 uid）。
      if (!humanSession && !isFileDownload && !isDirectDownload && isLoopback && apiToken && providedToken && safeEqual(providedToken, apiToken)) {
        // 用 token 而非会话时不具备「某个用户」的身份 —— 对 /files 与 /file-ticket
        // 都必须知道 uid（票据要绑定用户），故这里构造一个最小 admin 上下文，
        // 明确标注来源，避免与真实会话混淆。uid 固定为 '__gateway_token__'，
        // 签出的票据也就绑定这个伪用户 —— 浏览器（真实用户）无法使用它，
        // 从而不会出现「本地脚本签的票被真人拿去用」的越权。
        humanSession = { username: '__gateway_token__', role: ROLE_ADMIN, via: 'loopback-token' }
      }
      if (!humanSession) {
        try {
          appendAccessLog(config, {
            version: AUDIT_VERSION, ts: Date.now(), iso: new Date().toISOString(),
            event: 'human-endpoint-denied', path: subPath, method: req.method,
            ip: bindIpOf(req), ua: headerOf(req, 'user-agent').slice(0, 120), loopback: isLoopback,
          })
        } catch {}
        sendJson(res, 401, { ok: false, error: 'Unauthorized: login required' })
        return
      }
      if (isDirectDownload) {
        // 直链 handler 自己会校验 exp / uid；这里传入已校验的会话，避免二次指纹比对
        await handleDownloadByToken(req, res, subPath.slice('/dl/'.length), humanSession)
      } else if (isFileDownload) {
        // 下载 handler 自己会再校验 ticket 与 uid；这里传入已校验的会话，避免二次指纹比对
        await handleFileDownload(req, res, subPath.slice('/file/'.length), humanSession)
      } else if (subPath === '/app-version') {
        handleAppVersion(req, res, sendJson, humanSession)
      } else if (subPath === '/app-latest.apk') {
        await handleAppApk(req, res, humanSession)
      } else if (subPath === '/chat/stream') {

        // 请求体必须在这里解析：本分流位于顶部统一 readJson 之前（此时 body 未声明，会撞 TDZ），
        // 且 Request 是可读流、只能消费一次。
        let sseBody = {}
        try {
          sseBody = await readJson(req, 65536)
        } catch {
          sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' })
          return
        }
        const prompt = sseBody.prompt
      if (!prompt || typeof prompt !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Missing required string field: prompt' })
        return
      }

      // ---- SSE 响应头 ----
      // ⚠️ X-Accel-Buffering: no 必须有：我们的部署经过 nginx，
      //    不加这行 nginx 会缓冲整个响应，前端要等到结束才收到 —— 那就不叫流式了。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // 立刻 flush 一个注释行：让客户端确认连接已建立（也顺带绕开某些代理的首字节缓冲）
      res.write(': connected\n\n')

      // ---- 状态 ----
      let closed = false
      let offEvent = null
      let offLlm = null
      let heartbeat = null

      const writeEvent = (obj) => {
        if (closed) return
        try {
          res.write('data: ' + JSON.stringify(obj) + '\n\n')
        } catch (eW) {
          // 写失败 = 连接已断，走清理
          closed = true
        }
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) { try { clearInterval(heartbeat) } catch (eH) {} heartbeat = null }
        if (offEvent) { try { offEvent() } catch (eO) {} offEvent = null }
        if (offLlm) { try { offLlm() } catch (eL) {} offLlm = null }
        try { res.end() } catch (eE) {}
      }

      // ---- 客户端断开：必须清理，否则订阅与定时器泄漏 ----
      // 注意：**不 cancel agent** —— 模型继续跑完，用户下次进来看历史能拿到完整回复。
      //   「断开推送」与「中止生成」是两件事，前者不该有副作用。
      req.on('close', cleanup)
      req.on('aborted', cleanup)

      // ---- 心跳：防 nginx / 中间层因空闲断开 ----
      // SSE 注释行（以 : 开头）客户端会忽略，只用于保活。
      heartbeat = setInterval(() => {
        if (closed) return
        try { res.write(': ping\n\n') } catch (eP) { cleanup() }
      }, 15000)

      ;(async () => {
        try {
          const sessionId = sseBody.sessionId || ('post_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))
          bid.sessionId = sessionId
          bid.promptPreview = String(prompt).slice(0, 80)
          bid.durationMs = Date.now()

          // 与 /task 同一套 cwd 策略（非回环强制 /tmp，防 cwd 逃逸）
          const cwd = (isLoopback && sseBody.cwd) ? sseBody.cwd : (isLoopback ? process.cwd() : '/tmp')

          let agent = ctx.agents?.get(sessionId)
          if (!agent) {
            const handle = await ctx.agents.create({
              sessionId,
              meta: { cwd, ...(sseBody.preset ? { agentPreset: sseBody.preset } : {}) },
            })
            agent = handle.agent
          }
          if (!agent) throw new Error('agents service unavailable: cannot create session ' + sessionId)
          applyDefaultModelSelection(agent, sessionId)

          writeEvent({ type: 'start', sessionId })
          // ---- v1.8.0：逐 token 增量 ----
          // ⚠️ 为什么不能只靠 ctx.on('session/event')：
          //   'assistant/live-chunk' 是**前端组装的事件**（packages/api/session-controller/src/client/
          //   contract/events.ts:8 注明 "Client-only live chunk presentation"）——
          //   宿主侧的 session/event 里根本没有它，只有整条 assistant/message。
          //   于是只订阅 session/event 会得到「一次性吐出整段」，不是打字机效果。
          //
          // 正解 = 拦截 llm/stream waterfall（官方 session-title 就是这么取增量的，
          //   见 packages/session/session-title/src/index.ts:368）。它拿到的是
          //   AsyncIterable<StreamChunk>，我们包一层，边透传边把 text-delta 推给 SSE。
          //
          // ⚠️ 必须 { global: true }：llm 调用发生在 agent 自己的 scope 里，
          //   scoped 监听器收不到。这是官方例子里的写法，不是可选项。
          // ⚠️ 必须 prepend：要拿到**未经下游改写**的原始流；且我们的包装是纯观察，
          //   不改 chunk，放前面不会影响其他消费者。
          offLlm = ctx.on('llm/stream', (options, next) => {
            if (closed) return next()
            // 只关心本会话自己的请求；子代理/标题生成等走别的 sessionId，直接放过。
            if (!options || options.sessionId !== sessionId) return next()
            // 只推「普通对话」的增量。官方为辅助调用打了 purpose 标记：
            //   purpose: 'compaction' | 'session-title'（packages/llm/llm/src/types.ts:527）
            // 普通对话请求**不设**该字段 —— 所以「有值就跳过」正是我们想要的过滤。
            // 不加这条会让会话标题生成、上下文压缩的 token 混进聊天流里（实测过）。
            if (options.purpose !== undefined) return next()
            const upstream = next()
            return (async function* () {
              for await (const chunk of upstream) {
                if (!closed && chunk) {
                  if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
                    writeEvent({ type: 'text', text: chunk.text })
                  } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
                    writeEvent({ type: 'reasoning', text: chunk.text })
                  }
                }
                // 无论是否 closed 都要继续透传 —— 我们只是观察者，截断上游会破坏整轮对话。
                yield chunk
              }
            })()
          }, { global: true, prepend: true })


          // ---- 订阅会话事件，增量直推 ----
          offEvent = ctx.on('session/event', (session, event) => {
            if (closed) return
            const sid = session && (session.id || (session.header && session.header.id))
            if (sid !== sessionId) return

            // ① 逐 token 增量（transient）
            if (event.type === 'assistant/live-chunk') {
              const chunk = event.data && event.data.chunk
              if (!chunk) return
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
                writeEvent({ type: 'text', text: chunk.text })
              } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
                writeEvent({ type: 'reasoning', text: chunk.text })
              } else if (chunk.type === 'tool-call-delta') {
                writeEvent({ type: 'tool', name: chunk.name || chunk.id || '', args: chunk.argumentsDelta || '' })
              }
              return
            }

            // ② 整轮结束信号（durable）
            //    注意：turn/end 才是「这一轮对话结束」，step/end 只是「一步」（工具调用后还会有下一步）。
            if (event.type === 'turn/end') {
              const reason = event.data && event.data.reason && event.data.reason.kind
              writeEvent({ type: 'done', reason: reason || 'complete', sessionId })
              cleanup()
            }
          })

          const userMessage = {
            id: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: prompt }],
          }

          agent.followup(userMessage)
          await agent.whenIdle()

          // whenIdle 返回后如果还没收到 turn/end（例如异常路径），补一个 done
          if (!closed) {
            writeEvent({ type: 'done', reason: 'complete', sessionId })
            cleanup()
          }
        } catch (e) {
          writeEvent({ type: 'error', message: String(e && e.message ? e.message : e) })
          cleanup()
        }
      })()
      return
      } else if (subPath === '/sessions' && req.method === 'GET') {
        // v1.9.0：会话列表。
        // 用 sessionController.list()（已做可见性过滤）而不是 ctx.sessions.list()（原始注册表）。
        // 标题不在 SessionSummary 里 —— 它存在 session/title 事件中，从事件流里 fold 一次。
        try {
          const sc = ctx.get('sessionController')
          if (!sc || typeof sc.list !== 'function') {
            sendJson(res, 503, { ok: false, error: 'sessionController unavailable' })
            return
          }
          const value = await sc.list({})
          const rows = Array.isArray(value && value.items) ? value.items : []
          const live = ctx.get('sessions')
          const out = rows.map((s) => {
            let title = ''
            try {
              const session = live && typeof live.get === 'function' ? live.get(s.sessionId) : undefined
              if (session && typeof session.snapshotEvents === 'function') {
                const events = session.snapshotEvents()
                for (let i = events.length - 1; i >= 0; i--) {
                  if (events[i] && events[i].type === 'session/title') {
                    title = String((events[i].data && events[i].data.title) || '')
                    break
                  }
                }
              }
            } catch (eT) { /* 标题取不到不影响列表可用 */ }
            return {
              sessionId: String(s.sessionId || ''),
              title,
              updatedAt: Number(s.updatedAt || 0),
              cwd: typeof s.cwd === 'string' ? s.cwd : '',
              running: s.running === true,
            }
          })
          sendJson(res, 200, { ok: true, items: out })
        } catch (e) {
          ctx.logger?.warn?.('postapi: /sessions failed: %s', e && e.message ? e.message : e)
          sendJson(res, 500, { ok: false, error: 'list sessions failed' })
        }
      } else if (subPath === '/chat/history' && req.method === 'GET') {
        // v1.9.0：读历史（分页）。
        // page() 要求 throughSeq（「读到哪为止」的上界），我们没有 follow 的 snapshot，
        // 用该会话当前日志长度 - 1 近似 —— 分页场景下这个上界是对的。
        try {
          const u = new URL(req.url, 'http://localhost')
          const sessionId = u.searchParams.get('sessionId') || ''
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: 'Missing required query param: sessionId' })
            return
          }
          const limitRaw = Number(u.searchParams.get('limit') || '50')
          const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
          const beforeRaw = u.searchParams.get('beforeSeq')
          const beforeSeq = beforeRaw === null ? undefined : Number(beforeRaw)

          const sc = ctx.get('sessionController')
          if (!sc || typeof sc.page !== 'function') {
            sendJson(res, 503, { ok: false, error: 'sessionController unavailable' })
            return
          }

          let throughSeq = Number.isFinite(beforeSeq) ? beforeSeq : 0
          try {
            const live = ctx.get('sessions')
            const session = live && typeof live.get === 'function' ? live.get(sessionId) : undefined
            if (session && typeof session.snapshotEvents === 'function') {
              throughSeq = Math.max(0, session.snapshotEvents().length - 1)
            }
          } catch (eT) { /* 用兜底值 */ }

          const pageReq = {
            address: { kind: 'session', sessionId },
            throughSeq,
            maxMessages: limit,
            ...(Number.isFinite(beforeSeq) ? { beforeSeq } : {}),
          }
          // ⚠️ 必须传一个真实的 AbortSignal：page() 内部是 signal.throwIfAborted()（无可选链），
          //    传 undefined 会抛 TypeError: Cannot read properties of undefined (reading 'throwIfAborted')。
          // 这里给一个永不 abort 的 controller —— 客户端断开时不中断宿主读取，
          // 因为分页读很快，中断收益远小于引入"读到一半"的复杂度。
          const pageSignal = new AbortController()
          const page = await sc.page(pageReq, pageSignal.signal)
          const records = Array.isArray(page && page.records) ? page.records : []

          // 压成客户端要的 {seq, role, text, time}：
          // 助手正文在 assistant/message 的 content[] 里；用户消息在 agent/inbox/spliced 的 inserted[] 里。
          // 其余事件（工具调用、思考、状态）全部跳过 —— 原生界面第一版只显示对话本身。
          const items = []
          const pushText = (seq, role, content, time) => {
            const blocks = Array.isArray(content) ? content : []
            const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
            if (text) items.push({ seq, role, text, time })
          }
          for (const r of records) {
            const ev = r && r.event ? r.event : r
            if (!ev || typeof ev.type !== 'string') continue
            const seq = Number(ev.seq || 0)
            const time = Number(ev.time || 0)
            if (ev.type === 'assistant/message') {
              // 助手正文：data.message.content[]
              const msg = ev.data && ev.data.message
              pushText(seq, 'assistant', msg && msg.content, time)
            } else if (ev.type === 'user/message') {
              // ⚠️ 用户消息的真实事件是 **user/message**（不是 agent/inbox/spliced）。
              //   实测某会话：user/message 545 条、agent/inbox/spliced 891 条 ——
              //   后者是「收件箱变更记录」，它的 inserted[] 在某些场景下为空（消息已被消费），
              //   拿它当用户消息来源会漏掉绝大部分对话。真实结构：
              //   { type:'user/message', seq, time, data:{ content:[{type:'text',text}], role:'user' } }
              pushText(seq, 'user', ev.data && ev.data.content, time)
            }
          }
          items.sort((a, b) => a.seq - b.seq)
          sendJson(res, 200, { ok: true, items, hasMore: page && page.hasMore === true })
        } catch (e) {
          ctx.logger?.warn?.('postapi: /chat/history failed: %s', e && e.message ? e.message : e)
          sendJson(res, 500, { ok: false, error: 'read history failed' })
        }
      } else if (subPath === '/chat/cancel' && req.method === 'POST') {
        // v1.9.0：中断生成。
        try {
          let cancelBody = {}
          try {
            cancelBody = await readJson(req, 65536)
          } catch (eB) {
            sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' })
            return
          }
          const sessionId = cancelBody && cancelBody.sessionId ? String(cancelBody.sessionId) : ''
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: 'Missing required field: sessionId' })
            return
          }
          const sc = ctx.get('sessionController')
          if (!sc || typeof sc.cancel !== 'function') {
            sendJson(res, 503, { ok: false, error: 'sessionController unavailable' })
            return
          }
          await sc.cancel({ sessionId })
          sendJson(res, 200, { ok: true })
        } catch (e) {
          ctx.logger?.warn?.('postapi: /chat/cancel failed: %s', e && e.message ? e.message : e)
          sendJson(res, 500, { ok: false, error: 'cancel failed' })
        }
      } else if (subPath === '/file-ticket') {
        // ⚠️ 请求体必须**在这里**解析：本分流位于 handleApiBridge 顶部的统一 readJson 之前，
        // 此时 `body` 还未声明（用它会撞 TDZ 的 ReferenceError）。
        // 且 Request 是可读流、只能消费一次 —— 在这里读完，后面的统一解析也不会再跑到
        // （本分支必然 return）。
        let ticketBody = {}
        try {
          ticketBody = await readJson(req, 4096)
        } catch {
          sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' })
          return
        }
        await handleFileTicket(req, res, sendJson, ticketBody, humanSession)
      } else {
        await handlePresentedList(req, res, sendJson, humanSession)
      }
      return
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
        clientIp: bindIpOf(req),
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
        applyDefaultModelSelection(agent, sessionId)

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


    // ============================================================================
    // v1.8.0：POST /chat/stream —— SSE 流式对话（给原生客户端用）
    // ============================================================================
    //
    // ==================== 为什么需要这个端点 ====================
    // 用户想做一个纯原生 Android 前端（不经过 WebView），解决打字卡/流式卡/布局不适配。
    // 但 DSH 官方的流式协议是 WebSocket 多路复用（/api/remote.mux），
    // 无契约、无版本前缀、随时会变 —— 原生客户端直接啃它，每次 DSH 升级都要重做。
    //
    // ⇒ 本端点当「防腐层」：App 只跟这个稳定的 SSE 接口打交道，
    //    内部用什么协议是插件的事。DSH 升级时只改这里，App 不用动。
    //
    // ==================== 事件来源（已核实，非猜测）====================
    // ctx.on('session/event') 会收到两类事件：
    //   ① durable 事件（assistant/message、step/end、turn/end…）—— 落盘的完整消息
    //   ② transient 事件（assistant/live-chunk）—— **真正的逐 token 增量**
    //
    // 增量结构（packages/api/session-controller/src/client/contract/events.ts:8）：
    //   { type: 'assistant/live-chunk',
    //     data: { attemptId, turn, step,
    //             chunk: StreamChunk } }
    //
    // StreamChunk（packages/llm/llm/src/types.ts:440）：
    //   | { type: 'text-delta';      index; text }            ← 正文增量 ★
    //   | { type: 'reasoning-delta'; index; text }            ← 思考过程增量
    //   | { type: 'tool-call-delta'; index; id; name?; argumentsDelta }
    //   | { type: 'block-start' | 'block-end' | 'usage' | 'finish' }
    //
    // ==================== SSE 帧约定（App 侧照着这个解）====================
    //   data: {"type":"start","sessionId":"..."}
    //   data: {"type":"text","text":"增量"}          ← 正文
    //   data: {"type":"reasoning","text":"增量"}     ← 思考（可选，App 可忽略）
    //   data: {"type":"tool","name":"...","args":"..."}  ← 工具调用（可选）
    //   data: {"type":"done","reason":"complete"}
    //   data: {"type":"error","message":"..."}
    //   每 15 秒一个 ": ping" 注释行（防中间层空闲断开）
    //
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
