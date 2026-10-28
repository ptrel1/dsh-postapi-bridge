// v1.5.0 直链下载（/dl/<token>）测试：纯函数单测 + 真实 HTTP 端到端。
//
// 为什么必须端到端：本功能的全部价值是「卡片 href 点了真能下到文件」。
// 只测纯函数会漏掉路由分流、鉴权顺序、Range 头这些**只有真发请求才暴露**的问题
// （/files 当年就是「接口活了但永远空列表」这么翻车的）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dl-ticket-'))
process.env.DSH_HOME = home

const { apply, __dlTicketHelpers: H } = await import('../lib/index.js')
const { UsersStore, SessionsStore } = await import('../lib/users-store.js')

const SECRET = 'test-secret-for-dl-ticket'
const HOUR = 3600 * 1000

// ───────────────────────── ① 纯函数：签发 / 验签 / 过期 ─────────────────────────
test('A1 签发 → 验签往返，载荷含 v/sid/seq/index/uid/exp', () => {
  const r = H.issueDownloadTicket({
    sid: 'sess-1', seq: 2365, index: 0, uid: 'alice',
    hours: 48, now: 1700000000000, secret: SECRET, apiPrefix: '/api/dsh/v1',
  })
  assert.equal(r.ok, true)
  assert.equal(r.expiresAt, 1700000000000 + 48 * HOUR, 'exp = 签发时刻 + 48h（签发即起算）')
  assert.match(r.url, /^\/api\/dsh\/v1\/dl\/[A-Za-z0-9_.-]+$/)
  const token = r.url.slice('/api/dsh/v1/dl/'.length)
  const v = H.verifyDownloadTicket(token, SECRET)
  assert.equal(v.ok, true)
  assert.deepEqual(v.payload, {
    v: H.DL_TICKET_VERSION, sid: 'sess-1', seq: 2365, index: 0, uid: 'alice', exp: r.expiresAt,
  })
  assert.equal(v.payload.exp, r.expiresAt, 'exp 必须**在 token 里**（纯无状态，不查库）')
})

test('A2 默认有效期 48h', () => {
  assert.equal(H.DL_TICKET_DEFAULT_HOURS, 48)
  const r = H.issueDownloadTicket({
    sid: 's', seq: 1, index: 0, uid: 'u', now: 1000, secret: SECRET, apiPrefix: '/api/dsh/v1',
  })
  assert.equal(r.expiresAt, 1000 + 48 * HOUR)
})

test('A3 篡改载荷（改 uid）→ 验签失败', () => {
  const r = H.issueDownloadTicket({
    sid: 's', seq: 1, index: 0, uid: 'alice', now: 1000, secret: SECRET, apiPrefix: '/api/dsh/v1',
  })
  const token = r.url.slice('/api/dsh/v1/dl/'.length)
  const [, sig] = token.split('.')
  const forged = Buffer.from(JSON.stringify({
    v: H.DL_TICKET_VERSION, sid: 's', seq: 1, index: 0, uid: 'bob', exp: r.expiresAt,
  }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.deepEqual(H.verifyDownloadTicket(forged + '.' + sig, SECRET), { ok: false, reason: 'signature' })
})

test('A4 换 secret 验签失败；结构非法一律拒', () => {
  const r = H.issueDownloadTicket({
    sid: 's', seq: 1, index: 0, uid: 'alice', now: 1000, secret: SECRET, apiPrefix: '/api/dsh/v1',
  })
  const token = r.url.slice('/api/dsh/v1/dl/'.length)
  assert.equal(H.verifyDownloadTicket(token, 'other-secret').reason, 'signature')
  for (const bad of ['', '.', 'a.', '.b', 'a.b.c', 'not a token']) {
    assert.equal(H.verifyDownloadTicket(bad, SECRET).ok, false, JSON.stringify(bad))
  }
})

test('A5 版本不对 → version 拒绝', () => {
  const body = Buffer.from(JSON.stringify({
    v: 1, sid: 's', seq: 1, index: 0, uid: 'alice', exp: 99999999999999,
  }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.deepEqual(H.verifyDownloadTicket(body + '.' + sig, SECRET), { ok: false, reason: 'version' })
})

test('A6 isUsableDownloadUrl：只认文档相对的 /…/dl/<token>', () => {
  assert.equal(H.isUsableDownloadUrl('/api/dsh/v1/dl/abc.def'), true)
  assert.equal(H.isUsableDownloadUrl('https://evil.com/api/dsh/v1/dl/x'), false, '绝对地址不得通过')
  assert.equal(H.isUsableDownloadUrl('//evil.com/api/dsh/v1/dl/x'), false, '协议相对不得通过')
  assert.equal(H.isUsableDownloadUrl('/api/dsh/v1/file/abc'), false, '必须是 /dl/')
  assert.equal(H.isUsableDownloadUrl('/api/dsh/v1/dl/'), false, '空 token 不得通过')
  assert.equal(H.isUsableDownloadUrl('/api/dsh/v1/dl/a b'), false, '空白不得通过')
  assert.equal(H.isUsableDownloadUrl(''), false)
  assert.equal(H.isUsableDownloadUrl(null), false)
})

// ───────────────────────── ② 端到端：真实 HTTP ─────────────────────────
// ⚠️ 指纹口径：verifyFingerprint 对 uaClass='other'（bot/curl/node 类 UA）一律拒绝。
// 早期这些用例用 'node-test' UA + uaClass:'other' 侥幸通过，是因为部分路径没走
// findSessionVerified；一旦真正走到指纹校验就会 403。这里统一用**真机 UA + mobile**，
// 与线上用户路径一致（也顺便验证「手机 WebView 打开直链」这条主场景）。
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
const SID = 'sess-dl-' + Date.now()
const SID_OTHER = 'sess-dl-other-' + Date.now()
const CWD = join(home, 'workspace')
mkdirSync(CWD, { recursive: true })
const F_CONTENT = Buffer.from('0123456789abcdefghij')      // 20 字节，便于验证 Range
const F1 = join(CWD, 'DSH-PostAPI-v0.3.0.apk')
writeFileSync(F1, F_CONTENT)
const F_GONE = join(CWD, 'will-be-deleted.txt')
writeFileSync(F_GONE, 'bye')

let clock = 1700000000000            // 可注入时钟：用于时间旅行验证 410
const nowFn = () => clock

const EVENTS = [
  { seq: 10, type: 'deliverables/presented', time: 1, data: { turn: 3, callId: 'c1', files: [
    { path: F1, description: '很长的描述' },
  ] } },
  { seq: 11, type: 'deliverables/presented', time: 2, data: { turn: 4, callId: 'c2', files: [
    { path: F_GONE, description: 'gone soon' },
  ] } },
]

function makeCtx () {
  const routes = []
  const squery = {
    // 真实口径：listEvents 只返回轻量记录（无 data）
    listEvents: async (sid) => (sid === SID
      ? EVENTS.map((e) => ({ sessionId: sid, seq: e.seq, type: e.type, time: e.time, surface: 'main' }))
      : []),
    readEvent: async ({ sessionId, seq }) => ({
      session: { id: sessionId, cwd: sessionId === SID ? CWD : undefined },
      target: sessionId === SID ? (EVENTS.find((e) => e.seq === seq) || null) : null,
      events: [], inheritedEventCount: 0, startSeq: seq, endSeq: seq,
    }),
  }
  return {
    routes,
    logger: { info () {}, warn () {}, error () {} },
    settings: { get: () => undefined },
    effect (fn) { fn() },
    provide () {},
    on () { return () => {} },
    agents: {},
    get (name) { return name === 'sessionQuery' ? squery : undefined },
    webServer: { tapIndex: () => () => {}, register (r) { routes.push(r); return () => {} } },
  }
}

function startServer (ctx, extraConfig) {
  apply(ctx, Object.assign({
    sessionSecret: SECRET,
    apiToken: 'gw-token',
    accessLogDir: join(home, 'audit'),
    downloadMaxMB: 200,
    dlTicketHours: 48,
    now: nowFn,
  }, extraConfig || {}))
  const server = http.createServer((req, res) => {
    const r = ctx.routes.find((x) => x.kind === 'prefix' && req.url.startsWith(x.path))
    if (!r) { res.writeHead(404); res.end('no route'); return }
    Promise.resolve(r.handler(req, res)).catch((e) => {
      console.error('[HANDLER THREW]', e && e.stack)
      if (!res.headersSent) res.writeHead(500)
      res.end('handler threw: ' + (e && e.message))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const cookieOf = (sid) => 'dsh_postapi_session=' + sid + '.' + createHmac('sha256', SECRET).update(sid).digest('hex')

function request (port, p, { cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'user-agent': MOBILE_UA }, headers)
    if (cookie) h.cookie = cookie
    const q = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: h }, (r) => {
      const cs = []
      r.on('data', (c) => cs.push(c))
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(cs) }))
    })
    q.on('error', reject)
    q.end()
  })
}

let server, port
test('setup', async () => {
  new UsersStore().create({ username: 'alice', password: 'Pa!' + Math.random().toString(36).slice(2), role: 'user' })
  new UsersStore().create({ username: 'bob', password: 'Pb!' + Math.random().toString(36).slice(2), role: 'user' })
  new SessionsStore().create(SID, 'alice', 'user', 24 * HOUR, { ipPrefix: '127.0', uaClass: 'mobile', uaHash: 'x' })
  new SessionsStore().create(SID_OTHER, 'bob', 'user', 24 * HOUR, { ipPrefix: '127.0', uaClass: 'mobile', uaHash: 'y' })
  const s = await startServer(makeCtx())
  server = s.server
  port = s.port
  assert.ok(port > 0)
})

// /files 取直链（**端到端闭环的起点**：卡片 href 就是从这里来的）
let filesJson
test('B1 /files 每条都有 downloadUrl + downloadExpiresAt', async () => {
  const r = await request(port, '/api/dsh/v1/files?sessionId=' + SID, { cookie: cookieOf(SID) })
  assert.equal(r.status, 200, r.body.toString().slice(0, 300))
  filesJson = JSON.parse(r.body.toString())
  assert.equal(filesJson.files.length, 2)
  for (const f of filesJson.files) {
    assert.equal(typeof f.downloadUrl, 'string', '每条必须有 downloadUrl')
    assert.match(f.downloadUrl, /^\/api\/dsh\/v1\/dl\/[A-Za-z0-9_.-]+$/)
    assert.equal(typeof f.downloadExpiresAt, 'number')
    assert.equal(f.downloadExpiresAt, clock + 48 * HOUR, 'exp = 签发时刻 + 48h')
    assert.ok(typeof f.ticketUrl === 'string', 'ticketUrl 必须保留（兼容）')
  }
})

test('B2 【端到端】downloadUrl 里的 token 真的能下载成功', async () => {
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  assert.ok(f, '必须找到 apk 那条')
  const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID) })
  assert.equal(r.status, 200, r.body.toString().slice(0, 200))
  assert.deepEqual(r.body, F_CONTENT, '字节必须完全一致')
  assert.equal(r.headers['content-type'], 'application/octet-stream')
  assert.match(r.headers['content-disposition'], /^attachment; filename\*=UTF-8''/)
  assert.ok(r.headers['content-disposition'].includes('DSH-PostAPI-v0.3.0.apk'))
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.equal(r.headers['cache-control'], 'private, no-store')
})

test('B3 Range 请求 → 206 + Content-Range', async () => {
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  const r = await request(port, f.downloadUrl, {
    cookie: cookieOf(SID), headers: { range: 'bytes=2-7' },
  })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], 'bytes 2-7/20')
  assert.equal(r.headers['content-length'], '6')
  assert.equal(r.body.toString(), '234567')
})

test('B4 Range 后缀（bytes=-4）→ 最后 4 字节', async () => {
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID), headers: { range: 'bytes=-4' } })
  assert.equal(r.status, 206)
  assert.equal(r.body.toString(), 'ghij')
})

test('B5 过期 → 410 + 明确文案', async () => {
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  const saved = clock
  clock = filesJson.files[0].downloadExpiresAt        // 恰好到 exp：now >= exp 即失效（半开区间）
  try {
    const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID) })
    assert.equal(r.status, 410, '过期必须 410')
    const j = JSON.parse(r.body.toString())
    assert.match(j.error, /expired/i, '文案必须明确说明过期')
  } finally { clock = saved }
})

test('B6 过期前一刻仍可下载（边界另一侧）', async () => {
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  const saved = clock
  clock = f.downloadExpiresAt - 1
  try {
    const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID) })
    assert.equal(r.status, 200)
  } finally { clock = saved }
})

test('B7 签名篡改 → 403', async () => {
  const f = filesJson.files[0]
  const token = f.downloadUrl.slice('/api/dsh/v1/dl/'.length)
  const dot = token.indexOf('.')
  const last = token.slice(-1)
  const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A')
  assert.notEqual(tampered, token)
  const r = await request(port, '/api/dsh/v1/dl/' + tampered, { cookie: cookieOf(SID) })
  assert.equal(r.status, 403)
  assert.ok(dot > 0)
})

test('B8 票据被改 uid 后验签失败 → 403（不是 uid-mismatch，而是签名错）', async () => {
  const f = filesJson.files[0]
  const token = f.downloadUrl.slice('/api/dsh/v1/dl/'.length)
  const dot = token.indexOf('.')
  const body = Buffer.from(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const payload = JSON.parse(body)
  payload.uid = 'bob'
  const forgedBody = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const r = await request(port, '/api/dsh/v1/dl/' + forgedBody + token.slice(dot), { cookie: cookieOf(SID_OTHER) })
  assert.equal(r.status, 403, '改载荷必然破坏 HMAC')
})

test('B9 无 cookie → 401', async () => {
  const f = filesJson.files[0]
  const r = await request(port, f.downloadUrl)
  assert.equal(r.status, 401)
})

test('B10 文件已删除 → 404（同一会话，直链仍在有效期内）', async () => {
  // 注意顺序：**必须放在 B13 之前**。B13 会吊销 alice 的会话（连续指纹失配
  // 或 uid 不符的相关用例），一旦会话没了，这里的 403/401 会掩盖真正的 404。
  // ENOENT 在 present 记录仍存在时由 resolveSafeFilePath 归为 'missing' → 404；
  // 若落在 'escape'（realpath 失败）则是 403 —— 两者都不泄露文件内容，
  // 但状态码语义不同，这里断言的是**用户可见的正确语义**。
  const f = filesJson.files.find((x) => x.name === 'will-be-deleted.txt')
  assert.ok(f, '必须有 will-be-deleted.txt 那条')
  unlinkSync(F_GONE)
  const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID) })
  assert.ok(r.status === 404 || r.status === 403,
    '文件已删除必须是 4xx（不得 200），实际 ' + r.status)
  assert.notEqual(r.status, 200, '已删除的文件不得返回内容')
  // 期望语义是 404；若实现落到 403（realpath 失败被归为 escape），说明
  // resolveSafeFilePath 的 'missing'/'escape' 口径需要修 —— 记录但不放宽。
  assert.equal(r.status, 404, '已删除文件的正确语义是 404')
})

test('B11 路径穿越：token 里伪造 seq（合法签名但坐标不存在）→ 404', async () => {
  // 攻击场景：拿到 secret 才能签；但即使签得出「合法签名 + 任意坐标」，
  // 坐标层仍必须 fail-closed（present 记录里没有就是没有，不得越权读到别处）。
  const forged = H.issueDownloadTicket({
    sid: SID, seq: 999999, index: 0, uid: 'alice',
    hours: 1, now: clock, secret: SECRET, apiPrefix: '/api/dsh/v1',
  })
  assert.equal(forged.ok, true)
  const r = await request(port, forged.url, { cookie: cookieOf(SID) })
  assert.equal(r.status, 404, '坐标不存在 → 404（不得越权读到别处）')
})

test('B12 路径穿越：同一 seq 的越界 index → 404', async () => {
  const forged = H.issueDownloadTicket({
    sid: SID, seq: 10, index: 99, uid: 'alice',
    hours: 1, now: clock, secret: SECRET, apiPrefix: '/api/dsh/v1',
  })
  const r = await request(port, forged.url, { cookie: cookieOf(SID) })
  assert.equal(r.status, 404)
})

test('B13 票据 uid 与登录用户不符 → 403（防转发给外人）', async () => {
  // 攻击场景：alice 的直链地址被转发给 bob。地址是 bearer 式 URL，一旦泄露，
  // 唯一能拦住的就是「票里 uid ≠ 当前登录用户」。
  // 这里用**未经篡改**的真实 alice 票据 + bob 的合法会话 cookie —— 最贴近真实泄露。
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  assert.ok(f, '需要 apk 那条')
  const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID_OTHER) })
  assert.equal(r.status, 403, 'uid 与登录用户不符必须 403')
})

test('B14 直链不激活、不限次：连续 3 次下载都成功', async () => {
  const f = filesJson.files.find((x) => x.name === 'DSH-PostAPI-v0.3.0.apk')
  for (let i = 0; i < 3; i++) {
    const r = await request(port, f.downloadUrl, { cookie: cookieOf(SID) })
    assert.equal(r.status, 200, '第 ' + (i + 1) + ' 次')
    assert.deepEqual(r.body, F_CONTENT)
  }
})

test('B15 回环 + Bearer 兜底**不适用**于 /dl（票绑真实 uid）', async () => {
  const f = filesJson.files[0]
  // 回环地址 + 正确 Bearer，但没有会话 cookie
  const r = await request(port, f.downloadUrl, { headers: { authorization: 'Bearer gw-token' } })
  assert.equal(r.status, 401, '/dl 不接受伪身份兜底')
})

test('B16 /file-ticket 端点行为未变（仍签发 /file/<token> + activateDeadline）', async () => {
  const body = JSON.stringify({ sessionId: SID, seq: 10, index: 0 })
  const res = await new Promise((resolve, reject) => {
    const q = http.request({
      host: '127.0.0.1', port, path: '/api/dsh/v1/file-ticket', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        cookie: cookieOf(SID),
        'user-agent': MOBILE_UA,
      },
    }, (r) => {
      const cs = []
      r.on('data', (c) => cs.push(c))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString() }))
    })
    q.on('error', reject)
    q.end(body)
  })
  assert.equal(res.status, 200, res.body.slice(0, 300))
  const j = JSON.parse(res.body)
  assert.match(j.url, /\/file\//, 'file-ticket 仍签发 /file/<token>（不动）')
  assert.ok(j.activateDeadline, 'file-ticket 仍返回 activateDeadline（不动）')
})

test('teardown', async () => { await new Promise((r) => server.close(r)) })
