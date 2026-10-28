// v1.0.1：**直接调用 handlePresentedList**，验证 handler 内部能完整跑完。
//
// 背景：v0.12.x 时代 `?sessionId=` 曾返回 400 size=0（空白响应）。事后判明那次请求**进了**
// handler，是内部 sessionQuery.listEvents 抛异常导致空响应 —— 与「被网关拦截」是两码事。
// 本测试用真实形状的 records 直接驱动 handler，确认它不会抛、不会空响应。
//
// 做法：用桩 ctx 挂载插件，然后通过真实 HTTP 请求打到 /files（最小成本拿到真实响应）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'files-handler-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/index.js')
const { UsersStore, SessionsStore } = await import('../lib/users-store.js')

const SECRET = 'test-secret-for-handler-inprocess'
const SID = 'sess-handler-' + Date.now()
const CWD = join(home, 'workspace')
mkdirSync(CWD, { recursive: true })
const F1 = join(CWD, 'report.txt')
writeFileSync(F1, 'hello')

// 真实形状的会话：与线上一致（ipPrefix / uaHash / uaClass 全部齐全）
const SESSIONS = {
  [SID]: {
    sessionId: SID, username: 'alice', role: 'user',
    expiresAt: Date.now() + 3600_000,
    bindIpPrefix: '127.0',
    bindUaHash: 'aaaaaaaaaaaaaaaa',
    bindUaClass: 'other',   // 测试请求不带浏览器 UA，归 other；回环放行不受影响
  },
}

function makeCtx (events) {
  const routes = []
  // 真实形状的 sessionQuery：listEvents 返回完整记录（含 data），readEvent 返回带 session.cwd 的窗口
  const squery = {
    // ⚠️ v1.0.3：真实 listEvents **不返回 data 载荷**（官方 SessionEventRecord 只有
    // {sessionId, seq, type, time, surface}）。桩必须如实模拟，否则测不到「data 拿不到」这个 bug。
    listEvents: async (sid) => {
      if (sid !== SID) return []
      return events.map((e) => ({
        sessionId: sid, seq: e.seq, type: e.type, time: e.time, surface: 'main',
      }))
    },
    readEvent: async ({ sessionId, seq }) => ({
      session: { id: sessionId, cwd: sessionId === SID ? CWD : undefined },
      target: events.find((e) => e.seq === seq) || null,
      events: [], inheritedEventCount: 0, startSeq: seq, endSeq: seq,
    }),
  }
  return {
    routes,
    // 最小桩 ctx：只提供插件 apply() 真正会碰到的成员
    logger: { info () {}, warn () {}, error () {} },
    settings: { get: () => undefined },
    effect (fn) { fn() },
    provide () {},
    on () { return () => {} },
    agents: {},
    // v1.0.2：cordis 的 ctx.get()（安全探测）。
    // 插件用它取 sessionQuery —— 直接读 ctx.sessionQuery 会 throw（未 inject），
    // 所以桩必须提供 get，而不是挂一个 sessionQuery 属性。
    get (name) { return name === 'sessionQuery' ? squery : undefined },
    webServer: { tapIndex: () => () => {}, register (r) { routes.push(r); return () => {} } },
  }
}
function startServer (ctx) {
  apply(ctx, {
    sessionSecret: SECRET,
    apiToken: 'gw-token',
    accessLogDir: join(home, 'audit'),
    downloadMaxMB: 200,
  })
  const server = http.createServer((req, res) => {
    const r = ctx.routes.find((x) => x.kind === 'prefix' && req.url.startsWith(x.path))
    if (!r) { res.writeHead(404); res.end('no route'); return }
    Promise.resolve(r.handler(req, res)).catch((e) => {
      // 关键：任何 handler 抛错都会在这里暴露，而不是变成空 400
      console.error('[HANDLER THREW]', e && e.stack)
      if (!res.headersSent) { res.writeHead(500) }
      res.end('handler threw: ' + (e && e.message))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// 会话 cookie = <sessionId>.<hmac sha256 hex>（与插件一致）
const COOKIE = SID + '.' + createHmac('sha256', SECRET).update(SID).digest('hex')

function get (port, path, withCookie = true) {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'node-test' }
    if (withCookie) headers.cookie = 'dsh_postapi_session=' + COOKIE
    const q = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (r) => {
      const cs = []
      r.on('data', (c) => cs.push(c))
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(cs).toString() }))
    })
    q.on('error', reject)
    q.end()
  })
}

// 构造真实形状的 deliverables/presented 记录（含一个合格文件 + 一个不存在的）
const EVENTS = [
  { seq: 10, type: 'deliverables/presented', time: Date.now(),
    data: { turn: 1, callId: 'c1', files: [
      { path: F1, description: 'report' },
      { path: join(CWD, 'missing.txt'), description: 'gone' },
    ] } },
]

let server, port
test('setup', async () => {
  // 用插件自己的 API 建用户与会话（手写 sessions.json 的格式不可靠，容易造成假失败）
  new UsersStore().create({ username: 'alice', password: 'P' + Math.random().toString(36).slice(2) + '!', role: 'user' })
  new SessionsStore().create(SID, 'alice', 'user', 3600_000, {
    ipPrefix: '127.0', uaClass: 'other', uaHash: 'x',
  })
  const ctx = makeCtx(EVENTS)
  const s = await startServer(ctx)
  server = s.server
  port = s.port
  assert.ok(port > 0)
})

test('A. 缺 sessionId → 400 且 body 有明确文案（不是空响应）', async () => {
  const r = await get(port, '/api/dsh/v1/files')
  assert.equal(r.status, 400)
  assert.ok(r.body.length > 0, 'body 不能为空')
  assert.ok(r.body.includes('sessionId'))
})

test('B. ?sid= 不被接受（证明参数名就是 sessionId）', async () => {
  const r = await get(port, '/api/dsh/v1/files?sid=' + SID)
  assert.equal(r.status, 400)
  assert.ok(r.body.includes('Missing required query param: sessionId'))
})

test('C. ?sessionId= → handler 完整跑完，返回 200 且带文件列表（核心）', async () => {
  const r = await get(port, '/api/dsh/v1/files?sessionId=' + SID)
  assert.equal(r.status, 200, 'status != 200 → body=' + r.body.slice(0, 300))
  assert.ok(r.body.length > 0, 'body 不能为空 ⇒ 不是 v0.12.x 那种空 400')
  const j = JSON.parse(r.body)
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.files))
  assert.equal(j.files.length, 1, '合格文件 1 个（另一个不存在被跳过）')
  assert.equal(j.files[0].name, 'report.txt')
  assert.equal(j.files[0].size, 5)
  assert.ok(typeof j.files[0].ticketUrl === 'string' && j.files[0].ticketUrl.includes('/file-ticket'))
  assert.equal(j.skipped, 1)
})

test('D. handler 没有抛异常（否则 setup 里的 catch 会返回 500）', async () => {
  const r = await get(port, '/api/dsh/v1/files?sessionId=' + SID)
  assert.notEqual(r.status, 500, 'handler 抛异常了：' + r.body.slice(0, 300))
  assert.ok(!r.body.includes('handler threw'))
})

test('teardown', async () => { await new Promise((r) => server.close(r)) })
