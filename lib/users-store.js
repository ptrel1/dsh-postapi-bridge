/**
 * Persistent user store for dsh-server-auth.
 *
 * Stores managed users in `$DSH_HOME/server-auth/users.json`. Passwords are
 * never stored in plaintext: each user carries a random salt and a
 * sha256(salt + password) hash. Writes are atomic (write to a temp file then
 * rename), so a crash cannot corrupt the store.
 *
 * @module dsh-server-auth/users-store
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** A managed account. The `password` field never exists on stored users. */
export const ROLE_ADMIN = 'admin'
export const ROLE_USER = 'user'

export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Build the storage directory path (created lazily). */
export function usersStorePath() {
  return join(resolveDshHome(), 'server-auth', 'users.json')
}

/** Hash a password with the given salt hex. Constant-output, deterministic. */
export function hashPassword(password, saltHex) {
  return createHash('sha256').update(saltHex + password).digest('hex')
}

/** Generate a fresh salt (hex). */
export function newSalt() {
  return randomBytes(16).toString('hex')
}

/**
 * User store with an in-memory cache backed by the JSON file. All mutations
 * update the cache and then write the file atomically.
 */
export class UsersStore {
  /** @param {string} path - path to the users.json file (defaults to $DSH_HOME/server-auth/users.json). */
  constructor(path = usersStorePath()) {
    this.path = path
    this.users = []
  }

  /** Load users from disk. Missing/empty file yields no users. */
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
      // A corrupt store must fail loud rather than silently reset accounts.
      throw new Error(`server-auth: cannot read user store ${this.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Flush the in-memory users to disk atomically. */
  persist() {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.users, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }

  /** Find a stored user by username (case-sensitive). */
  get(username) {
    return this.users.find((u) => u.username === username)
  }

  /** Verify a plaintext credential against a stored user. */
  verify(username, password) {
    const user = this.get(username)
    if (!user || !user.enabled) return false
    const hash = hashPassword(password, user.salt)
    return hash === user.passwordHash
  }

  /**
   * Create a user. Returns the stored record without the hash secrets beyond
   * the field names the callers need.
   */
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

  /** Change a user's password. Returns false if the user is missing. */
  changePassword(username, newPassword) {
    const user = this.get(username)
    if (!user) return false
    user.salt = newSalt()
    user.passwordHash = hashPassword(newPassword, user.salt)
    this.persist()
    return true
  }

  /** Toggle a user's enabled state. Returns the new state, or undefined if missing. */
  toggleEnabled(username) {
    const user = this.get(username)
    if (!user) return undefined
    user.enabled = !user.enabled
    this.persist()
    return user.enabled
  }

  /** Delete a user. Returns true when deleted, false when missing. */
  remove(username) {
    const at = this.users.findIndex((u) => u.username === username)
    if (at === -1) return false
    this.users.splice(at, 1)
    this.persist()
    return true
  }

  /** Public projection of a user for listing (never exposes salt/hash). */
  list() {
    return this.users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt,
    }))
  }

  /** Number of managed users. */
  get size() {
    return this.users.length
  }
}
