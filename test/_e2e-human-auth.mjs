// v0.12.1 人类通道鉴权端到端（一次性）：验证 cookie 能过、machine token 语义未破坏。
// 不触碰 3080；DSH_HOME 指向临时目录。
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { apply } from '../lib/index.js'

const TMP = mkdtempSync(join(tmpdir(), 'postapi-ha-'))
process.env.DSH_HOME = join(TMP, 'dshhome')
const AUDIT = join(TMP, 'audit')
const { UsersStore, SessionsStore } = await import('../lib/users-store.js')

const ALICE = 'ha_alice_' + Date.now().toString(36)
const BOB = 'ha_bob_' + Date.now().toString(36)
const PASS = 'P' + Math.random().toString(36).slice(2) + '!'
const us = new UsersStore()
us.create({ username: ALICE, password: PASS, role: 'user' })
us.create({ username: BOB, password: PASS, role: 'user' })

const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'a.txt'), 'hello-a')
const SID = 'ha-sess-' + Date.now().toString(36)
const EVENTS = [
  { type: 'deliverables/presented', seq: 10, time: 1792636949516, data: { turn: 3, callId: 'c', files: [{ path: 'a.txt', description: 'A' }] } },
]

const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  settings: { get: () => undefined },
  effect (fn) { fn() }, provide () {}, on () { return () => {} }, agents: {},
  // v1.0.2：插件通过 ctx.get('sessionQuery') 取服务
  get (name) { return this[name] },
  sessionQuery: {
    // v1.0.3：真实 listEvents 不返回 data，桩如实模拟
    async listEvents (id) {
      if (id !== SID) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      return EVENTS.map(e => ({ sessionId: id, seq: e.seq, type: e.type, time: e.time, surface: 'main' }))
    },
    async readEvent ({ sessionId, seq }) {
      if (sessionId !== SID) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      const ev = EVENTS.find(e => e.seq === seq)
      if (!ev) throw new Error('SESSION_QUERY_EVENT_NOT_FOUND')
      return { session: { id: SID, cwd: WS }, target: ev, events: [ev], inheritedEventCount: 0, startSeq: seq, endSeq: seq }
    },
  },
  webServer: { tapIndex: () => () => {}, register (r) { routes.push(r); return () => {} } },
}
const SECRET = 'ha-secret-' + Date.now()
const GW_TOKEN = 'ha-gw-token'
apply(ctx, { sessionSecret: SECRET, apiToken: GW_TOKEN, accessLogDir: AUDIT })

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  for (const r of routes) {
    if (r.kind === 'exact' && p === r.path) return r.handler(req, res)
    if (r.kind === 'prefix' && req.url.startsWith(r.path)) return r.handler(req, res)
  }
  res.writeHead(404).end('')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = 'http://127.0.0.1:' + PORT

// 说明：本测试的所有请求都从 127.0.0.1 发出 → isStrictLoopback 还要求 Host 为回环。
// http.request 默认 Host=127.0.0.1:port，故**所有请求都算回环**。
// 为了验证「非回环」路径，需要显式把 Host 改成外部域名（socket 仍是 127 但 Host 不是回环）。
function mkCookie (username) {
  const sid = 'sid-' + username + '-' + Math.random().toString(36).slice(2)
  new SessionsStore().create(sid, username, 'user', 3600_000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })
  return sid + '.' + createHmac('sha256', SECRET).update(sid).digest('hex')
}
const ALICE_COOKIE = mkCookie(ALICE)
const STALE_COOKIE = (() => {   // 已过期会话
  const sid = 'stale-' + Math.random().toString(36).slice(2)
  new SessionsStore().create(sid, ALICE, 'user', -1000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })
  return sid + '.' + createHmac('sha256', SECRET).update(sid).digest('hex')
})()
const DISABLED_SID = (() => {   // 会话有效但用户被禁用
  const sid = 'dis-' + Math.random().toString(36).slice(2)
  new SessionsStore().create(sid, BOB, 'user', 3600_000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })
  us.toggleEnabled(BOB)
  return sid + '.' + createHmac('sha256', SECRET).update(sid).digest('hex')
})()

function req (method, path, { cookie, token, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = { 'user-agent': 'ha-test', ...(host ? { host } : {}) }
    if (cookie) headers.cookie = 'dsh_postapi_session=' + cookie
    if (token) headers.authorization = 'Bearer ' + token
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
    const q = http.request(BASE + path, { method, headers }, (res) => {
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString(), headers: res.headers }))
    })
    q.on('error', reject)
    if (payload) q.write(payload)
    q.end()
  })
}

let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('  ✔ ' + n) } else { fail++; console.log('  ✖ ' + n + (d ? '  → ' + d : '')) } }
const P = '/api/dsh/v1/files?sessionId=' + SID

console.log('== 1. 有效会话 cookie（核心修复）==')
{
  const r = await req('GET', P, { cookie: ALICE_COOKIE })
  const j = r.status === 200 ? JSON.parse(r.body) : null
  check('/files + cookie → 200', r.status === 200, r.status + ' ' + r.body.slice(0, 160))
  check('返回 1 个文件', !!j && j.files.length === 1, JSON.stringify(j && j.files))
}
{
  const r = await req('POST', '/api/dsh/v1/file-ticket', { cookie: ALICE_COOKIE, body: { sessionId: SID, seq: 10, index: 0 } })
  const j = r.status === 200 ? JSON.parse(r.body) : null
  check('/file-ticket + cookie → 200', r.status === 200, r.status + ' ' + r.body.slice(0, 160))
  check('返回 url 与 activateDeadline', !!j && typeof j.url === 'string' && typeof j.activateDeadline === 'number')
  // 顺带确认审计：file-ticket-issued 正常落盘
  const text = readFileSync(join(AUDIT, 'access-log.jsonl'), 'utf8')
  check('审计 file-ticket-issued 正常记录', text.includes('"event":"file-ticket-issued"'))
  // 下载链路：用同一 cookie 拉下来
  if (j) {
    const d = await req('GET', j.url, { cookie: ALICE_COOKIE })
    check('/file/<token> + cookie → 200 且内容正确', d.status === 200 && d.body === 'hello-a', d.status + ' ' + d.body.slice(0, 60))
  }
}

console.log('== 2. 无凭据 → 401 ==')
{
  check('/files 无 cookie 无 token → 401（回环但不在白名单）', (await req('GET', P)).status === 401)
  check('/file-ticket 无凭据 → 401', (await req('POST', '/api/dsh/v1/file-ticket', { body: {} })).status === 401)
}

console.log('== 3. 回环 + Bearer 兜底（脚本调试）==')
{
  const r = await req('GET', P, { token: GW_TOKEN })
  check('回环 + 正确 Bearer → 200（脚本可自动化）', r.status === 200, r.status + ' ' + r.body.slice(0, 120))
  const r2 = await req('GET', P, { token: 'wrong-token' })
  check('回环 + 错误 Bearer → 401', r2.status === 401, String(r2.status))
}
{
  // 非回环（Host 为外部域名）+ 正确 Bearer → 不应放行人类通道（避免把鉴权面扩到公网脚本）
  const r = await req('GET', P, { token: GW_TOKEN, host: 'dsh.example.com' })
  check('非回环 + Bearer → 401（人类通道不放行公网脚本）', r.status === 401, r.status + ' ' + r.body.slice(0, 120))
}

console.log('== 4. 会话失效 ==')
{
  check('过期会话 cookie → 401', (await req('GET', P, { cookie: STALE_COOKIE })).status === 401)
  check('用户被禁用 → 401', (await req('GET', P, { cookie: DISABLED_SID })).status === 401)
}

console.log('== 5. 方法守卫 ==')
{
  check('GET /file-ticket → 405', (await req('GET', '/api/dsh/v1/file-ticket', { cookie: ALICE_COOKIE })).status === 405)
  check('POST /files → 405', (await req('POST', P, { cookie: ALICE_COOKIE, body: {} })).status === 405)
}

console.log('== 6. 机器通道语义未破坏 ==')
{
  // 非回环 + 无 token：/task 仍 401
  const t1 = await req('POST', '/api/dsh/v1/task', { host: 'dsh.example.com', body: { prompt: 'x' } })
  check('非回环 /task 无 token → 401', t1.status === 401, t1.status + ' ' + t1.body.slice(0, 120))
  // 非回环 + 正确 token：/task 放行到业务层（这里因无 agents 会 500，但不是 401）
  const t2 = await req('POST', '/api/dsh/v1/task', { host: 'dsh.example.com', token: GW_TOKEN, body: { prompt: 'x' } })
  check('非回环 /task 带 token → 非 401（越过网关鉴权）', t2.status !== 401, String(t2.status))
  // 回环 + 无 token：/task 仍 401（machineLocalAllow 为空）
  const t3 = await req('POST', '/api/dsh/v1/task', { body: { prompt: 'x' } })
  check('回环 /task 无凭据 → 401（白名单未含）', t3.status === 401, String(t3.status))
}

console.log('== 7. /health 仍免鉴权 ==')
{
  const h1 = await req('GET', '/api/dsh/v1/health')
  check('回环 /health → 200', h1.status === 200, String(h1.status))
  const h2 = await req('GET', '/api/dsh/v1/health', { host: 'dsh.example.com' })
  check('非回环 /health → 200（免鉴权）', h2.status === 200, String(h2.status))
}

console.log('== 8. 拒绝审计 ==')
{
  const text = readFileSync(join(AUDIT, 'access-log.jsonl'), 'utf8')
  check('记录 human-endpoint-denied', text.includes('"event":"human-endpoint-denied"'))
  check('审计不含 cookie / token 值', !text.includes(ALICE_COOKIE) && !text.includes(GW_TOKEN))
}

server.close()
console.log('\n结果: pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
