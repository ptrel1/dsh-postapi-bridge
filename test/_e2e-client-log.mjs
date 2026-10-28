// v1.4.0 端到端自测：POST /client-log（免鉴权日志上报）。
// 运行：node test/_e2e-client-log.mjs（也可 `node --test test/*.mjs` 一并跑）
//
// 覆盖：
//   A. 免鉴权：无 cookie、无 Bearer、非回环也能 200（这是本功能的**存在理由**）
//   B. 正常上报 → 200 + 文件已创建（路径/命名/结构）
//   C. 超过 256KB → 413
//   D. 超限频（同 IP 第 21 次）→ 429
//   E. 脱敏：token=abc123 / dsh_postapi_session=xyz 等**原文不得出现在写盘文件里**
//   F. entries > 200 → 截断为 200，且保留**最新**的
//   G. 字段白名单：多余字段被丢弃
//   H. 目录超 50MB → 删最旧文件；文件数超 50 → 删最旧
// 全部使用一次性临时 DSH_HOME，绝不写仓库、绝不碰 ~/.dsh 里的真实数据。
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

process.env.DSH_HOME = '/tmp/postapi-clientlog-e2e-' + Date.now()
const AUDIT_DIR = process.env.DSH_HOME + '/audit'
const LOG_DIR = AUDIT_DIR + '/client-logs'

const routes = []
const logs = []
const ctx = {
  logger: { info: (m) => { logs.push(String(m)) }, warn: () => {}, error: (m) => { logs.push('ERR ' + m) } },
  settings: { get: () => undefined },
  effect (fn) { fn() },
  provide () {},
  on () { return () => {} },
  agents: {},
  webServer: {
    tapIndex: () => () => {},
    register ({ kind, path, handler }) { routes.push({ kind, path, handler }); return () => {} },
  },
}
// apiToken 故意留空：验证 /client-log 在「机器通道整体 fail-fast」之前就被分流
apply(ctx, { sessionSecret: 'e2e-client-log-secret', apiToken: '', accessLogDir: AUDIT_DIR })

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

function req (method, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined
      : (typeof payload === 'string' ? payload : JSON.stringify(payload))
    const r = http.request(BASE + path, {
      method,
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 13; WebView) test',
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }))
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

let pass = 0, fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name) }
  else { fail++; console.log('  ✖ ' + name + (detail ? '  → ' + detail : '')) }
}
const listLogs = () => { try { return readdirSync(LOG_DIR).filter((n) => n.endsWith('.json')) } catch { return [] } }
const readNewest = () => {
  const files = listLogs().map((n) => ({ n, m: statSync(join(LOG_DIR, n)).mtimeMs }))
  files.sort((a, b) => b.m - a.m)
  return files.length ? JSON.parse(readFileSync(join(LOG_DIR, files[0].n), 'utf8')) : null
}
const samplePayload = (over) => ({
  source: 'app',
  kind: 'snapshot',
  ua: 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  env: { screen: [390, 844], dpr: 3, deviceMemory: 4, hardwareConcurrency: 8, supports: { webgl: true, compression: false } },
  entries: [{ t: 1792661621796, level: 'warn', kind: 'longtask', duration: 320, msg: 'longtask 320ms' }],
  ...over,
})

console.log('== A. 免鉴权（无 cookie / 无 Bearer / 非回环）==')
let firstBody
{
  // X-Forwarded-For 末尾跳 = 非回环 IP：模拟手机经 nginx 进来；且不带任何 cookie/Authorization
  const r = await req('POST', '/api/dsh/v1/client-log', samplePayload(), { 'x-forwarded-for': '203.0.113.7' })
  firstBody = r.status === 200 ? JSON.parse(r.body) : null
  check('无 cookie / 无 Bearer / 非回环 → 200（免鉴权真的生效）', r.status === 200 && firstBody?.ok === true,
    r.status + ' ' + r.body)
  // v1.4.1：文件名 = <YYYYMMDD-HHMMSS-mmm>-<16 位随机 hex>.json（毫秒 + 随机，同秒不撞）
  check('响应含 stored/file 字段', firstBody?.stored === true && /^\d{8}-\d{6}-\d{3}-[0-9a-f]{16}\.json$/.test(firstBody?.file || ''),
    JSON.stringify(firstBody))
}
{
  // 反证：同前缀的机器方法仍 fail-closed（证明只放行了 /client-log）
  const r = await req('POST', '/api/dsh/v1/task', { prompt: 'x' }, { 'x-forwarded-for': '203.0.113.7' })
  check('同前缀其它方法仍 fail-closed（503）', r.status === 503, 'status=' + r.status)
  const g = await req('GET', '/api/dsh/v1/client-log', undefined, { 'x-forwarded-for': '203.0.113.7' })
  check('GET 同名路径不放行（不进入日志分支）', g.status !== 200, 'status=' + g.status)
}

console.log('== B. 文件确实创建且结构正确 ==')
{
  const f = firstBody?.file ? join(LOG_DIR, firstBody.file) : ''
  check('文件存在于 client-logs 目录', !!f && existsSync(f), f)
  const rec = f ? JSON.parse(readFileSync(f, 'utf8')) : null
  check('v=1 且有 receivedAt', rec?.v === 1 && typeof rec?.receivedAt === 'string', JSON.stringify(rec && rec.v))
  check('source/kind 原样保存', rec?.source === 'app' && rec?.kind === 'snapshot', JSON.stringify([rec?.source, rec?.kind]))
  check('env 字段完整（screen/dpr/deviceMemory/hardwareConcurrency/supports）',
    Array.isArray(rec?.env?.screen) && rec.env.screen[0] === 390 && rec.env.screen[1] === 844
    && rec.env.dpr === 3 && rec.env.deviceMemory === 4 && rec.env.hardwareConcurrency === 8
    && rec.env.supports.webgl === true && rec.env.supports.compression === false,
    JSON.stringify(rec?.env))
  check('entries 落盘（t/level/kind/duration/msg）',
    rec?.entries?.length === 1 && rec.entries[0].duration === 320 && rec.entries[0].level === 'warn',
    JSON.stringify(rec?.entries))
  check('ua 落盘', typeof rec?.ua === 'string' && rec.ua.includes('Android'), rec?.ua)
}

console.log('== C. 超过 256KB → 413 ==')
{
  const big = 'x'.repeat(300 * 1024)
  const r = await req('POST', '/api/dsh/v1/client-log',
    JSON.stringify({ source: 'web', kind: 'flush', entries: [{ msg: big }] }),
    { 'x-forwarded-for': '203.0.113.8' })
  check('300KB body → 413', r.status === 413, r.status + ' ' + r.body)
  check('413 文案点明上限', /max 262144 bytes/.test(r.body), r.body)
}

console.log('== D. 每 IP 每小时 20 次 → 第 21 次 429 ==')
{
  const H = { 'x-forwarded-for': '198.51.100.5' }
  const codes = []
  for (let i = 0; i < 20; i++) {
    const r = await req('POST', '/api/dsh/v1/client-log', samplePayload({ kind: 'flush' }), H)
    codes.push(r.status)
  }
  const r21 = await req('POST', '/api/dsh/v1/client-log', samplePayload({ kind: 'flush' }), H)
  check('前 20 次全部 200', codes.every((c) => c === 200), JSON.stringify(codes))
  check('第 21 次 → 429', r21.status === 429, r21.status + ' ' + r21.body)
  // 另一个 IP 不受影响（限流是按 IP 的，不是全局）
  const other = await req('POST', '/api/dsh/v1/client-log', samplePayload({ kind: 'flush' }), { 'x-forwarded-for': '198.51.100.6' })
  check('换 IP 不受影响（仍是 200）', other.status === 200, String(other.status))
  const audit = readFileSync(join(AUDIT_DIR, 'access-log.jsonl'), 'utf8')
  check('审计记录 client-log-throttled', audit.includes('"event":"client-log-throttled"'))
}

console.log('== E. 🔴 脱敏：原文不得写盘 ==')
{
  const secrets = [
    'token=abc123',
    'dsh_postapi_session=xyz',
    'password=hunter2',
    'Authorization: Bearer sk-live-DEADBEEF',
    'sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end',
    'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end',
  ]
  const payload = {
    source: 'web',
    kind: 'error',
    ua: 'Mozilla/5.0 token=abc123-in-ua',
    env: { screen: [1, 2] },
    entries: secrets.map((s, i) => ({
      t: 1792661621796 + i, level: 'error', kind: 'window.onerror',
      msg: 'boom ' + s,
      // extra 也必须递归脱敏（否则从这里漏）
      extra: { url: '/api/dsh/v1/x?token=abc123', headers: { authorization: 'Bearer sk-live-DEADBEEF' } },
    })),
  }
  const r = await req('POST', '/api/dsh/v1/client-log', payload, { 'x-forwarded-for': '203.0.113.9' })
  check('上报成功 200', r.status === 200, r.status + ' ' + r.body)
  const rec = readNewest()
  const disk = JSON.stringify(rec)
  for (const bad of ['abc123', 'xyz', 'hunter2', 'sk-live-DEADBEEF',
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']) {
    check('写盘文件不含原文片段: ' + bad.slice(0, 24), !disk.includes(bad))
  }
  check('确实做了替换（出现 <redacted>）', disk.includes('<redacted>'))
  check('保留了可读上下文（msg 前缀 boom 仍在）', disk.includes('boom'))
  check('保留了非敏感文本（end 仍在）', disk.includes('end'))
  // 审计日志里也不得出现原文（我们只记元信息）
  const audit = readFileSync(join(AUDIT_DIR, 'access-log.jsonl'), 'utf8')
  for (const bad of ['abc123', 'hunter2', 'sk-live-DEADBEEF']) {
    check('审计不含原文片段: ' + bad, !audit.includes(bad))
  }
  check('审计记录 client-log-received 且带 ip/kind/bytes/entries',
    /"event":"client-log-received"/.test(audit) && /"kind":"error"/.test(audit) && /"bytes":\d+/.test(audit),
    audit.split('\n').filter((l) => l.includes('client-log-received')).slice(-1)[0])
}

console.log('== F. entries > 200 → 截断且保留最新 ==')
{
  const entries = []
  for (let i = 0; i < 250; i++) {
    entries.push({ t: 1792661621796 + i, level: 'info', kind: 'fps', msg: 'seq-' + i })
  }
  const r = await req('POST', '/api/dsh/v1/client-log', samplePayload({ kind: 'flush', entries }),
    { 'x-forwarded-for': '203.0.113.10' })
  const body = r.status === 200 ? JSON.parse(r.body) : {}
  check('200 且 entries=200', r.status === 200 && body.entries === 200, r.status + ' ' + r.body)
  check('truncated=true', body.truncated === true, JSON.stringify(body))
  const rec = readNewest()
  check('落盘 200 条', rec?.entries?.length === 200, String(rec?.entries?.length))
  check('保留的是最新 50~249（首条 seq-50）', rec?.entries?.[0]?.msg === 'seq-50', rec?.entries?.[0]?.msg)
  check('末条是 seq-249', rec?.entries?.[199]?.msg === 'seq-249', rec?.entries?.[199]?.msg)
  check('meta 记录原始条数（截断不静默）', rec?.meta?.receivedEntries === 250 && rec?.meta?.keptEntries === 200,
    JSON.stringify(rec?.meta))
}

console.log('== G. 字段白名单：多余字段丢弃 ==')
{
  const r = await req('POST', '/api/dsh/v1/client-log', {
    source: 'web', kind: 'perf',
    ua: 'UA',
    evil: 'should-be-dropped',
    nested: { a: 1 },
    env: { screen: [10, 20], dpr: 2, secretField: 'drop-me', supports: { webgl: true, extra: true } },
    entries: [{ t: 1, level: 'info', kind: 'longtask', duration: 150, msg: 'ok', unexpected: 'drop-me-too' }],
  }, { 'x-forwarded-for': '203.0.113.11' })
  check('200', r.status === 200, String(r.status))
  const raw = readFileSync(join(LOG_DIR, JSON.parse(r.body).file), 'utf8')
  for (const bad of ['should-be-dropped', 'drop-me', 'drop-me-too', 'unexpected', 'secretField']) {
    check('多余字段被丢弃: ' + bad, !raw.includes(bad))
  }
  check('白名单字段保留', raw.includes('"duration": 150') || raw.includes('"duration":150'), raw.slice(0, 200))
}

console.log('== H. 目录上限：>50 文件 与 >50MB 都删最旧 ==')
{
  // H1：造 60 个「旧」文件（mtime 递减回拨），再上报一次触发清理
  mkdirSync(LOG_DIR, { recursive: true })
  const now = Date.now()
  const made = []
  for (let i = 0; i < 60; i++) {
    const name = 'old-' + String(i).padStart(3, '0') + '.json'
    const f = join(LOG_DIR, name)
    writeFileSync(f, '{"v":1}', 'utf8')
    const t = (now - (60 - i) * 60000) / 1000
    utimesSync(f, t, t)
    made.push(name)
  }
  // 触发一次清理：上报（用新 IP 避开限流）
  const before = listLogs().length
  await req('POST', '/api/dsh/v1/client-log', samplePayload({ kind: 'flush' }), { 'x-forwarded-for': '203.0.113.12' })
  const after = listLogs()
  check('清理前文件数 > 50', before > 50, String(before))
  check('清理后 ≤ 50', after.length <= 50, String(after.length))
  check('最旧的几个被删（old-000 已不在）', !after.includes('old-000.json'), JSON.stringify(after.slice(0, 3)))
  check('最新写的仍在（old-059.json）', after.includes('old-059.json'), JSON.stringify(after.slice(-3)))
}
{
  // H2：总量超 50MB —— 造 6 个 9MB 文件，然后上报一次
  for (const n of listLogs()) { try { rmSync(join(LOG_DIR, n)) } catch {} }
  const now = Date.now()
  const big = 'y'.repeat(9 * 1024 * 1024)
  for (let i = 0; i < 6; i++) {
    const f = join(LOG_DIR, 'big-' + i + '.json')
    writeFileSync(f, '{"v":1,"pad":"' + big + '"}', 'utf8')
    const t = (now - (6 - i) * 60000) / 1000
    utimesSync(f, t, t)
  }
  const sizeBefore = listLogs().reduce((s, n) => s + statSync(join(LOG_DIR, n)).size, 0)
  check('清理前总量 > 50MB', sizeBefore > 50 * 1024 * 1024, String(sizeBefore))
  const r = await req('POST', '/api/dsh/v1/client-log', samplePayload({ kind: 'flush' }), { 'x-forwarded-for': '203.0.113.13' })
  const sizeAfter = listLogs().reduce((s, n) => s + statSync(join(LOG_DIR, n)).size, 0)
  check('上报仍 200（清理不影响本次写入）', r.status === 200, r.status + ' ' + r.body)
  check('清理后总量 ≤ 50MB', sizeAfter <= 50 * 1024 * 1024, String(sizeAfter))
  check('最旧的大文件被删（big-0 不在）', !listLogs().includes('big-0.json'), JSON.stringify(listLogs()))
  check('最新的大文件被保留（big-5 在）', listLogs().includes('big-5.json'), JSON.stringify(listLogs()))
}

console.log('== I. 非法输入不炸 ==')
{
  const items = [
    ['空 body', ''],
    ['非 JSON', 'not-json{'],
    ['数组顶层', '[1,2,3]'],
    ['entries 非数组', JSON.stringify({ entries: 'nope' })],
  ]
  for (const [name, body] of items) {
    const r = await req('POST', '/api/dsh/v1/client-log', body, { 'x-forwarded-for': '203.0.113.14' })
    check(name + ' → 不 5xx 崩溃（400/200）', r.status === 400 || r.status === 200, String(r.status) + ' ' + r.body)
  }
}

console.log('== J. v1.4.1 回归：同一秒/同一毫秒内多次上报不得互相覆盖 ==')
{
  // 用**真实时钟**先打一轮并发（手机上 snapshot/perf/flush 就是这样同秒到达的）
  const before = new Set(listLogs())
  const TAGS = ['e2e-par-0', 'e2e-par-1', 'e2e-par-2', 'e2e-par-3', 'e2e-par-4']
  const res = await Promise.all(TAGS.map((tag) => req('POST', '/api/dsh/v1/client-log',
    samplePayload({ kind: 'flush', entries: [{ t: 1, level: 'info', kind: 'longtask', duration: 5, msg: 'TAG=' + tag }] }),
    { 'x-forwarded-for': '203.0.113.20' })))
  check('并发 5 次全部 200', res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.status)))
  const names = res.map((r) => JSON.parse(r.body).file)
  check('并发 5 次的文件名互不相同', new Set(names).size === 5, JSON.stringify(names))
  check('并发 5 次落在同一秒（场景成立）', new Set(names.map((n) => n.slice(0, 15))).size === 1, JSON.stringify(names))
  const added = listLogs().filter((n) => !before.has(n))
  check('目录新增 5 个文件（无覆盖）', added.length === 5, JSON.stringify(added))
  const tags = added.map((n) => String(JSON.parse(readFileSync(join(LOG_DIR, n), 'utf8')).entries?.[0]?.msg).slice(4)).sort()
  check('5 条内容各自落盘、无丢失', JSON.stringify(tags) === JSON.stringify([...TAGS].sort()), JSON.stringify(tags))
}

console.log('== K. v1.4.1 回归：时钟钉死后并发（时间戳完全相同）→ 必须 5 个不同文件 ==')
{
  // 为什么还要这一段：J 段的 5 个请求落在**相邻几毫秒**（实测 780/784/786/788/790），
  // 只固定随机后缀为常量时 J 仍会绿 —— 它其实测不到"同一毫秒、只剩随机量"这条线。
  // 这里用 config.now 把时钟钉死，5 个请求的命名时间戳字节级相同，唯一区分量只剩随机后缀。
  // 去掉随机后缀 → 本段必红（见 test/_mutation-check.mjs 的同名变异）。
  const frozenRoutes = []
  const frozenCtx = {
    ...ctx,
    webServer: {
      tapIndex: () => () => {},
      register ({ kind, path, handler }) { frozenRoutes.push({ kind, path, handler }); return () => {} },
    },
  }
  const FROZEN = 1792661629424
  apply(frozenCtx, { sessionSecret: 'e2e-client-log-secret-frozen', apiToken: '', accessLogDir: AUDIT_DIR, now: () => FROZEN })
  const frozenServer = http.createServer((q, res2) => {
    const p = q.url.split('?')[0]
    for (const r of frozenRoutes) {
      if (r.kind === 'exact' && p === r.path) return r.handler(q, res2)
      if (r.kind === 'prefix' && q.url.startsWith(r.path)) return r.handler(q, res2)
    }
    res2.writeHead(404).end('no route')
  })
  await new Promise((r) => frozenServer.listen(0, '127.0.0.1', r))
  const FBASE = 'http://127.0.0.1:' + frozenServer.address().port
  const fpost = (tag) => new Promise((resolve, reject) => {
    const body = JSON.stringify(samplePayload({ kind: 'flush', entries: [{ t: 1, level: 'info', kind: 'longtask', duration: 5, msg: 'TAG=' + tag }] }))
    const r = http.request(FBASE + '/api/dsh/v1/client-log', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'user-agent': 'Mozilla/5.0 (Linux; Android 13; WebView) test',
        'x-forwarded-for': '203.0.113.21',
      },
    }, (res2) => {
      let d = ''
      res2.on('data', (c) => { d += c })
      res2.on('end', () => resolve({ status: res2.statusCode, body: d }))
    })
    r.on('error', reject)
    r.write(body)
    r.end()
  })

  const before = new Set(listLogs())
  const TAGS = ['fz-0', 'fz-1', 'fz-2', 'fz-3', 'fz-4']
  const res = await Promise.all(TAGS.map(fpost))
  check('冻结时钟：并发 5 次全部 200', res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.status)))
  const names = res.map((r) => JSON.parse(r.body).file)
  check('冻结时钟：时间戳部分完全相同（用例真的落在同一毫秒）',
    new Set(names.map((n) => n.slice(0, 19))).size === 1, JSON.stringify(names))
  console.log('    冻结时钟文件名：' + JSON.stringify(names))
  check('🔴 冻结时钟：并发 5 次仍是 5 个不同文件', new Set(names).size === 5, JSON.stringify(names))
  const added = listLogs().filter((n) => !before.has(n))
  check('🔴 冻结时钟：新增 5 个文件（无覆盖）', added.length === 5, JSON.stringify(added))
  const tags = added.map((n) => String(JSON.parse(readFileSync(join(LOG_DIR, n), 'utf8')).entries?.[0]?.msg).slice(4)).sort()
  check('🔴 冻结时钟：5 条内容都在', JSON.stringify(tags) === JSON.stringify([...TAGS].sort()), JSON.stringify(tags))
  await new Promise((r) => frozenServer.close(r))
}

server.close()
try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch {}
console.log('\n结果: pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
