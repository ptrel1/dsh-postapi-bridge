// v1.4.0 静态断言：/client-log 分流位置 + 脱敏必须发生在写盘之前 + 五条限额存在。
//
// 存在理由（与 mobile-login-static.mjs 同源）：/client-log 是**免鉴权**端点，
// 一旦被后人挪到 token/cookie 校验之后就会「永远 401」，而这种回归用运行时测试
// 很难发现（需要构造完整 ctx 与真实公网 IP）。用纯文本行号断言把位置钉死。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { blockOf, codeOnly, lineNo as sharedLineNo } from './_static-helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const lines = raw.split('\n')
const clientRaw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const lineNo = (pred) => sharedLineNo(lines, pred)

test('① /client-log 分流行号 < apiToken fail-fast < isHumanEndpoint < isLoopback', () => {
  const clientLogLine = lineNo((l) => l.includes("req.method === 'POST' && subPath === '/client-log'"))
  const mobileLine = lineNo((l) => l.includes("req.method === 'POST' && subPath === '/mobile-login'"))
  const apiTokenLine = lineNo((l) => l.includes('if (!apiToken) {') && l.startsWith('    if'))
  const humanLine = lineNo((l) => l.includes('const isHumanEndpoint = HUMAN_ENDPOINTS.includes(subPath)'))
  const loopbackLine = lineNo((l) => l.includes('if (!isLoopback) {') && l.startsWith('    if'))
  const methodLine = lineNo((l) => l.trim().startsWith("if (req.method !== 'POST')"))

  assert.ok(clientLogLine > 0, '/client-log 分流存在')
  assert.ok(mobileLine > 0, '/mobile-login 分流存在')
  assert.ok(clientLogLine < apiTokenLine, `client-log(${clientLogLine}) 必须早于 apiToken(${apiTokenLine})`)
  assert.ok(clientLogLine < humanLine, `client-log(${clientLogLine}) 必须早于人类通道 cookie 校验(${humanLine})`)
  assert.ok(clientLogLine < loopbackLine, `client-log(${clientLogLine}) 必须早于 isLoopback(${loopbackLine})`)
  assert.ok(clientLogLine < methodLine, `client-log(${clientLogLine}) 必须早于 405 守卫(${methodLine})`)
  // 与 /mobile-login 同级：两者都在 token 校验之前
  assert.ok(Math.abs(clientLogLine - mobileLine) < 20,
    `应与 /mobile-login 相邻（同为免鉴权入口），实际相距 ${Math.abs(clientLogLine - mobileLine)} 行`)
})

test('② 只放行 POST（GET 同名路径不进入日志分支）', () => {
  const l = lines[lineNo((x) => x.includes("subPath === '/client-log'")) - 1]
  assert.ok(l.includes("req.method === 'POST'"), '条件必须含 POST 判断')
  assert.ok(l.includes("subPath === '/client-log'"), '必须是精确子路径，不能用 startsWith')
})

test('③ 五条限额全部存在（缺一条就变成存储型 DoS 面）', () => {
  assert.ok(/const CLIENT_LOG_MAX_BODY_BYTES = 256 \* 1024/.test(raw), '①单次 256KB')
  assert.ok(/const CLIENT_LOG_RATE_LIMIT = 20/.test(raw), '②每 IP 每小时 20 次')
  assert.ok(/const CLIENT_LOG_TOTAL_MAX_BYTES = 50 \* 1024 \* 1024/.test(raw), '③目录总量 50MB')
  assert.ok(/const CLIENT_LOG_MAX_FILES = 50/.test(raw), '④保留 50 个文件')
  assert.ok(/const CLIENT_LOG_MAX_ENTRIES = 200/.test(raw), '⑤entries 上限 200')
})

test('④ 读 body 用 readBody（边读边计数），不是 readJson', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('const handleClientLog')))
  assert.ok(body, '必须能定位 handleClientLog')
  assert.ok(/readBody\(req, CLIENT_LOG_MAX_BODY_BYTES\)/.test(body), '必须用 readBody 限量读取')
  assert.ok(!/readJson\(/.test(body), '不得用 readJson（超限会 throw，拿不到 413）')
  assert.ok(/413/.test(body), '超限须 413')
})

test('⑤ 限流在解析 body 之前（被限时不读大包）', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('const handleClientLog')))
  const rateAt = body.indexOf('clientLogRateCheck')
  const readAt = body.indexOf('readBody(')
  assert.ok(rateAt > 0 && readAt > 0)
  assert.ok(rateAt < readAt, '限流必须早于读 body（否则限流形同虚设，仍会被大包拖住）')
  assert.ok(/429/.test(body), '超限须 429')
})

test('⑥ 🔴 脱敏必须发生在写盘之前（normalize → write 的顺序）', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('const handleClientLog')))
  const normAt = body.indexOf('normalizeClientLogRecord(')
  const writeAt = body.indexOf('writeClientLogFile(')
  assert.ok(normAt > 0, '必须调用 normalizeClientLogRecord')
  assert.ok(writeAt > 0, '必须调用 writeClientLogFile')
  assert.ok(normAt < writeAt, `脱敏(${normAt}) 必须先于写盘(${writeAt}) —— 先写后脱就是泄密`)
  // 反证：写盘调用点之前不得出现原始 body（例如直接 JSON.stringify(body)）
  assert.ok(!/JSON\.stringify\(body\)/.test(body), '不得把原始 body 直接写盘')
})

test('⑦ 归一化函数对每个字符串字段都脱敏（msg / ua / extra）', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('function normalizeClientLogRecord')))
  assert.ok(/sanitizeClientLogString\(item\.msg/.test(body), 'msg 必须脱敏')
  assert.ok(/sanitizeClientLogString\(raw\.ua/.test(body), 'ua 必须脱敏')
  assert.ok(/redactClientLogValue\(item\.extra/.test(body), 'extra 必须递归脱敏')
  assert.ok(/sanitizeClientLogString\(item\.level/.test(body), 'level 也必须脱敏（防注入）')
})

test('⑧ entries 超 200 时保留末尾（最新）', () => {
  assert.ok(/\.slice\(all\.length - CLIENT_LOG_MAX_ENTRIES\)/.test(raw), '必须取末尾 N 条（最新）')
  assert.ok(/meta: \{ receivedEntries/.test(raw), '必须记录原始条数（截断不静默）')
})

test('⑨ 审计只记元信息，不记日志内容', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('const handleClientLog')))
  assert.ok(/event: 'client-log-received'/.test(body), '必须有 client-log-received 审计')
  assert.ok(/ip,/.test(body) && /bytes: rawBytes/.test(body), '审计须含 IP 与大小')
  for (const forbidden of ['entries: record.entries,', 'msg:', 'record.entries[0]']) {
    assert.ok(!body.includes(forbidden), '审计不得记录日志内容：' + forbidden)
  }
  assert.ok(/kind: record\.kind/.test(body), '审计须含 kind')
  assert.ok(/entries: record\.entries\.length/.test(body), '审计只记条数（数字），不记内容')
})

test('⑩ 清理在写盘之后（先保证最新一份在，再删旧的）', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('const handleClientLog')))
  const writeAt = body.indexOf('writeClientLogFile(')
  const pruneAt = body.indexOf('pruneClientLogDir(')
  assert.ok(writeAt > 0 && pruneAt > 0)
  assert.ok(writeAt < pruneAt, '先写后清，避免进程在清理中途被杀时丢掉最新日志')
})

test('⑪ pruneClientLogDir 只删 *.json（不碰其它文件）', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('function pruneClientLogDir')))
  assert.ok(/\.endsWith\('\.json'\)/.test(body), '必须只挑 .json')
  assert.ok(/unlinkSync\(/.test(body), '必须真的删除文件')
  assert.ok(/mtime/.test(body), '必须按 mtime 排序（最旧优先）')
  // 不得删目录/递归删除
  assert.ok(!/rmSync|rmdir|recursive/.test(body), '不得递归删除（危险面太大）')
})

test('⑫ 目录复用 auditDataDir（不另造数据根）', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('function clientLogDir')))
  assert.ok(/auditDataDir\(config\)/.test(body), '必须复用 auditDataDir')
  assert.ok(/'client-logs'/.test(body), '子目录名必须是 client-logs')
})

// v1.4.1：文件名唯一性由「毫秒时间戳 + 8 字节随机」保证。
// 旧实现（到秒时间戳 + sha256(IP) 前 8 位）的唯一区分量是 IP ⇒ 同 IP 同秒必撞、后写覆盖前写。
test('⑬ 文件名 <YYYYMMDD-HHMMSS-mmm>-<16位随机hex>.json，且不以 IP 为区分量', () => {
  const body = codeOnly(blockOf(lines, (l) => l.includes('function clientLogFileName')))
  assert.ok(/randomBytes\(8\)\.toString\('hex'\)/.test(body), '必须有 8 字节随机后缀（同一毫秒也不撞）')
  assert.ok(/getMilliseconds\(\)/.test(body), '时间戳必须精确到毫秒')
  assert.ok(!/createHash\('sha256'\)/.test(body), '🔴 不得再用 sha256(IP) 当区分量（同 IP 同秒必撞，v1.4.1 的 bug 根因）')
  assert.ok(!/\.slice\(0, 8\)/.test(body), '不得再取 8 位短 hash')
  assert.ok(!/ip \+|\+ ip|String\(ip/.test(body), '文件名不得以 IP 为输入')
  assert.ok(!/toISOString\(\)/.test(body), '不得用 toISOString（UTC，与运维本地时间差一个时区）')
})

test('⑭ 前端：client-log 端点 + 采集项齐全 + 不污染 console', () => {
  assert.ok(/\/api\/dsh\/v1\/client-log/.test(clientRaw), '前端必须打 /api/dsh/v1/client-log')
  for (const kw of ['longtask', 'first-input', 'layout-shift', 'requestAnimationFrame', 'visibilitychange', "'console.error'"]) {
    assert.ok(clientRaw.includes(kw), '缺少采集项：' + kw)
  }
  assert.ok(/origErr\.apply\(/.test(clientRaw), 'console.error 包装必须 apply 原函数（保留原行为）')
  assert.ok(/keepalive: true/.test(clientRaw), '上报必须 keepalive（不阻塞页面/可跨隐藏完成）')
  assert.ok(!/addEventListener\('unload'/.test(clientRaw), '不得用 unload（浏览器会丢弃异步请求）')
  assert.ok(/document\.hidden|visibilityState/.test(clientRaw), '必须用 visibilitychange 而非 unload')
})

test('⑮ 前端：失败静默（不重试、不弹提示）', () => {
  assert.ok(/\.catch\(function \(\) \{/.test(clientRaw), 'fetch 必须有 catch')
  assert.ok(/skipped: 'network'/.test(clientRaw), '网络异常必须静默返回')
  assert.ok(!/alert\(/.test(clientRaw), '不得用 alert 弹窗（会打断用户）')
  assert.ok(!/setTimeout\([^)]*report\(/.test(clientRaw), '失败不得安排重试（避免雪崩）')
})
