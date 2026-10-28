// v1.9.0：三个兼容模式端点的单元测试。
//
// 为什么必须写这个测试：
//   /sessions 与 /chat/history 靠真实 curl 验证过了，但 /chat/cancel 需要真实凭据才能打，
//   而凭据不应为了测试而到处流转。用桩 ctx 直接驱动 handler 是更干净的做法 ——
//   它验证的是「参数形状对不对、返回值会不会抛」，这恰好是 cancel 唯一的风险点。
//
// 桩的设计要点（与 files-handler.mjs 同一套约定）：
//   · ctx.get(name) 是插件唯一安全的服务探测方式（直接读属性会因未 inject 而 throw）
//   · 所有 handler 抛错都会在 startServer 的 catch 里暴露，不会变成空响应
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'compat-endpoints-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/index.js')
const { UsersStore, SessionsStore } = await import('../lib/users-store.js')

const SECRET = 'test-secret-compat-endpoints'
const SID = 'sess-compat-' + Date.now()

/** 记录所有被调用的宿主方法，用于断言参数形状。 */
const calls = { list: 0, page: null, cancel: null }

function makeCtx () {
  const routes = []
  const sessionController = {
    list: async (_req) => {
      calls.list += 1
      return { items: [{ sessionId: SID, updatedAt: 1700000000000, running: false, cwd: '/tmp' }] }
    },
    page: async (req, signal) => {
      calls.page = { req, hasSignal: signal !== undefined && typeof signal.throwIfAborted === 'function' }
      // ⚠️ 如实模拟宿主的严格性：page() 内部是 signal.throwIfAborted()（无可选链），
      //    传 undefined 会抛 TypeError。这里主动复现，防止插件侧再漏传。
      signal.throwIfAborted()
      return {
        records: [
          // ⚠️ 用户消息的真实事件是 user/message（v1.9.0 修正）。
          //    早先版本用 agent/inbox/spliced 当桩，那是错的 —— 它是收件箱变更记录，
          //    真实会话里 user/message 有 545 条而 inbox/spliced 的 inserted 常为空。
          { event: { type: 'user/message', seq: 3, time: 1700000000000, data: { content: [{ type: 'text', text: '你好' }], role: 'user' } } },
          // assistant 消息带 turn（交付物按 turn 关联的消息必须是同一条）
          { event: { type: 'assistant/message', seq: 4, time: 1700000000100, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好，有什么可以帮你' }] } } } },
          // 交付物：data.turn 与上面的 assistant 消息一致；路径不下发给客户端，只给文件名
          { event: { type: 'deliverables/presented', seq: 5, time: 1700000000200, data: { turn: 1, callId: 'c1', files: [{ path: '/tmp/out/report.txt', description: '统计报告' }] } } },
        ],
        hasMore: false,
      }
    },
    cancel: async (req) => {
      calls.cancel = req
      return { accepted: true }
    },
  }
  return {
    routes,
    logger: { info () {}, warn () {}, error () {} },
    settings: { get: () => undefined },
    effect (fn) { fn() },
    provide () {},
    on () { return () => {} },
    agents: {},
    get (name) {
      if (name === 'sessionController') return sessionController
      if (name === 'sessions') {
        // v1.9.2：history 会用 sessions.get(sid).snapshotEvents() 单独扫交付物
        //（与分页窗口解耦）。桩必须提供这条路径，否则测不到那部分逻辑。
        return {
          get: (sid) => (sid === SID
            ? {
                snapshotEvents: () => [
                  { type: 'user/message', seq: 3, time: 1700000000000, data: { content: [{ type: 'text', text: '你好' }], role: 'user' } },
                  { type: 'assistant/message', seq: 4, time: 1700000000100, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好，有什么可以帮你' }] } } },
                  { type: 'deliverables/presented', seq: 5, time: 1700000000200, data: { turn: 1, callId: 'c1', files: [{ path: '/tmp/out/report.txt', description: '统计报告' }] } },
                ],
              }
            : undefined),
        }
      }
      return undefined
    },
    webServer: { tapIndex: () => () => {}, register (r) { routes.push(r); return () => {} } },
  }
}

// 必须先建用户与会话：findSessionVerified 会去 SessionsStore 里查这条记录，
// 只给 cookie 不给存储记录会被判 401（这是插件的安全设计，不是测试问题）。
new UsersStore().create({ username: 'alice', password: 'P-' + Math.random().toString(36).slice(2) + '!', role: 'admin' })
new SessionsStore().create(SID, 'alice', 'admin', 3600_000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })

const ctx = makeCtx()
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
    console.error('[HANDLER THREW]', e && e.stack)
    if (!res.headersSent) res.writeHead(500)
    res.end('handler threw: ' + (e && e.message))
  })
})

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

test.after(() => server.close())

const COOKIE = SID + '.' + createHmac('sha256', SECRET).update(SID).digest('hex')
const auth = { cookie: 'dsh_postapi_session=' + COOKIE, 'content-type': 'application/json' }

function request (method, path, body) {
  return new Promise((resolve, reject) => {
    const q = http.request(
      { host: '127.0.0.1', port, path, method, headers: { ...auth, 'user-agent': 'node-test' } },
      (r) => {
        const cs = []
        r.on('data', (c) => cs.push(c))
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString() }))
      },
    )
    q.on('error', reject)
    if (body) q.write(body)
    q.end()
  })
}

test('GET /sessions 返回会话列表', async () => {
  const r = await request('GET', '/api/dsh/v1/sessions')
  assert.equal(r.status, 200, r.body)
  const d = JSON.parse(r.body)
  assert.equal(d.ok, true)
  assert.equal(d.items.length, 1)
  assert.equal(d.items[0].sessionId, SID)
  assert.ok(calls.list >= 1, '应调用 sessionController.list')
})

test('GET /sessions 无 cookie 时 401', async () => {
  const r = await new Promise((resolve, reject) => {
    const q = http.request(
      { host: '127.0.0.1', port, path: '/api/dsh/v1/sessions', method: 'GET', headers: { 'user-agent': 'node-test' } },
      (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString() })) },
    )
    q.on('error', reject); q.end()
  })
  assert.equal(r.status, 401, r.body)
})

test('GET /chat/history 压平出 user/assistant 消息', async () => {
  const r = await request('GET', '/api/dsh/v1/chat/history?sessionId=' + SID + '&limit=10')
  assert.equal(r.status, 200, r.body)
  const d = JSON.parse(r.body)
  assert.equal(d.ok, true)
  assert.equal(d.items.length, 2, JSON.stringify(d.items))
  assert.deepEqual(d.items.map((x) => x.role), ['user', 'assistant'])
  assert.equal(d.items[0].text, '你好')
  assert.ok(calls.page && calls.page.hasSignal, 'page() 必须带 AbortSignal（宿主无可选链）')
})

test('GET /chat/history 把交付物挂到同 turn 的助手消息上', async () => {
  const r = await request('GET', '/api/dsh/v1/chat/history?sessionId=' + SID + '&limit=10')
  assert.equal(r.status, 200, r.body)
  const d = JSON.parse(r.body)
  const assistant = d.items.find((x) => x.role === 'assistant')
  assert.ok(assistant, '应有助手消息')
  assert.ok(Array.isArray(assistant.deliverables), '助手消息应带 deliverables 数组')
  assert.equal(assistant.deliverables.length, 1)
  assert.equal(assistant.deliverables[0].name, 'report.txt', '只给文件名，不给绝对路径')
  assert.equal(assistant.deliverables[0].description, '统计报告')
  assert.equal(assistant.deliverables[0].seq, 5, '下载坐标 = 交付物事件的 seq')
  assert.equal(assistant.deliverables[0].index, 0)
  assert.ok(!JSON.stringify(d).includes('/tmp/out'), '响应里不应出现服务端绝对路径')
  // v1.9.3 起 turn **要**下发：客户端要把 deliverablesByTurn 挂到正确的消息上，
  // 靠「第 N 条助手消息 ≈ 第 N 个 turn」猜会挂错（一轮可能多条助手消息）。
  assert.ok('turn' in assistant, 'turn 必须下发（v1.9.3）')
})

test('GET /chat/history 缺 sessionId 时 400', async () => {
  const r = await request('GET', '/api/dsh/v1/chat/history')
  assert.equal(r.status, 400, r.body)
})

test('POST /chat/cancel 参数形状正确', async () => {
  const r = await request('POST', '/api/dsh/v1/chat/cancel', JSON.stringify({ sessionId: SID }))
  assert.equal(r.status, 200, r.body)
  assert.equal(JSON.parse(r.body).ok, true)
  assert.ok(calls.cancel, '应调用 sessionController.cancel')
  // 宿主 SessionCancelRequest 只有 sessionId 一个字段（types.ts:371）
  assert.deepEqual(Object.keys(calls.cancel), ['sessionId'])
  assert.equal(calls.cancel.sessionId, SID)
})

test('POST /chat/cancel 缺 sessionId 时 400', async () => {
  const r = await request('POST', '/api/dsh/v1/chat/cancel', JSON.stringify({}))
  assert.equal(r.status, 400, r.body)
})

test('GET /chat/history 额外返回 deliverablesByTurn（不受分页窗口限制）', async () => {
  const r = await request('GET', '/api/dsh/v1/chat/history?sessionId=' + SID + '&limit=1')
  assert.equal(r.status, 200, r.body)
  const d = JSON.parse(r.body)
  // limit=1 时 items 只有 1 条，但交付物仍要完整返回 ——
  // 这正是 v1.9.2 要解决的问题：窗口外的事件不该被丢掉。
  // 不断言 items 数量：本测试的桩 page() 不模拟 maxMessages 截断（那是宿主行为，
  // 已在真实环境验证过）。这里只断言「交付物与分页窗口解耦」这件事。
  assert.ok(d.deliverablesByTurn, '应返回 deliverablesByTurn 顶层字段')
  assert.ok(d.deliverablesByTurn['1'], 'turn=1 应有交付物（与 items 的窗口无关）')
  assert.equal(d.deliverablesByTurn['1'].length, 1)
  assert.equal(d.deliverablesByTurn['1'][0].name, 'report.txt')
})

test('交付物按 turn 关联：页内消息与 deliverablesByTurn 能对上', async () => {
  const r = await request('GET', '/api/dsh/v1/chat/history?sessionId=' + SID + '&limit=1')
  const d = JSON.parse(r.body)
  assert.ok(d.deliverablesByTurn['1'], 'turn=1 的交付物必须返回，即使页内只有 1 条消息')
  const assistant = d.items.find((x) => x.role === 'assistant')
  assert.ok(assistant, '应有助手消息')
  assert.equal(typeof assistant.turn, 'number', 'assistant 消息应带 turn（v1.9.3）')
  assert.equal(assistant.turn, 1)
})
