/**
 * Persistent user and session store for dsh-postapi-bridge / dsh-server-auth.
 *
 * Stores managed users in $DSH_HOME/server-auth/users.json.
 * Stores active sessions in $DSH_HOME/server-auth/sessions.json.
 *
 * @module dsh-server-auth/users-store
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const ROLE_ADMIN = 'admin'

/**
 * v0.12.4：UA 哈希历史保留条数。
 * 为什么是 3：一次最多容纳「上一次 + 上上次 + 当前」两轮版本漂移。
 * 再多意义不大（历史越长，被盗 cookie 的可用窗口越久），再少则浏览器连续升级两次就掉出历史。
 */
export const UA_HASH_HISTORY_MAX = 3
export const ROLE_USER = 'user'

export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function usersStorePath() {
  return join(resolveDshHome(), 'server-auth', 'users.json')
}

export function sessionsStorePath() {
  return join(resolveDshHome(), 'server-auth', 'sessions.json')
}

export function hashPassword(password, saltHex) {
  return createHash('sha256').update(saltHex + password).digest('hex')
}

export function newSalt() {
  return randomBytes(16).toString('hex')
}

export class UsersStore {
  constructor(path = usersStorePath()) {
    this.path = path
    this.users = []
    this.load()
  }

  load() {
    if (!existsSync(this.path)) {
      this.users = []
      return
    }
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      this.users = Array.isArray(parsed) ? parsed : []
    } catch (err) {
      throw new Error(`server-auth: cannot read user store ${this.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  persist() {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.users, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }

  get(username) {
    return this.users.find((u) => u.username === username)
  }

  verify(username, password) {
    const user = this.get(username)
    if (!user || !user.enabled) return false
    const hash = hashPassword(password, user.salt)
    return hash === user.passwordHash
  }

  create({ username, password, role = ROLE_USER }) {
    if (this.get(username)) throw new Error(`server-auth: user "${username}" already exists`)
    const salt = newSalt()
    const user = {
      id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      username,
      salt,
      passwordHash: hashPassword(password, salt),
      role,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    this.users.push(user)
    this.persist()
    return user
  }

  changePassword(username, newPassword) {
    const user = this.get(username)
    if (!user) return false
    user.salt = newSalt()
    user.passwordHash = hashPassword(newPassword, user.salt)
    this.persist()
    return true
  }

  toggleEnabled(username) {
    const user = this.get(username)
    if (!user) return undefined
    user.enabled = !user.enabled
    this.persist()
    return user.enabled
  }

  remove(username) {
    const at = this.users.findIndex((u) => u.username === username)
    if (at === -1) return false
    this.users.splice(at, 1)
    this.persist()
    return true
  }

  list() {
    return this.users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt,
    }))
  }

  get size() {
    return this.users.length
  }
}

export class SessionsStore {
  constructor(path = sessionsStorePath()) {
    this.path = path
    this.sessions = new Map()
    this.load()
  }

  load() {
    if (!existsSync(this.path)) {
      this.sessions = new Map()
      return
    }
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      const now = Date.now()
      this.sessions = new Map()
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && v.expiresAt && v.expiresAt > now) {
            this.sessions.set(k, v)
          }
        }
      }
    } catch {
      this.sessions = new Map()
    }
  }

  persist() {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    const obj = Object.fromEntries(this.sessions)
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }

  get(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    if (s.expiresAt && s.expiresAt < Date.now()) {
      this.sessions.delete(sessionId)
      this.persist()
      return undefined
    }
    return s
  }

  /**
   * P0 会话指纹绑定（PLAN-20260901-SEC01）：
   * 签发时记录 bindIpPrefix（登录时的 IP 段）与 bindUaHash（UA sha256 前 16 位），
   * 后续每次鉴权由 index.js 的 verifyFingerprint 校验，不匹配即视为盗用。
   * bind 参数缺省时字段为 undefined——旧格式会话（升级前签发）序列化后同样没有
   * 这两个字段，鉴权侧对「无指纹会话」一律 fail-closed 拒绝，倒逼重新登录一次。
   */
  create(sessionId, username, role = ROLE_USER, maxAgeMs = 86400000, bind = {}) {
    const s = {
      sessionId,
      username,
      role,
      expiresAt: Date.now() + maxAgeMs,
      createdAt: new Date().toISOString(),
      bindIpPrefix: bind.ipPrefix,
      bindUaHash: bind.uaHash,
    }
    this.sessions.set(sessionId, s)
    this.persist()
    return s
  }

  /**
   * 防爆破锁定：连续 mismatch 达 3 次吊销会话（盗用者反复试探指纹即触发）。
   * 鉴权成功时由 index.js 调 resetMismatch 归零。
   * 返回 'revoked' | 'mismatch'，供调用方区分日志语义。
   */
  recordMismatch(sessionId, maxConsecutive = 3) {
    const s = this.sessions.get(sessionId)
    if (!s) return 'revoked'
    s.mismatchCount = (s.mismatchCount || 0) + 1
    if (s.mismatchCount >= maxConsecutive) {
      this.sessions.delete(sessionId)
      this.persist()
      return 'revoked'
    }
    this.persist()
    return 'mismatch'
  }

  /**
   * UA 指纹的**刷新**（原 v0.11.0 的 migrateUaClass，v0.12.4 重写）。
   *
   * 背景：v0.6.3 之前签发的会话只存 bindUaHash（UA 逐字节 sha256，熵约 2^57），
   * 不存 bindUaClass。而手机浏览器 UA 必然漂移（Edge/Chrome 版本升级、系统更新、
   * WebView↔App 浏览器），逐字节比必然失配 ⇒ 手机端被反复踢。
   *
   * ⚠️ v0.12.4 安全修复（审查 H1）：旧实现只写 bindUaClass，而 verifyFingerprint 的
   * 新分支**只比 bindUaClass、永远不再读 bindUaHash** ⇒ 一次迁移就把锁从
   * 「逐字节哈希(2^57)」**永久**换成「设备类别三选一(2^2)」，而且不可逆。
   * 攻击者拿老 cookie + 任意同类设备 UA，一次请求即可完成降级。
   *
   * 现在的语义：迁移 = 把锁**刷新到当前版本**，而不是换成弱锁。
   *   · bindUaClass 写当前类别；
   *   · bindUaHash 刷成当前 UA 的哈希；
   *   · 旧哈希推进 bindUaHashHistory（最近 N 个，N=3）——这样「刚升级过版本」的
   *     正常用户仍能命中历史，不会因为升级就掉到宽松路径。
   *
   * 熵不降级：迁移后 match 判定仍要求「当前哈希 ∈ {bindUaHash} ∪ history」，
   * 类别只是**必要条件**、不是充分条件。
   *
   * @param {string} sessionId 会话 id
   * @param {string} uaClass 当前 UA 设备类别（desktop/mobile/tablet）
   * @param {string} [uaHash] 当前 UA 的哈希（16 hex）；缺省则只写类别（向后兼容旧调用）
   * @returns {boolean} 会话不存在或类别非法返回 false（不抛错）
   */
  migrateUaClass(sessionId, uaClass, uaHash) {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    // 防御：只接受已知类别。「other」代表 bot/curl/空 UA，调用方本就不该刷新这类请求，
    // 但仍在这里兜一层，避免把不可识别的类别写进会话后永久放宽。
    if (uaClass !== 'desktop' && uaClass !== 'mobile' && uaClass !== 'tablet') return false
    s.bindUaClass = uaClass
    const next = typeof uaHash === 'string' && /^[0-9a-f]{16}$/.test(uaHash) ? uaHash : undefined
    if (next !== undefined) {
      const current = s.bindUaHash
      if (typeof current === 'string' && /^[0-9a-f]{16}$/.test(current) && current !== next) {
        // 旧的当前哈希滚进历史，保留最近 N 个（去重、新的在前）
        const prev = Array.isArray(s.bindUaHashHistory) ? s.bindUaHashHistory : []
        const merged = [current, ...prev].filter((h, i, arr) =>
          typeof h === 'string' && /^[0-9a-f]{16}$/.test(h) && h !== next && arr.indexOf(h) === i)
        s.bindUaHashHistory = merged.slice(0, UA_HASH_HISTORY_MAX)
      }
      s.bindUaHash = next
    }
    this.persist()
    return true
  }
  resetMismatch(sessionId) {
    const s = this.sessions.get(sessionId)
    if (s && s.mismatchCount) {
      delete s.mismatchCount
      this.persist()
    }
  }

  /**
   * P2 滚动续期：活跃会话在校验通过时顺延过期时间，静默会话自然过期。
   * 由调用方控制节流（仅剩余不足一半时才写盘），避免每次鉴权都落盘。
   */
  touch(sessionId, maxAgeMs) {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    s.expiresAt = Date.now() + maxAgeMs
    this.persist()
    return true
  }

  delete(sessionId) {
    const res = this.sessions.delete(sessionId)
    if (res) this.persist()
    return res
  }

  has(sessionId) {
    return this.get(sessionId) !== undefined
  }
}
