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

  create(sessionId, username, role = ROLE_USER, maxAgeMs = 86400000) {
    const s = {
      sessionId,
      username,
      role,
      expiresAt: Date.now() + maxAgeMs,
      createdAt: new Date().toISOString(),
    }
    this.sessions.set(sessionId, s)
    this.persist()
    return s
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
