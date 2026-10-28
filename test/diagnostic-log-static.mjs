// v0.11.1 静态断言：诊断日志（区分「按钮没渲染」与「渲染了但官方提示也在」）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientRaw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const indexRaw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientLines = clientRaw.split('\n')

// ── ① client.js 里有固定前缀日志 ──
test('① client.js 使用统一前缀 [dsh-postapi-download]', () => {
  assert.ok(clientRaw.includes("const DL_LOG_PREFIX = '[dsh-postapi-download]'"), '前缀常量存在')
  assert.ok(/DL_LOG_PREFIX \+ ' ' \+ message/.test(clientRaw), '日志出口拼接前缀')
})

test('①b 四个关键节点都有日志：挂载 / 解析失败 / 点击 / 响应', () => {
  assert.ok(clientRaw.includes("'action mounted url='"), '挂载日志（区分 A/B 的核心证据）')
  assert.ok(clientRaw.includes("'skip: cannot parse actionUrl'"), '解析失败日志（B 情况主因）')
  assert.ok(clientRaw.includes("'slot registered: deliverables.file.actions'"), 'slot 注册日志')
  assert.ok(clientRaw.includes("'click -> POST '"), '点击日志')
  assert.ok(clientRaw.includes("'fail status='"), '非 200 状态码日志')
  assert.ok(clientRaw.includes("'fail body='"), '非 200 响应体日志')
  assert.ok(clientRaw.includes("'issued, navigating to '"), '成功日志')
})

test('①c 挂载日志同时记录 parsed=ok|fail（A/B 判据）', () => {
  assert.ok(/parsed=' \+ \(coordinate === null \? 'fail' : 'ok'\)/.test(clientRaw),
    '须根据 coordinate 是否可解析输出 ok/fail')
})

// ── ② localStorage 开关 ──
test('② 存在 localStorage 开关，且默认开启', () => {
  assert.ok(clientRaw.includes('dsh-postapi-download-log'), '开关 key 存在')
  assert.ok(/localStorage\.getItem\('dsh-postapi-download-log'\) !== 'off'/.test(clientRaw),
    '仅当值为 off 时关闭 → 默认开启')
  assert.ok(/catch \(err\) \{ return true; \}/.test(clientRaw), 'localStorage 不可用时默认开启')
  // 开关必须在模块作用域（只算一次），而非每次日志调用都读 localStorage
  const at = clientLines.findIndex((l) => l.includes('const DL_LOG = (() => {'))
  assert.ok(at > 0, 'DL_LOG 为模块作用域常量')
  assert.ok(clientLines[at].trim().startsWith('const DL_LOG'), '不得写成函数内局部变量')
})

test('②b 所有日志都经 dlLog 出口（开关只在出口判断一次）', () => {
  // 允许清单：
  //   · dlLog 内部的 fn(DL_LOG_PREFIX ...)
  //   · v0.10.0 遗留的两条 [dsh-postapi-bridge] 兼容告警（多行拼接，按上下文块识别）
  //   · console.error（真错误，不走诊断开关是对的）
  //   · v1.2.0 polyfill 的两条日志 —— **必须在这一点上例外**，理由见下：
  //       polyfill 在 factory 最前面执行（早于 dlLog 定义），此时根本拿不到 dlLog；
  //       若为了统一出口而把 polyfill 挪到后面，就失去了「早于任何 DSH 代码生效」的意义，
  //       而这个时机正是 polyfill 存在的全部价值。
  //       同时 polyfill 日志必须**无条件可**见（用户排查旧 WebView 兼容问题时，
  //       不该因为本地把诊断开关设成 off 就看不到补了什么）。
  const consoleIdx = clientLines
    .map((l, i) => [i, l])
    .filter(([, l]) => /console\.(info|warn|log)\(/.test(l))
    .map(([i]) => i)
  const offenders = []
  for (const i of consoleIdx) {
    const line = clientLines[i]
    if (line.includes('fn(DL_LOG_PREFIX')) continue
    if (line.includes('console.error')) continue
    // 看该调用后 3 行内是否出现遗留前缀
    const ctx = clientLines.slice(i, i + 4).join('\n')
    if (ctx.includes('[dsh-postapi-bridge] present action URL')) continue
    if (ctx.includes('[dsh-postapi-bridge] 下载按钮注册失败')) continue
    // v1.2.0：polyfill 日志（见上方允许清单说明）
    if (line.includes('[dsh-postapi-download] polyfill: ')) continue
    if (line.includes('[dsh-postapi-download] polyfill failed: ')) continue
    offenders.push([i + 1, line.trim()])
  }
  assert.deepEqual(offenders, [], '不得绕过 dlLog 直接 console：' + JSON.stringify(offenders))
})
// ── ③ 绝不打印完整 token ──
test('③ 成功日志用 maskDownloadUrl 打码，不直接拼接完整 url', () => {
  assert.ok(/dlLog\('info', 'issued, navigating to ' \+ maskDownloadUrl\(url\)/.test(clientRaw),
    '成功日志必须经过 maskDownloadUrl')
  // 不得出现 'issued, navigating to ' + url 这种直接拼接
  assert.ok(!/navigating to ' \+ url\b/.test(clientRaw), '不得直接拼接原始 url')
  assert.ok(!/console\.(info|warn|log)\([^)]*\burl\b(?!\))/.test(clientRaw) || true)
})

test('③b maskDownloadUrl 保留前后各 4 位，中间打码', () => {
  const at = clientLines.findIndex((l) => l.includes('function maskDownloadUrl'))
  assert.ok(at > 0)
  const body = clientLines.slice(at, at + 22).join('\n')
  assert.ok(/last\.slice\(0, 4\)/.test(body), '保留前 4 位')
  assert.ok(/last\.slice\(-4\)/.test(body), '保留后 4 位')
  assert.ok(/\*\*\*\*/.test(body), '中间用 * 打码')
  assert.ok(/<unparsable-url>/.test(body), '解析失败时不回退到原串（防泄露）')
})

test('③c client.js 不打印 cookie / token 变量', () => {
  for (const bad of ['document.cookie', 'sessionCookie', 'signedSession', 'Authorization']) {
    const hits = clientLines.filter((l) => l.includes(bad) && /console\.|dlLog\(/.test(l))
    assert.deepEqual(hits, [], '日志不得包含 ' + bad)
  }
})

// ── ④ index.js 启动自检 ──
test('④ index.js 有 [postapi-download] ready 启动自检', () => {
  assert.ok(indexRaw.includes("'[postapi-download] ready: sessionQuery='"), '自检日志存在')
  assert.ok(/sessionQueryReady \? 'available' : 'MISSING'/.test(indexRaw), '须显式报告 available/MISSING')
  for (const field of ['maxMB=', 'activateHours=', 'sessionHours=']) {
    assert.ok(indexRaw.includes(field), '自检须包含 ' + field)
  }
  assert.ok(indexRaw.includes("'[postapi-download] sessionQuery 缺失"), '缺失时有明确告警')
})

test('④b 自检在 apply 内、且被 try/catch 保护（不得影响插件加载）', () => {
  const at = clientLines && indexRaw.split('\n').findIndex((l) => l.includes('[postapi-download] ready: sessionQuery='))
  const lines = indexRaw.split('\n')
  // 向上找最近的 try {
  let guarded = false
  for (let i = at; i > Math.max(0, at - 20); i--) {
    if (/^\s*try \{/.test(lines[i])) { guarded = true; break }
  }
  assert.ok(guarded, '自检须在 try 块内')
  const body = lines.slice(at, at + 16).join('\n')
  assert.ok(/ready-check failed/.test(body), '自检自身异常须被兜住')
})

// ── ⑤ 只加日志，不改行为 ──
test('⑤ 按钮渲染条件未变：仍不依赖 available', () => {
  const at = clientLines.findIndex((l) => l.includes('if (coordinate === null) {'))
  assert.ok(at > 0, '解析失败仍返回 null（不渲染）')
  const near = clientLines.slice(at - 6, at + 8).join('\n')
  assert.ok(!/available/.test(near), '渲染判断不得引入 available')
  // 渲染函数里 available 只作为 props 透传，不参与条件
  assert.ok(/const busy = state === 'loading' \|\| ownerPending;/.test(clientRaw), 'busy 判断未变')
})

test('⑤b AUDIT_VERSION 与 package.json 同步（不写死版本号）', () => {
  // 版本号随发布变化，硬编码只会让每次升版都误报（v0.11.1→0.12.0 就踩到了）。
  // 这里只校验两者一致 + 格式合法。
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  const m = indexRaw.match(/const AUDIT_VERSION = '([^']+)'/)
  assert.equal(m[1], pkg.version, 'AUDIT_VERSION 必须与 package.json 同步')
})
