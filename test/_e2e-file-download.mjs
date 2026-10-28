// v0.9.0 file ticket 端到端（一次性）：桩 ctx + 假会话 + 临时文件 + 真实 HTTP。
// 不触碰 3080；DSH_HOME 指向临时目录。所有时间用例走 config.now 注入，无 sleep。
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { apply, __fileTicketHelpers } from '../lib/index.js'

const TMP = mkdtempSync(join(tmpdir(), 'postapi-fd3-'))
process.env.DSH_HOME = join(TMP, 'dshhome')
const AUDIT = join(TMP, 'audit')
const TICKET_FILE = join(AUDIT, 'file-tickets.json')

const { UsersStore, SessionsStore } = await import('../lib/users-store.js')
const ALICE = 'e2e_alice_' + Date.now().toString(36)
const BOB = 'e2e_bob_' + Date.now().toString(36)
const PASS = 'P' + Math.random().toString(36).slice(2) + '!'
const us = new UsersStore()
us.create({ username: ALICE, password: PASS, role: 'user' })
us.create({ username: BOB, password: PASS, role: 'user' })

const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
const SIZE = 5000
const CONTENT = Buffer.from(Array.from({ length: SIZE }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''), 'utf8')
const FILE = join(WS, '报告 2026.docx')
writeFileSync(FILE, CONTENT)
const OUTSIDE = join(TMP, 'outside-secret.txt')
writeFileSync(OUTSIDE, 'TOP SECRET')
symlinkSync(OUTSIDE, join(WS, 'escape-link.txt'))
mkdirSync(join(WS, 'a-directory'))

const SESSION_ID = 'e2e-session-' + Date.now().toString(36)
const PRESENT_EVENT = {
  type: 'deliverables/presented', seq: 7, time: Date.now(),
  data: { turn: 2, callId: 'call-1', files: [{ path: '报告 2026.docx', description: '报告' }] },
}

let NOW = 1700000000000
const H = 3600 * 1000
const advance = (ms) => { NOW += ms }

function makeCtx () {
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    settings: { get: () => undefined },
    effect (fn) { fn() },
    provide () {},
    on () { return () => {} },
    agents: {},
    // v1.0.2：插件通过 ctx.get('sessionQuery') 取服务（未 inject 时直接读属性会 throw）
    get (name) { return this[name] },
    sessionQuery: {
      async readEvent ({ sessionId, seq }) {
        if (sessionId !== SESSION_ID) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
        if (seq !== PRESENT_EVENT.seq) throw new Error('SESSION_QUERY_EVENT_NOT_FOUND')
        return { session: { id: SESSION_ID, cwd: WS }, target: PRESENT_EVENT, events: [PRESENT_EVENT], inheritedEventCount: 0, startSeq: 7, endSeq: 7 }
      },
    },
    webServer: {
      tapIndex: () => () => {},
      register ({ kind, path, handler }) { routes.push({ kind, path, handler }); return () => {} },
    },
  }
  return { ctx, routes }
}

const SECRET = 'e2e-fd-secret-' + Date.now()
const APP_CONFIG = {
  sessionSecret: SECRET,
  apiToken: 'e2e-gateway-token',
  accessLogDir: AUDIT,
  now: () => NOW,
}

function bootServer () {
  const { ctx, routes } = makeCtx()
  apply(ctx, APP_CONFIG)
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    for (const r of routes) {
      if (r.kind === 'exact' && p === r.path) return r.handler(req, res)
      if (r.kind === 'prefix' && req.url.startsWith(r.path)) return r.handler(req, res)
    }
    res.writeHead(404).end('no route')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

let { server, port } = await bootServer()
let BASE = 'http://127.0.0.1:' + port

function issueSession (username, role) {
  const sid = 'sid-' + username + '-' + Math.random().toString(36).slice(2)
  new SessionsStore().create(sid, username, role, 3600_000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })
  return sid + '.' + createHmac('sha256', SECRET).update(sid).digest('hex')
}
const ALICE_COOKIE = issueSession(ALICE, 'user')
const BOB_COOKIE = issueSession(BOB, 'user')

function req (method, path, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request(BASE + path, {
      method,
      headers: {
        'user-agent': 'node-e2e',
        authorization: 'Bearer e2e-gateway-token',
        ...(cookie ? { cookie: 'dsh_postapi_session=' + cookie } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

let pass = 0, fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name) }
  else { fail++; console.log('  ✖ ' + name + (detail ? '  → ' + detail : '')) }
}
// 注意：签发响应**不再包含** ticketId（内部状态键不外泄）。
// 本测试需要按 tid 查状态文件来断言服务端行为，故在 helper 里从状态文件按
// (sid,seq,index,issuedAt) 反查 —— 这是「测试站在服务端视角」，不是客户端能力。
const issue = async (cookie = ALICE_COOKIE) => {
  const before = new Set(Object.keys(readStore().tickets))
  const r = await req('POST', '/api/dsh/v1/file-ticket', { cookie, body: { sessionId: SESSION_ID, seq: 7, index: 0 } })
  if (r.status !== 200) return { status: r.status, raw: r.buf.toString() }
  const j = JSON.parse(r.buf.toString())
  // 新出现的键就是本次签发的 tid
  const after = Object.keys(readStore().tickets)
  const tid = after.find(k => !before.has(k))
  // body 保留服务端原始响应（用于断言「响应体不含某字段」），其余是测试侧的附加信息
  return { status: 200, body: j, token: j.url.split('/file/')[1], tid }
}
const dl = (token, cookie = ALICE_COOKIE, headers = {}) => req('GET', '/api/dsh/v1/file/' + token, { cookie, headers })
// 首次签发前文件尚不存在（store 只在有内容时才落盘）→ 视为空库
const readStore = () => {
  try { return JSON.parse(readFileSync(TICKET_FILE, 'utf8')) } catch { return { v: 1, tickets: {} } }
}

console.log('== 1. 未激活且 issuedAt 未超 48h → 200 ==')
{
  advance(1000)
  const t = await issue()
  check('签发 200 且返回语义字段',
    t.status === 200 && typeof t.body.activateDeadline === 'number'
    && t.body.activateWindowHours === 48 && t.body.sessionHours === 5,
    JSON.stringify(t.body).slice(0, 240))
  check('activateDeadline = issuedAt + 48h',
    t.body.activateDeadline === t.body.issuedAt + 48 * H, t.body.activateDeadline + ' vs ' + (t.body.issuedAt + 48 * H))
  check('expiresAt 兼容字段 = activateDeadline（语义为待激活截止，非下载有效期）',
    t.body.expiresAt === t.body.activateDeadline, t.body.expiresAt + ' vs ' + t.body.activateDeadline)
  // 关键：响应体不得暴露内部状态键 ticketId（可被用于「票据是否存在」探测）
  check('响应体不含 ticketId', !('ticketId' in t.body), Object.keys(t.body).join(','))
  check('响应体不含 tid 字段', !('tid' in t.body), Object.keys(t.body).join(','))
  check('状态文件里该票 activatedAt 初始为 null',
    !!t.tid && readStore().tickets[t.tid].activatedAt === null, String(t.tid))
  check('状态文件结构为 { v, tickets }', readStore().v === 1 && typeof readStore().tickets === 'object')
  const r = await dl(t.token)
  check('首次下载 200 且字节一致', r.status === 200 && Buffer.compare(r.buf, CONTENT) === 0, 'status=' + r.status + ' len=' + r.buf.length)
  check('首次下载写入 activatedAt', readStore().tickets[t.tid].activatedAt === NOW, String(readStore().tickets[t.tid].activatedAt))
}

console.log('== 2. 未激活且注入 now 使 issuedAt 超 48h → 410 ==')
{
  const t = await issue()
  const saved = NOW
  NOW = t.body.issuedAt + 48 * H
  const r = await dl(t.token)
  check('48h 到点（含）→ 410', r.status === 410, r.status + ' ' + r.buf.toString().slice(0, 100))
  NOW = t.body.issuedAt + 48 * H - 1
  const r2 = await dl(t.token)
  check('48h 前 1ms → 200', r2.status === 200, String(r2.status))
  NOW = saved
}

console.log('== 3. 激活后注入 now：+5h-1s → 200；+5h → 410 ==')
{
  const t = await issue()
  await dl(t.token)
  const act = readStore().tickets[t.tid].activatedAt
  const saved = NOW
  NOW = act + 5 * H - 1000
  check('activatedAt+5h-1s → 200', (await dl(t.token)).status === 200)
  NOW = act + 5 * H
  const r = await dl(t.token)
  check('activatedAt+5h → 410', r.status === 410, r.status + ' ' + r.buf.toString().slice(0, 100))
  NOW = saved
}

console.log('== 4. 5h 内重复下载 3 次 → 全部 200（不限次数） ==')
{
  const t = await issue()
  const r1 = await dl(t.token)
  const r2 = await dl(t.token)
  const r3 = await dl(t.token)
  check('三次全部 200', r1.status === 200 && r2.status === 200 && r3.status === 200, [r1.status, r2.status, r3.status].join('/'))
  check('三次内容都完整', [r1, r2, r3].every(r => Buffer.compare(r.buf, CONTENT) === 0))
  check('激活时刻未被后续请求改写', readStore().tickets[t.tid].activatedAt <= NOW)
}

console.log('== 5. 5h 内 Range 分段 2 次 → 都成功（非一次性） ==')
{
  const t = await issue()
  const r1 = await dl(t.token, ALICE_COOKIE, { range: 'bytes=0-999' })
  check('第一段 206 / 1000 字节', r1.status === 206 && r1.buf.length === 1000, r1.status + ' len=' + r1.buf.length)
  const r2 = await dl(t.token, ALICE_COOKIE, { range: 'bytes=1000-' })
  check('第二段 206 / 剩余字节', r2.status === 206 && r2.buf.length === SIZE - 1000, r2.status + ' len=' + r2.buf.length)
  check('Content-Range 正确', r2.headers['content-range'] === 'bytes 1000-' + (SIZE - 1) + '/' + SIZE, r2.headers['content-range'])
  const r3 = await dl(t.token)
  check('分段后再整份下载仍 200（无消费概念）', r3.status === 200 && r3.buf.length === SIZE, String(r3.status))
  check('416：区间不可满足且带 Content-Range',
    (await dl(t.token, ALICE_COOKIE, { range: 'bytes=99999-' })).headers['content-range'] === 'bytes */' + SIZE)
}

console.log('== 6. tid 不在库里（签名合法）→ 410 ==')
{
  const ghost = __fileTicketHelpers.signFileTicket({ v: 2, tid: 'deadbeefdeadbeef', sid: SESSION_ID, seq: 7, index: 0, uid: ALICE }, SECRET).token
  const r = await dl(ghost)
  check('签名合法但 tid 不存在 → 410', r.status === 410, r.status + ' ' + r.buf.toString().slice(0, 100))
}

console.log('== 7. 记录被篡改（token 与记录不一致）→ 403 ==')
{
  const t = await issue()
  // 直接改状态文件里该 tid 的 sid（模拟运维误改/旧票换新记录）
  const st = readStore()
  st.tickets[t.tid].sid = 'tampered-session-id'
  writeFileSync(TICKET_FILE, JSON.stringify(st))
  // mtime 变化 → store 惰性重读
  const r = await dl(t.token)
  check('token 与记录 sid 不一致 → 403', r.status === 403, r.status + ' ' + r.buf.toString().slice(0, 100))
  st.tickets[t.tid].sid = SESSION_ID
  writeFileSync(TICKET_FILE, JSON.stringify(st))
}

console.log('== 8. 并发两次首次请求 → activatedAt 只有一个值且不覆盖 ==')
{
  const t = await issue()
  check('激活前为 null', readStore().tickets[t.tid].activatedAt === null)
  const [a, b] = await Promise.all([dl(t.token), dl(t.token)])
  check('两个并发请求都 200', a.status === 200 && b.status === 200, a.status + '/' + b.status)
  const act = readStore().tickets[t.tid].activatedAt
  check('activatedAt 只有一个值', typeof act === 'number' && act === NOW, String(act))
  // 再等 1s 后第三次请求，不得改写 activatedAt
  advance(1000)
  await dl(t.token)
  check('后续请求不覆盖 activatedAt', readStore().tickets[t.tid].activatedAt === act)
}

console.log('== 9. 重启后状态仍在（重新 apply 读同一文件） ==')
{
  const t = await issue()
  await dl(t.token)
  const beforeRestart = readStore().tickets[t.tid]
  check('重启前 activatedAt 已写', typeof beforeRestart.activatedAt === 'number')
  await new Promise((r) => server.close(r))
  const restarted = await bootServer()
  server = restarted.server
  BASE = 'http://127.0.0.1:' + restarted.port
  const afterRestart = readStore().tickets[t.tid]
  check('重启后记录仍在', !!afterRestart, 'tid=' + t.tid)
  check('重启后 activatedAt 不变', afterRestart.activatedAt === beforeRestart.activatedAt)
  const r = await dl(t.token, ALICE_COOKIE)
  check('重启后同一 token 仍可下载（状态持久，非内存）', r.status === 200, r.status + ' ' + r.buf.toString().slice(0, 100))
}

console.log('== 10. cleanup：删过期票、留未过期票、文件本身不动 ==')
{
  const saved = NOW
  advance(1000)
  const pending = await issue()          // 待激活，将被 48h 超期
  const active = await issue()           // 已激活，将被 5h 超期
  await dl(active.token)
  const activeAct = readStore().tickets[active.tid].activatedAt
  // 推进到两者都过期之后
  NOW = Math.max(pending.body.issuedAt + 49 * H, activeAct + 6 * H)
  const fresh = await issue()            // 此刻新签 → 应保留（签发时顺带 cleanup）
  const st = readStore()
  check('48h 未激活的票被删', st.tickets[pending.tid] === undefined)
  check('激活超 5h 的票被删', st.tickets[active.tid] === undefined)
  check('未超期的新票保留', !!st.tickets[fresh.tid])
  check('源文件仍在磁盘上（只清票据，不碰文件）', existsSync(FILE) && statSync(FILE).size === SIZE)
  check('源文件内容未变', Buffer.compare(readFileSync(FILE), CONTENT) === 0)
  // 被清理的票再访问 → 410
  check('被清理的票再访问 → 410', (await dl(pending.token)).status === 410)
  NOW = saved
}

console.log('== 11. 过期后重新签发 → 新票可用（唯一续期路径） ==')
{
  const t = await issue()
  await dl(t.token)
  const saved = NOW
  NOW = readStore().tickets[t.tid].activatedAt + 6 * H   // 过期
  check('旧票 410', (await dl(t.token)).status === 410)
  const t2 = await issue()
  check('重新签发得到不同的内部票据（ticketId 不同，测试侧从状态文件反查）', t2.tid !== t.tid)
  const r = await dl(t2.token)
  check('新票可正常下载 200', r.status === 200 && Buffer.compare(r.buf, CONTENT) === 0, String(r.status))
  NOW = saved
}

console.log('== 12. 鉴权与路径安全（沿用旧语义） ==')
{
  const t = await issue()
  check('无 cookie → 401', (await req('GET', '/api/dsh/v1/file/' + t.token)).status === 401)
  check('别人（uid 不符）→ 403', (await dl(t.token, BOB_COOKIE)).status === 403)
  const [bp, sig] = t.token.split('.')
  const badSig = createHmac('sha256', 'wrong-secret').update(bp).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  check('错误 secret 重签 → 403', (await dl(bp + '.' + badSig)).status === 403)
  check('结构非法 → 403', (await dl('garbage.token')).status === 403)
  check('Accept-Ranges: bytes', (await dl(t.token)).headers['accept-ranges'] === 'bytes')
  const d = await dl(t.token)
  check('RFC5987 中文文件名编码',
    /^attachment; filename\*=UTF-8''%E6%8A%A5%E5%91%8A%202026\.docx$/.test(d.headers['content-disposition'] || ''),
    d.headers['content-disposition'])
}
{
  const orig = PRESENT_EVENT.data.files[0].path
  PRESENT_EVENT.data.files[0].path = 'escape-link.txt'
  check('签发阶段符号链接逃逸 → 403', (await issue()).status === 403)
  PRESENT_EVENT.data.files[0].path = 'a-directory'
  const r = await issue()
  check('签发阶段目录 → 4xx', r.status === 404 || r.status === 403, String(r.status))
  PRESENT_EVENT.data.files[0].path = orig
}

console.log('== 13. 审计 ==')
{
  const text = readFileSync(join(AUDIT, 'access-log.jsonl'), 'utf8')
  for (const ev of ['file-ticket-issued', 'file-ticket-activated', 'file-download', 'file-download-denied']) {
    check('记录事件 ' + ev, text.includes('"event":"' + ev + '"'))
  }
  check('file-ticket-issued 记 tid（tid 不是凭据）', /"event":"file-ticket-issued".*"tid":"[0-9a-f]{16}"/.test(text))
  check('file-ticket-activated 记 tid/uid/activatedAt', /"event":"file-ticket-activated".*"activatedAt":\d+/.test(text))
  check('审计不含 token 本体（subPath 已脱敏）', !/"subPath":"\/file\/[A-Za-z0-9_.-]{20,}/.test(text))
  check('拒绝事件带 reason', /"event":"file-download-denied".*"reason":"(ticket-missing|ticket-mismatch|session-window-elapsed|activate-window-elapsed|uid-mismatch|not-authenticated)"/.test(text))
}

await new Promise((r) => server.close(r))
console.log('\n结果: pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
