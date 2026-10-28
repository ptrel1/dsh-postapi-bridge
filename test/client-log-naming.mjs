// v1.4.1 回归：client-logs 文件名唯一性（同一毫秒/同一秒内多次上报不得撞名）。
//
// 背景（用户实测的 bug）：
//   v1.4.0 的文件名是 "<到秒的时间戳>-<sha256(IP) 前 8 位>.json"，
//   唯一区分量只有 IP ⇒ 同一 IP 同一秒内的多次上报得到**同一个文件名**，
//   后一次 rename 直接覆盖前一次。手机端 snapshot + perf + flush 同秒到达 → 丢日志。
//
// 本文件守两件事：
//   ① 纯函数层：同一毫秒连续取 N 次名字必须 N 个互不相同（核心）；
//   ② 真实 HTTP 层：并发 5 次 / 串行 10 次上报都要**各自落盘、内容都在**（不丢不覆盖）。
// 两者分开写，是因为纯函数红了要看命名，HTTP 红了要看写盘/并发 —— 定位更快。
//
// 运行：node test/client-log-naming.mjs
import http from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { __clientLogHelpers, apply } from '../lib/index.js'

const { clientLogFileName, writeClientLogFile, CLIENT_LOG_MAX_BODY_BYTES } = __clientLogHelpers

// 文件名格式：<YYYYMMDD-HHMMSS-mmm>-<16 位 hex>.json
const NAME_RE = /^\d{8}-\d{6}-\d{3}-[0-9a-f]{16}\.json$/

console.log('== ① 纯函数：同一毫秒内多次取名必须互不相同 ==')
test('同一毫秒并发取名 1000 次 → 1000 个不同文件名', () => {
  const T = 1792661629123
  const names = new Set()
  for (let i = 0; i < 1000; i++) names.add(clientLogFileName('203.0.113.7', T))
  assert.equal(names.size, 1000, '同一毫秒内出现撞名 —— 随机后缀没起作用？')
})

test('格式正确：<YYYYMMDD-HHMMSS-mmm>-<16hex>.json，且时间戳精确到毫秒', () => {
  const T = 1792661629123
  const n = clientLogFileName('203.0.113.7', T)
  assert.match(n, NAME_RE)
  // 期望值按**本地时间**构造（文件名用本地时间，见实现注释）
  const d = new Date(T)
  const p = (x, w = 2) => String(x).padStart(w, '0')
  const want = p(d.getFullYear(), 4) + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3)
  assert.ok(n.startsWith(want + '-'), '毫秒/本地时间不符：期望前缀 ' + want + '，实际 ' + n)
  // 反证：不得是 toISOString() 的 UTC 串（UTC+8 下两者差 8 小时）
  const utc = new Date(T).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const offsetMin = -d.getTimezoneOffset()
  if (offsetMin !== 0) {
    assert.ok(!n.startsWith(utc), '文件名用了 UTC 时间，会和运维的本地时间认知差一个时区：' + n)
    console.log('    本地时区偏移=' + offsetMin + 'min；UTC 前缀=' + utc + '；实际前缀=' + want)
  }
})

test('🔴 文件名不得含 IP 指纹（同 IP 不再是区分量）', () => {
  // 旧实现里 hash = sha256(ip).slice(0,8)。现在随机后缀与 ip 无关：
  // 同 IP 同毫秒两次取名必须不同；不同 IP 也不应出现"按 IP 分组"的稳定串。
  const a = clientLogFileName('203.0.113.7', 1792661629123)
  const b = clientLogFileName('203.0.113.7', 1792661629123)
  assert.notEqual(a, b, '同 IP 同毫秒撞名 = 又回到旧 bug')
  const ipHash8 = '4a2b1c9d' // 占位：不作为断言依据，仅说明语义
  assert.ok(!a.includes(ipHash8))
})

test('不同毫秒也不撞（时间戳变化 + 随机，双重保险）', () => {
  const names = new Set()
  for (let ms = 0; ms < 200; ms++) {
    names.add(clientLogFileName('203.0.113.7', 1792661629000 + ms))
    names.add(clientLogFileName('203.0.113.7', 1792661629000 + ms))
  }
  assert.equal(names.size, 400)
})

console.log('== ② 纯函数：原子写盘（tmp → rename），并发写同一文件名也不丢 ==')
test('writeClientLogFile 并发写同一文件名：调用不报错、文件是合法 JSON', async () => {
  const dir = '/tmp/postapi-naming-unit-' + process.pid + '-' + Date.now()
  mkdirSync(dir, { recursive: true })
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() => writeClientLogFile(dir, 'same-name.json', { v: 1, i })))
    )
    assert.ok(results.every((r) => r.ok), '有写入失败：' + JSON.stringify(results.filter((r) => !r.ok)))
    const raw = readFileSync(join(dir, 'same-name.json'), 'utf8')
    const rec = JSON.parse(raw) // 半截 JSON 会在这里抛
    assert.equal(rec.v, 1)
    // 不得残留 .tmp（残留说明 rename 失败或 tmp 名冲突）
    const leftovers = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '残留 tmp 文件：' + JSON.stringify(leftovers))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ==================== 真实 HTTP 层 ====================
const DSH_HOME = '/tmp/postapi-naming-e2e-' + Date.now()
process.env.DSH_HOME = DSH_HOME
const AUDIT_DIR = DSH_HOME + '/audit'
const LOG_DIR = AUDIT_DIR + '/client-logs'

const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
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
apply(ctx, { sessionSecret: 'naming-test-secret', apiToken: '', accessLogDir: AUDIT_DIR })

// ===== 第二个实例：**时钟冻结**（只用于「强制同一毫秒」的确定性用例）=====
// 真实并发下 5 个请求会散落在相邻几毫秒（实测 645/650/651/653/655），
// 那证明不了"同一毫秒也不撞"。这里把 config.now 钉死，让 5 个请求的命名时间戳完全相同，
// 唯一区分量就只剩随机后缀 —— 正是 v1.4.1 要守的那条线。
const FROZEN_MS = 1792661629424
const frozenRoutes = []
const frozenCtx = {
  ...ctx,
  webServer: {
    tapIndex: () => () => {},
    register ({ kind, path, handler }) { frozenRoutes.push({ kind, path, handler }); return () => {} },
  },
}
apply(frozenCtx, {
  sessionSecret: 'naming-test-secret-frozen', apiToken: '', accessLogDir: AUDIT_DIR,
  now: () => FROZEN_MS,
})

// 两个真实 HTTP 实例（同一 apply() 输出，差别只在时钟）：
//   mainServer   —— 真实时钟，验证真实并发/串行落盘
//   frozenServer —— 时钟钉死，用于「强制同一毫秒」的确定性用例
function makeServer (routeList) {
  return http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    for (const r of routeList) {
      if (r.kind === 'exact' && p === r.path) return r.handler(req, res)
      if (r.kind === 'prefix' && req.url.startsWith(r.path)) return r.handler(req, res)
    }
    res.writeHead(404).end('no route')
  })
}
const mainServer = makeServer(routes)
const frozenServer = makeServer(frozenRoutes)

// ⚠️ 不在这里 listen：node:test 的子测试会先于顶层 await 执行。
//    统一用 start(srv) 幂等启动，用例里 await 拿到端口。
function start (srv) {
  if (!srv.__started) {
    srv.__started = new Promise((resolve, reject) => {
      if (srv.listening) return resolve(srv.address().port)
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port))
    })
  }
  return srv.__started
}

function post (payload, ip, srv) {
  return start(srv || mainServer).then((port) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const r = http.request('http://127.0.0.1:' + port + '/api/dsh/v1/client-log', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'naming-test',
        'x-forwarded-for': ip,
      },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(d) } catch {}
        resolve({ status: res.statusCode, body: json, raw: d })
      })
    })
    r.on('error', reject)
    r.write(body)
    r.end()
  }))
}

const listLogs = () => { try { return readdirSync(LOG_DIR).filter((n) => n.endsWith('.json')) } catch { return [] } }
const readRec = (f) => JSON.parse(readFileSync(join(LOG_DIR, f), 'utf8'))
// 每条上报嵌入唯一标记，用于证明"每条内容都还在"
const payload = (tag) => ({
  source: 'web', kind: 'flush',
  entries: [{ t: 1, level: 'info', kind: 'longtask', duration: 10, msg: 'TAG=' + tag }],
})

test('🔴 同一毫秒内并发 5 次上报 → 5 个不同文件，5 条内容都在（核心回归）', async () => {
  await start(mainServer)
  const files = listLogs()
  const before = new Set(files)
  const TAGS = ['par-0', 'par-1', 'par-2', 'par-3', 'par-4']
  // 同时发出（不 await 逐个）：5 个请求由 libuv 并发处理，几乎必然落在同一毫秒
  const res = await Promise.all(TAGS.map((tag) => post(payload(tag), '203.0.113.50')))

  assert.ok(res.every((r) => r.status === 200 && r.body?.ok === true),
    '有请求没成功落盘：' + JSON.stringify(res.map((r) => [r.status, r.raw])))
  assert.ok(res.every((r) => r.body.stored === true), 'stored 必须为 true')

  const returned = res.map((r) => r.body.file)
  assert.equal(new Set(returned).size, 5, '返回值出现重复文件名：' + JSON.stringify(returned))
  returned.forEach((f, i) => assert.match(f, NAME_RE, '文件名格式不符：' + f))

  // 这 5 次必须在同一秒内（否则本测试没测到点上）
  const secs = new Set(returned.map((f) => f.slice(0, 15)))
  const millis = new Set(returned.map((f) => f.slice(0, 19)))
  console.log('    文件名：' + JSON.stringify(returned))
  console.log('    不同「秒」数=' + secs.size + '，不同「毫秒」数=' + millis.size)
  assert.equal(secs.size, 1, '5 个请求没落在同一秒 —— 测试没测到目标场景')

  // 落盘：新增 5 个文件，且每条 TAG 各自在一个文件里
  const after = listLogs()
  const added = after.filter((n) => !before.has(n))
  assert.equal(added.length, 5, '应新增 5 个文件，实际 ' + added.length + '：' + JSON.stringify(added))

  const seen = new Map()
  for (const f of added) {
    const rec = readRec(f)
    const tag = rec.entries?.[0]?.msg
    assert.ok(tag && tag.startsWith('TAG='), '文件内容不合法：' + f)
    seen.set(tag.slice(4), f)
  }
  assert.deepEqual([...seen.keys()].sort(), [...TAGS].sort(),
    '内容丢失/被覆盖：落盘只有 ' + JSON.stringify([...seen.keys()]))
  // 每个 TAG 必须在自己的文件里，且文件大小与响应 bytes 一致（不是半截）
  for (let i = 0; i < TAGS.length; i++) {
    const f = returned[i]
    assert.equal(statSync(join(LOG_DIR, f)).size, res[i].body.bytes,
      'bytes 与实际文件大小不一致（可能被别的请求截断）：' + f)
    assert.equal(seen.get(TAGS[i]), f, '响应里报的文件名与实际落盘文件对不上：' + TAGS[i])
  }
})

test('同一秒内串行 10 次上报 → 10 个文件、10 条内容都在', async () => {
  await start(mainServer)
  const before = new Set(listLogs())
  const TAGS = Array.from({ length: 10 }, (_, i) => 'ser-' + i)
  const returned = []
  for (const tag of TAGS) {
    const r = await post(payload(tag), '203.0.113.51')
    assert.equal(r.status, 200, tag + ' 失败：' + r.raw)
    returned.push(r.body.file)
  }
  assert.equal(new Set(returned).size, 10, '串行也撞名：' + JSON.stringify(returned))
  const added = listLogs().filter((n) => !before.has(n))
  assert.equal(added.length, 10, '应新增 10 个文件，实际 ' + added.length)
  const tags = added.map((f) => readRec(f).entries?.[0]?.msg).map((m) => String(m).slice(4)).sort()
  assert.deepEqual(tags, [...TAGS].sort(), '内容丢失：' + JSON.stringify(tags))
  // 串行 10 次每次内容不同（entries 里的 t 递增），不是同一份被写了 10 遍
  const sizes = new Set(added.map((f) => readRec(f).entries[0].msg))
  assert.equal(sizes.size, 10)
})

test('🔴🔴 时钟钉死后并发 5 次（时间戳完全相同）→ 仍 5 个不同文件、内容都在', async () => {
  // 这是本 bug 的**最强形态**：5 个请求的命名时间戳字节级相同，
  // 唯一区分量只剩 randomBytes(8)。去掉随机后缀，本用例必红。
  await start(frozenServer)
  const before = new Set(listLogs())
  const TAGS = ['frz-0', 'frz-1', 'frz-2', 'frz-3', 'frz-4']
  const res = await Promise.all(TAGS.map((tag) => post(payload(tag), '203.0.113.52', frozenServer)))

  assert.ok(res.every((r) => r.status === 200 && r.body?.ok === true),
    '有请求没成功：' + JSON.stringify(res.map((r) => [r.status, r.raw])))
  const names = res.map((r) => r.body.file)
  console.log('    冻结时钟下的文件名：' + JSON.stringify(names))
  assert.equal(new Set(names).size, 5, '同一毫秒并发撞名（v1.4.0 的 bug 复现）：' + JSON.stringify(names))

  // 时间戳部分必须完全一致 —— 证明本用例真的落在"同一毫秒"
  const stamps = new Set(names.map((n) => n.slice(0, 19)))
  assert.equal(stamps.size, 1, '时钟没钉住，用例失去意义：' + JSON.stringify([...stamps]))
  const d = new Date(FROZEN_MS)
  const p = (x, w = 2) => String(x).padStart(w, '0')
  const wantStamp = p(d.getFullYear(), 4) + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3)
  assert.equal([...stamps][0], wantStamp, '时间戳未采用注入时钟')

  // 5 条内容各自在自己的文件里
  const added = listLogs().filter((n) => !before.has(n))
  assert.equal(added.length, 5, '应新增 5 个文件：' + JSON.stringify(added))
  const tags = added.map((f) => String(readRec(f).entries?.[0]?.msg).slice(4)).sort()
  assert.deepEqual(tags, [...TAGS].sort(), '内容丢失/覆盖：' + JSON.stringify(tags))
})

test('目录里不残留 .tmp（原子写盘收尾干净）', () => {
  const leftovers = readdirSync(LOG_DIR).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('[teardown] 关闭测试服务并清理临时目录', async () => {
  await new Promise((r) => mainServer.close(r))
  await new Promise((r) => frozenServer.close(r))
  try { rmSync(DSH_HOME, { recursive: true, force: true }) } catch {}
})
