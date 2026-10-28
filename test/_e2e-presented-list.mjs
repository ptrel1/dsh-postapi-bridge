// v0.12.0 presented 清单接口端到端（一次性）：桩 ctx + 假会话 + 临时文件 + 真实 HTTP。
// 不触碰 3080；DSH_HOME 指向临时目录。
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { apply } from '../lib/index.js'

const TMP = mkdtempSync(join(tmpdir(), 'postapi-pl-'))
process.env.DSH_HOME = join(TMP, 'dshhome')
const AUDIT = join(TMP, 'audit')

const { UsersStore, SessionsStore } = await import('../lib/users-store.js')
const ALICE = 'pl_alice_' + Date.now().toString(36)
const PASS = 'P' + Math.random().toString(36).slice(2) + '!'
new UsersStore().create({ username: ALICE, password: PASS, role: 'user' })

const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
const BIG = 300 * 1024 * 1024
writeFileSync(join(WS, 'a.txt'), 'hello a')
writeFileSync(join(WS, '报告.docx'), 'doc-content')
mkdirSync(join(WS, 'sub')); writeFileSync(join(WS, 'sub', 'deep.txt'), 'deep')
writeFileSync(join(TMP, 'outside.txt'), 'secret')
symlinkSync(join(TMP, 'outside.txt'), join(WS, 'escape.txt'))
mkdirSync(join(WS, 'adir'))

const SID = 'pl-sess-' + Date.now().toString(36)
const mk = (seq, files, turn, time) => ({ type: 'deliverables/presented', seq, time, data: { turn, callId: 'c' + seq, files } })
const EVENTS = [
  { type: 'user/message', seq: 1, time: 1000, data: {} },
  mk(1781, [{ path: 'a.txt', description: '测试文件' }], 33, 1792636949516),
  { type: 'assistant/message', seq: 2000, time: 2000, data: {} },
  mk(2365, [
    { path: '报告.docx' },
    { path: 'sub/deep.txt', description: '深层' },
    { path: 'escape.txt' },        // 符号链接逃逸 → 跳过
    { path: 'adir' },              // 目录 → 跳过
    { path: 'missing.txt' },       // 不存在 → 跳过
    { path: '' },                  // 空 path → 丢弃
    { path: '../outside.txt' },    // ../ 逃逸 → 跳过
  ], 41, 1792638000000),
]

const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  settings: { get: () => undefined },
  effect (fn) { fn() },
  provide () {},
  on () { return () => {} },
  agents: {},
  // v1.0.2：插件通过 ctx.get('sessionQuery') 取服务（未 inject 时直接读属性会 throw）。
  // 桩同时保留 sessionQuery 属性与 get()，两种访问方式都能工作。
  get (name) { return this[name] },
  sessionQuery: {
    // ⚠️ v1.0.3：真实 listEvents **不返回 data**（官方 SessionEventRecord 无 data 字段）。
    // 桩必须如实模拟，否则「报文里 data 恒为 undefined」这个 bug 测不出来。
    async listEvents (sessionId) {
      if (sessionId !== SID) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      return EVENTS.map(e => ({ sessionId, seq: e.seq, type: e.type, time: e.time, surface: 'main' }))
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
const SECRET = 'pl-secret-' + Date.now()
apply(ctx, { sessionSecret: SECRET, apiToken: 'pl-gw-token', accessLogDir: AUDIT })

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  for (const r of routes) {
    if (r.kind === 'exact' && p === r.path) return r.handler(req, res)
    if (r.kind === 'prefix' && req.url.startsWith(r.path)) return r.handler(req, res)
  }
  res.writeHead(404).end('no route')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:' + server.address().port

const sid0 = 'sid-' + Math.random().toString(36).slice(2)
new SessionsStore().create(sid0, ALICE, 'user', 3600_000, { ipPrefix: '127.0', uaClass: 'other', uaHash: 'x' })
const COOKIE = sid0 + '.' + createHmac('sha256', SECRET).update(sid0).digest('hex')

function req (path, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + path, { method: 'GET', headers: { 'user-agent': 'n', authorization: 'Bearer pl-gw-token', ...(cookie ? { cookie: 'dsh_postapi_session=' + cookie } : {}) } }, (res) => {
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString() }))
    })
    r.on('error', reject); r.end()
  })
}

let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('  ✔ ' + n) } else { fail++; console.log('  ✖ ' + n + (d ? '  → ' + d : '')) } }

console.log('== 1. 正常清单 ==')
{
  const r = await req('/api/dsh/v1/files?sessionId=' + SID, { cookie: COOKIE })
  const j = r.status === 200 ? JSON.parse(r.body) : null
  check('200', r.status === 200, r.status + ' ' + r.body.slice(0, 200))
  if (j) {
    check('ok=true 且带 sessionId', j.ok === true && j.sessionId === SID)
    check('只有 3 个合格文件（其余被跳过）', j.files.length === 3, 'n=' + j.files.length + ' ' + JSON.stringify(j.files.map(f => f.name)))
    check('按 seq 倒序（2365 在 1781 前）', j.files[0].seq === 2365 && j.files[j.files.length - 1].seq === 1781,
      JSON.stringify(j.files.map(f => f.seq)))
    check('skipped 计数正确（4 项）', j.skipped === 4, 'skipped=' + j.skipped + ' ' + JSON.stringify(j.skippedReasons))
    const f0 = j.files[0]
    check('条目含 seq/index/turn/time/name/size/ticketUrl',
      Number.isInteger(f0.seq) && Number.isInteger(f0.index) && Number.isInteger(f0.turn)
      && Number.isInteger(f0.time) && typeof f0.name === 'string' && Number.isInteger(f0.size)
      && f0.ticketUrl === '/api/dsh/v1/file-ticket', JSON.stringify(f0))
    check('path 为绝对路径', f0.path.startsWith('/'), f0.path)
    check('name 为 basename', j.files.some(f => f.name === '报告.docx'), JSON.stringify(j.files.map(f => f.name)))
    check('返回体不含 token', !/token/i.test(r.body.replace(/ticketUrl/g, '')), 'leak')
  }
}

console.log('== 1b. 【v1.0.1】/files?sessionId= 真正拿到数据（核心验证） ==')
{
  // 这是关键验证：参数名必须是 sessionId（sid 是宿主网关保留名，会被拦成空白 400）。
  // 本用例证明 handler 能完整跑完并返回文件列表。
  const r = await req('/api/dsh/v1/files?sessionId=' + SID, { cookie: COOKIE })
  const j = r.status === 200 ? JSON.parse(r.buf ? r.buf.toString() : r.body) : null
  check('/files?sessionId=<真实会话> → 200', r.status === 200, String(r.status))
  check('返回 ok=true 且 files 非空', !!j && j.ok === true && Array.isArray(j.files) && j.files.length > 0,
    JSON.stringify(j && { ok: j.ok, n: j.files && j.files.length }))
  check('条目含 name/size/seq/index', !!j && j.files.every(f =>
    typeof f.name === 'string' && Number.isInteger(f.size) && Number.isInteger(f.seq) && Number.isInteger(f.index)),
    JSON.stringify(j && j.files && j.files[0]))
}

console.log('== 1c. 【v1.0.1】保留名 sid 不再被接受（应报缺 sessionId） ==')
{
  // 真实环境里 ?sid= 会被宿主网关拦成空白 400（请求到不了我们，这是 v1.0.0 判反的根源）。
  // 本测试是桩 ctx、没有宿主网关，所以会到我们的 handler → 报 'Missing required query param: sessionId'。
  // 两种结果都证明「sid 不是本插件接受的参数名」。
  const r = await req('/api/dsh/v1/files?sid=' + SID, { cookie: COOKIE })
  const body = r.buf ? r.buf.toString() : r.body
  check('?sid= 不被当作有效参数', r.status === 400 && body.includes('sessionId'),
    r.status + ' ' + body.slice(0, 160))
}
console.log('== 2. 鉴权 ==')
{
  // v0.12.1：本文件的 req() 默认带 Bearer，且请求来自 127.0.0.1（严格回环），
  // 因此会命中「回环 + Bearer 兜底」→ 200。要验证「无凭据被拒」，必须同时去掉 Bearer。
  const r = await new Promise((resolve, reject) => {
    const q = http.request(BASE + '/api/dsh/v1/files?sessionId=' + SID, { method: 'GET', headers: { 'user-agent': 'n' } }, (res) => {
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString() }))
    })
    q.on('error', reject); q.end()
  })
  check('无 cookie 无 Bearer → 401', r.status === 401, String(r.status) + ' ' + r.body.slice(0, 100))
}
{
  const r = await req('/api/dsh/v1/files', { cookie: COOKIE })
  check('缺 sessionId → 400', r.status === 400, String(r.status) + ' ' + r.body.slice(0, 100))
}
{
  const r = await req('/api/dsh/v1/files?sessionId=nope', { cookie: COOKIE })
  check('会话不存在 → 404', r.status === 404, String(r.status))
}

console.log('== 3. skippedReasons 明细 ==')
{
  const r = await req('/api/dsh/v1/files?sessionId=' + SID, { cookie: COOKIE })
  const j = JSON.parse(r.body)
  const reasons = JSON.stringify(j.skippedReasons)
  check('记录 path-escape（符号链接/../）', /path-escape/.test(reasons), reasons)
  check('记录 path-not-file（目录）', /path-not-file/.test(reasons) || /path-missing/.test(reasons), reasons)
}

console.log('== 4. 审计 ==')
{
  const text = readFileSync(join(AUDIT, 'access-log.jsonl'), 'utf8')
  check('记录 files-list', text.includes('"event":"files-list"'))
  // 逐行解析而不是正则跨字段匹配：审计是 JSONL，字段顺序不作为契约
  const plLine = text.split('\n').filter(l => l.includes('"event":"files-list"')).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).pop()
  check('审计含 sid / files / skipped 字段',
    !!plLine && plLine.sid === SID && Number.isInteger(plLine.files) && Number.isInteger(plLine.skipped),
    JSON.stringify(plLine))
  check('审计含 skippedReasons 明细', !!plLine && !!plLine.skippedReasons && Object.keys(plLine.skippedReasons).length > 0,
    JSON.stringify(plLine && plLine.skippedReasons))
  check('审计不含 token', !/"token"/.test(text))
}

console.log('== 5. sessionQuery 缺失 → 503 ==')
{
  const routes2 = []
  const ctx2 = { ...ctx, sessionQuery: undefined, get (name) { return this[name] }, webServer: { tapIndex: () => () => {}, register (r) { routes2.push(r); return () => {} } } }
  apply(ctx2, { sessionSecret: SECRET, apiToken: 'pl-gw-token', accessLogDir: join(TMP, 'audit2') })
  const s2 = http.createServer((q, s) => { for (const r of routes2) { if (r.kind === 'prefix' && q.url.startsWith(r.path)) return r.handler(q, s) } s.writeHead(404).end('') })
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  const B2 = 'http://127.0.0.1:' + s2.address().port
  const res = await new Promise((resolve) => {
    const q = http.request(B2 + '/api/dsh/v1/files?sessionId=' + SID, { headers: { authorization: 'Bearer pl-gw-token', cookie: 'dsh_postapi_session=' + COOKIE } }, (r) => { const cs = []; r.on('data', c => cs.push(c)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(cs).toString() })) })
    q.end()
  })
  check('sessionQuery 缺失 → 503', res.status === 503, res.status + ' ' + res.body.slice(0, 120))
  s2.close()
}

server.close()
console.log('\n结果: pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
