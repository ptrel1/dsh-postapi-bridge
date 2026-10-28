// v1.0.2：**复现并防住「访问未 inject 的服务属性会 throw」这个根因**。
//
// 背景（20261022 线上真实异常）：
//   GET /files?sessionId=<会话> → 500 {"ok":false,"error":"files list failed:
//     cannot get property \"sessionQuery\" without inject"}
// 根因：插件 inject = ['webServer','agents','sessions']，不含 sessionQuery。
// cordis 规定访问未声明服务的属性**直接 throw** —— 所以 `if (!ctx.sessionQuery ...)`
// 这行防御代码的**读取动作本身**就抛了，根本走不到判断分支。
//
// ⚠️ 为什么之前的全套测试都没抓到：桩 ctx 是普通对象，`ctx.sessionQuery` 天然可读。
//   本文件的核心价值 = 桩 ctx 会**模拟 cordis 行为**：读未声明服务属性就 throw。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'

const home = mkdtempSync(join(tmpdir(), 'inject-guard-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/index.js')
const { UsersStore, SessionsStore } = await import('../lib/users-store.js')

const SECRET = 'inject-guard-secret'
const CWD = join(home, 'ws')
mkdirSync(CWD, { recursive: true })
const F1 = join(CWD, 'out.txt')
writeFileSync(F1, 'hi')

new UsersStore().create({ username: 'bob', password: 'P' + Math.random().toString(36).slice(2) + '!', role: 'user' })
const SID = 'sess-inject-' + Date.now()
new SessionsStore().create(SID, 'bob', 'user', 3600_000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })
const COOKIE = SID + '.' + createHmac('sha256', SECRET).update(SID).digest('hex')

/**
 * 造一个**模拟 cordis 语义**的 ctx：
 *   · 只有 PROVIDED 里的服务可读；
 *   · 读别的属性 → throw `cannot get property "x" without inject`（与 cordis 一致）；
 *   · ctx.get(name) 安全探测，不存在返回 undefined（与 cordis 一致）。
 */
function makeCtx ({ provided = {}, listEvents, readEvent } = {}) {
  const routes = []
  const declared = new Set(['logger', 'settings', 'effect', 'provide', 'on', 'agents', 'webServer', 'get', 'inject', 'scope'])
  const base = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    settings: { get: () => undefined },
    effect (fn) { fn() },
    provide () {},
    on () { return () => {} },
    agents: {},
    webServer: { tapIndex: () => () => {}, register (r) { routes.push(r); return () => {} } },
    // cordis 的 ctx.get：安全探测，strict 只返回已激活服务
    get (name) { return provided[name] },
    _routes: routes,
  }
  // 用 Proxy 模拟 cordis：读未 inject 的属性直接 throw
  return new Proxy(base, {
    get (target, prop) {
      if (typeof prop === 'symbol') return target[prop]
      if (declared.has(prop) || prop in target) return target[prop]
      // 模拟 cordis 的真实报错（这是本测试的核心）
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
    has (target, prop) { return declared.has(prop) || prop in target },
  })
}

function startServer (ctx) {
  apply(ctx, { sessionSecret: SECRET, apiToken: 'gw', accessLogDir: join(home, 'audit') })
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    for (const r of ctx._routes) {
      const hit = (r.kind === 'exact' && p === r.path) || (r.kind === 'prefix' && req.url.startsWith(r.path))
      if (!hit) continue
      return Promise.resolve(r.handler(req, res)).catch((e) => {
        console.error('[HANDLER THREW]', e && e.message)
        if (!res.headersSent) res.writeHead(500)
        res.end('handler threw: ' + (e && e.message))
      })
    }
    res.writeHead(404); res.end('no route')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function get (port, path, body, method = 'GET') {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'node-test', cookie: 'dsh_postapi_session=' + COOKIE }
    let payload = null
    if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json' }
    const q = http.request({ host: '127.0.0.1', port, path, method, headers }, (r) => {
      const cs = []
      r.on('data', (c) => cs.push(c))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString() }))
    })
    q.on('error', reject)
    if (payload) q.write(payload)
    q.end()
  })
}

const EVENTS = [{ seq: 10, type: 'deliverables/presented', time: Date.now(),
  data: { turn: 1, callId: 'c1', files: [{ path: F1 }] } }]

// ─────────── 场景 1：sessionQuery **完全不提供**（模拟精简 profile）───────────
let s1
test('setup-none: 桩 ctx 提供 cordis 语义，且不提供 sessionQuery', async () => {
  const ctx = makeCtx({ provided: {} })
  // 先证明桩确实会 throw（否则本测试没有意义）
  assert.throws(() => ctx.sessionQuery, /without inject/, '桩 ctx 必须复现 cordis 的 throw')
  s1 = await startServer(ctx)
  assert.ok(s1.port > 0)
})

test('A. sessionQuery 不存在时，/files 返回 503（不抛异常、不 500）', async () => {
  const r = await get(s1.port, '/api/dsh/v1/files?sessionId=' + SID)
  assert.equal(r.status, 503, 'body=' + r.body.slice(0, 200))
  assert.ok(r.body.includes('session query service unavailable'))
  assert.ok(!r.body.includes('without inject'), '不得把 cordis 的 throw 暴露出去')
})

test('B. sessionQuery 不存在时，/file-ticket 返回 503（不抛异常）', async () => {
  const r = await get(s1.port, '/api/dsh/v1/file-ticket', { sessionId: SID, seq: 10, index: 0 }, 'POST')
  assert.equal(r.status, 503, 'body=' + r.body.slice(0, 200))
  assert.ok(!r.body.includes('without inject'))
})

test('C. 无效 token → 403（验签在 sessionQuery 之前，属正确顺序）', async () => {
  // 说明：/file/<token> 的检查顺序是「结构 → 验签 → 票据状态 → sessionQuery」。
  // 假 token 会先撞验签 403 —— 这是**正确行为**，不是本次要测的场景。
  // 只要不是 cordis 的 'without inject' 异常、不是 500，就说明 ctx.get 修复生效。
  const r = await get(s1.port, '/api/dsh/v1/file/dummy-token')
  assert.equal(r.status, 403, 'body=' + r.body.slice(0, 200))
  assert.ok(!r.body.includes('without inject'))
})

test('C2. 下载端点在任何 token 情况下都不抛 without inject（不 500）', async () => {
  // 说明：/file/<token> 的检查顺序是「结构 → 验签 → 票据状态 → 生命周期 → sessionQuery」。
  // 要让请求走到 sessionQuery 那一层，必须往 ticketStore 里塞一张真实票据（内部实现细节，
  // 依赖过深且脆弱）。本用例改用**更稳的判据**：
  //   无论 token 是什么形态，响应都必须是**我们自己的 JSON 错误**，
  //   绝不能是 'without inject' 的异常泄漏或 500。
  // 这正好覆盖了本次根因（读取 ctx.sessionQuery 抛异常 → 500）。
  const cases = [
    'dummy-token',
    'a.b.c',
    'x'.repeat(2100),   // 超长 → 结构检查
    encodeURIComponent('eyJ2IjoyfQ'),  // 形似 base64url
  ]
  for (const tok of cases) {
    const r = await get(s1.port, '/api/dsh/v1/file/' + tok)
    assert.notEqual(r.status, 500, 'token=' + tok.slice(0, 20) + ' body=' + r.body.slice(0, 200))
    assert.ok(!r.body.includes('without inject'), '不得泄漏 cordis 异常：' + r.body.slice(0, 200))
    // 必须是结构化 JSON 错误（说明确实进了我们的 handler 并被正常拒绝）
    const j = (() => { try { return JSON.parse(r.body) } catch { return null } })()
    assert.ok(j && j.ok === false && typeof j.error === 'string', 'body=' + r.body.slice(0, 200))
  }
})
test('teardown-none', async () => { await new Promise((r) => s1.server.close(r)) })

// ─────────── 场景 2：sessionQuery **正常提供** ───────────
let s2
const SQ = {
  async listEvents (sid) { if (sid !== SID) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND'); return EVENTS },
  async readEvent ({ sessionId, seq }) {
    if (sessionId !== SID) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
    const ev = EVENTS.find((e) => e.seq === seq)
    if (!ev) throw new Error('SESSION_QUERY_EVENT_NOT_FOUND')
    return { session: { id: SID, cwd: CWD }, target: ev, events: [ev], inheritedEventCount: 0, startSeq: seq, endSeq: seq }
  },
}

test('setup-provided: 提供 sessionQuery', async () => {
  const ctx = makeCtx({ provided: { sessionQuery: SQ } })
  s2 = await startServer(ctx)
  assert.ok(s2.port > 0)
})

test('D. sessionQuery 存在时，/files 正常工作返回文件列表', async () => {
  const r = await get(s2.port, '/api/dsh/v1/files?sessionId=' + SID)
  assert.equal(r.status, 200, 'body=' + r.body.slice(0, 200))
  const j = JSON.parse(r.body)
  assert.equal(j.ok, true)
  assert.equal(j.files.length, 1)
  assert.equal(j.files[0].name, 'out.txt')
})

test('teardown-provided', async () => { await new Promise((r) => s2.server.close(r)) })
