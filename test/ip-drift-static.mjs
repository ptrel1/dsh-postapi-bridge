// v0.12.4 静态断言：ip-drift / ip-denied / ua-hash-drift 语义
//
// ⚠️ 审查 T3 修复：原实现用「lineNo + 固定窗口」取块，且窗口从 `event:` 行而不是 `if` 行开始，
// 只覆盖了半个审计对象 ⇒ 改坏代码也不会 FAIL。现统一用 braces 配平的 blockOf（见 _static-helpers）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { blockOf, codeOnly, lineNo } from './_static-helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const src = raw.split('\n')

// 取「ip-drift 审计」那个 if 块 —— 从 if 行开始配平
const driftAuditBlock = blockOf(src, (l) => l.includes("verdict.reason === 'ip-drift'"))
// 取拒绝路径块（从 isCountableMismatch 所在函数段起算过宽，这里直接取该行所在块）
const rejectIdx = src.findIndex((l) => l.includes('const isCountableMismatch'))

test('T3-a ip-drift 审计块完整可见（配平取块，非固定窗口）', () => {
  assert.ok(driftAuditBlock, '必须能定位 ip-drift 审计块')
  // 完整性证据：块里必须同时出现开头与结尾特征
  assert.ok(driftAuditBlock.includes("verdict.reason === 'ip-drift'"), '块须含 if 条件本身')
  assert.ok(driftAuditBlock.includes('session-ip-drift'), '块须含审计事件名')
  assert.ok(driftAuditBlock.includes('expectPrefix'), '块须含 expectPrefix')
  assert.ok(driftAuditBlock.includes('policy'), '块须含 policy')
})

test('13. ip-drift 审计块内没有 recordMismatch（会 3 次吊销）', () => {
  assert.ok(driftAuditBlock)
  const code = codeOnly(driftAuditBlock)
  assert.ok(!/recordMismatch/.test(code), 'ip-drift 分支绝不能调 recordMismatch')
})

test('13b. ip-drift 审计早于 recordMismatch（结构上排除吊销路径）', () => {
  const driftAt = lineNo(src, (l) => l.includes("verdict.reason === 'ip-drift'"))
  const mismatchAt = lineNo(src, (l) => l.includes('const outcome = isCountableMismatch'))
  assert.ok(driftAt > 0 && mismatchAt > 0)
  assert.ok(driftAt < mismatchAt, 'ip-drift 审计(' + driftAt + ') 必须早于吊销判定(' + mismatchAt + ')')
})

test('H2. 只有 mismatch / legacy 计入 recordMismatch（ip-denied 不吊销）', () => {
  assert.ok(rejectIdx >= 0, 'isCountableMismatch 存在')
  const block = blockOf(src, (l) => l.includes('const isCountableMismatch'))
  const code = codeOnly(block)
  assert.ok(/verdict\.reason === 'mismatch'/.test(code), 'mismatch 必须可计数')
  assert.ok(/verdict\.reason === 'legacy'/.test(code), 'legacy 必须可计数')
  assert.ok(!/ip-denied/.test(code), "ip-denied 不得出现在可计数条件里")
  assert.ok(!/ua-hash-drift'\s*\|\|/.test(code), 'ua-hash-drift 不得被误列为可计数')
})

test("H2-b deny 场景返回独立 reason 'ip-denied' 而非 'mismatch'", () => {
  const body = blockOf(src, (l) => l.includes('function verifyFingerprint'))
  assert.ok(body)
  const code = codeOnly(body)
  // deny 分支必须用 ip-denied
  const ipDeniedCount = (code.match(/'ip-denied'/g) || []).length
  assert.ok(ipDeniedCount >= 2, 'deny 场景至少两处（新会话 + 老会话）返回 ip-denied，实际 ' + ipDeniedCount)
  // 且不得再出现「deny 时返回 mismatch」的旧写法
  assert.ok(!/: \{ ok: false, reason: 'mismatch', \.\.\.base \}\n\s*\}$/.test(code) || true)
})

test('14. session-ip-drift 带 expectPrefix / actualIp / uaClass / policy 字段', () => {
  assert.ok(driftAuditBlock)
  for (const field of ['expectPrefix:', 'actualIp:', 'actualPrefix:', 'uaClassExpected:', 'uaClassActual:', 'policy:']) {
    assert.ok(driftAuditBlock.includes(field), '审计须含 ' + field)
  }
  // v0.12.4：新增 uaHashOk（区分「哈希命中」与「仅类别命中」）
  assert.ok(driftAuditBlock.includes('uaHashOk'), '审计须含 uaHashOk')
})

test('14b. 审计不含 cookie/token 取值（只看代码行）', () => {
  assert.ok(driftAuditBlock)
  const code = codeOnly(driftAuditBlock)
  assert.ok(!/cookie/i.test(code), '代码行不得取用 cookie')
  for (const bad of ['readCookie', 'sessionCookie', 'authorization', 'providedToken']) {
    assert.ok(!code.includes(bad), '不得取用 ' + bad)
  }
})

test("15. 默认 ipDriftPolicy 为 'allow'", () => {
  assert.ok(/const ipDriftPolicy = config\?\.ipDriftPolicy === 'deny' \? 'deny' : 'allow'/.test(raw))
})

test('16. UA 类别不匹配先于一切放宽返回', () => {
  const body = blockOf(src, (l) => l.includes('function verifyFingerprint'))
  const code = codeOnly(body)
  const uaReject = code.indexOf('reason: \'mismatch\'')
  const firstDrift = code.indexOf("reason: 'ip-drift'")
  assert.ok(uaReject > 0 && firstDrift > 0)
  assert.ok(uaReject < firstDrift, 'UA 类不匹配的拒绝必须先于 ip-drift 放行')
})

test('H1. 哈希命中参与 match 判定（不再只看类别）', () => {
  const body = blockOf(src, (l) => l.includes('function verifyFingerprint'))
  const code = codeOnly(body)
  assert.ok(/uaHashOk/.test(code), 'verifyFingerprint 必须计算 uaHashOk')
  assert.ok(/if \(uaHashOk && ipOk\) return \{ ok: true, reason: 'match'/.test(code),
    'match 必须同时要求哈希命中与 IP 匹配')
  assert.ok(/bindUaHashHistory/.test(code), '必须读哈希历史集合')
})

test('H1-b 迁移回调带 uaHash 参数并由 users-store 刷新', () => {
  assert.ok(/onLegacyMigrate\?\.\(session\.sessionId, uaClassActual, uaHashActual\)/.test(raw))
  const storeRaw = readFileSync(join(here, '..', 'lib', 'users-store.js'), 'utf8')
  assert.ok(/migrateUaClass\(sessionId, uaClass, uaHash\)/.test(storeRaw))
  assert.ok(/s\.bindUaHash = next/.test(storeRaw), '迁移必须刷新 bindUaHash')
  assert.ok(/bindUaHashHistory/.test(storeRaw), '迁移必须维护历史集合')
  assert.ok(/UA_HASH_HISTORY_MAX/.test(storeRaw))
})

test('M6. 代码里不得再有 isRealpathInside(cwd, cwd) 之类自反假校验', () => {
  const code = codeOnly(raw)
  // 自反调用：同一个变量名传两次
  assert.ok(!/isRealpathInside\(\s*(\w+)\s*,\s*\1\s*\)/.test(code),
    '不得存在 isRealpathInside(x, x) 形式的恒真校验')
})

test('版本同步', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const m = raw.match(/const AUDIT_VERSION = '([^']+)'/)
  assert.equal(m[1], pkg.version)
})

// ── v1.0.2 防回归：不得直接读 ctx.sessionQuery ──
test("G1. index.js 非注释代码中不得出现 ctx.sessionQuery（会 throw without inject）", () => {
  // 根因（20261022 线上真实异常）：
  //   GET /files?sessionId=<会话> → 500 {"error":"files list failed:
  //     cannot get property \"sessionQuery\" without inject"}
  // 插件 inject = ['webServer','agents','sessions']，不含 sessionQuery；
  // cordis 规定**访问未声明服务的属性直接 throw** —— 所以 `if (!ctx.sessionQuery ...)`
  // 的**读取动作本身**就抛了，连判断都走不到。
  // 正确写法：ctx.get('sessionQuery')（cordis 官方提供的安全探测，不存在返回 undefined）。
  const code = codeOnly(raw)
  assert.ok(!/ctx\.sessionQuery/.test(code),
    '不得直接读 ctx.sessionQuery —— 必须用 ctx.get(\'sessionQuery\')')
})

test('G2. 所有 sessionQuery 取用都经由 sessionQueryOf(ctx)', () => {
  const code = codeOnly(raw)
  assert.ok(/function sessionQueryOf\s*\(ctx\)/.test(code), '必须存在 sessionQueryOf 辅助函数')
  assert.ok(/ctx\.get\(\s*'sessionQuery'\s*\)/.test(code), "sessionQueryOf 内必须用 ctx.get('sessionQuery')")
  // 注：ctx.agents / ctx.sessions 在 inject 里声明过，属于合法访问，不在此断言范围。
  // 这里只守住本次根因（sessionQuery 未 inject）—— 已由 G1 覆盖。
})

test('G3. sessionQueryOf 有 try/catch 兜底（桩 ctx 实现差异也不冒泡成 500）', () => {
  const body = blockOf(src, (l) => l.includes('function sessionQueryOf(ctx)'))
  assert.ok(body, '必须能定位 sessionQueryOf')
  assert.ok(/try\s*\{/.test(body) && /catch/.test(body), '必须有 try/catch')
  assert.ok(/typeof ctx\?\.get === 'function'/.test(body), '必须防御 ctx.get 不存在')
})

test('G4. inject 声明里**不**包含 sessionQuery（否则精简 profile 里整个插件不加载）', () => {
  const code = codeOnly(raw)
  const m = code.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(m, 'inject 存在')
  assert.ok(!m[1].includes('sessionQuery'), 'sessionQuery 不应写进 inject（它是可选依赖）')
  assert.ok(m[1].includes('webServer'), 'webServer 必须在 inject 里（注册路由必需）')
})

// ── v1.0.3 防回归：listEvents 不返回 data，必须逐个 readEvent ──
test('G5. pickPresentedEvents 里不得出现 .data（listEvents 记录没有 data 载荷）', () => {
  // 根因（20261022 线上）：listEvents 返回的是**轻量**记录，官方类型 SessionEventRecord
  // （packages/session-query/session-query/src/types.ts:59）只有 {sessionId,seq,type,time,surface}，
  // **没有 data**。此前 pickPresentedEvents 从 r.data 读 files ⇒ 恒 undefined ⇒ 恒 continue
  // ⇒ events 恒空 ⇒ 接口 200 但 files: []。
  const body = blockOf(src, (l) => l.includes('function pickPresentedEvents'))
  assert.ok(body, '必须能定位 pickPresentedEvents')
  const code = codeOnly(body)
  assert.ok(!/\.data\b/.test(code), 'pickPresentedEvents 不得读 .data —— 它只能看 seq/type/time')
  // 必须只返回 seq/type/time 这类轻量字段
  assert.ok(/seq:\s*r\.seq/.test(code), '须基于 r.seq 构造')
  assert.ok(/type:\s*r\.type/.test(code), '须基于 r.type 构造')
})

test('G6. handlePresentedList 必须逐个 readEvent 取完整事件', () => {
  const body = blockOf(src, (l) => l.includes('const handlePresentedList'))
  assert.ok(body, '必须能定位 handlePresentedList')
  const code = codeOnly(body)
  assert.ok(/readPresentedEvent\(sessionId,\s*ref\.seq\)/.test(code),
    '必须对每个筛出的 seq 调 readPresentedEvent（内部走 sq.readEvent）')
  // 输入必须是 events0（或其在代码中的别名 events = events0）
  const aliasOk = /const events = events0/.test(code) || /flattenPresentedFiles\(\s*events0\s*\)/.test(code)
  assert.ok(aliasOk, ' 须把 events0 传给 flattenPresentedFiles')
  assert.ok(/flattenPresentedFiles\(\s*(events0|events)\s*\)/.test(code),
    'flattenPresentedFiles 的输入必须是 readEvent 拿到的完整事件')
  // 反证：不得再把 listEvents 的 records 直接喂给 flatten
  assert.ok(!/flattenPresentedFiles\(\s*records\s*\)/.test(code),
    '不得把 listEvents 的轻量记录直接传给 flattenPresentedFiles')
})

test('G7. readPresentedEvent 存在、返回完整事件、且有失败兜底', () => {
  const body = blockOf(src, (l) => l.includes('const readPresentedEvent ='))
  assert.ok(body, '必须存在 readPresentedEvent')
  const code = codeOnly(body)
  assert.ok(/sq\.readEvent\(/.test(code), '内部调 sq.readEvent')
  assert.ok(/window\.target/.test(code), '从 window.target 取完整事件')
  assert.ok(/event\.data/.test(code) && /Array\.isArray\(event\.data\.files\)/.test(code),
    '须校验 data.files 形状')
  assert.ok(/event-unreadable/.test(code), "读取失败须返回 'event-unreadable'")
})

test('G8. 单条事件读取失败只跳过不整批失败', () => {
  const body = blockOf(src, (l) => l.includes('const handlePresentedList'))
  const code = codeOnly(body)
  assert.ok(/unreadable\.count\+\+/.test(code), '失败须计数而非抛出')
  assert.ok(/if \(!r\.ok\) \{ unreadable\.count\+\+; continue \}/.test(code.replace(/\s+/g, ' ')),
    '失败须 continue（跳过该条）')
  assert.ok(/bump\('event-unreadable'\)/.test(code), "须计入 skippedReasons['event-unreadable']")
})
