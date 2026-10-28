// v0.12.2 IP 指纹从硬绑降级为软证据（方案 A）—— 单测
//
// 背景：线上用户 cookie 绑定 ipPrefix=60.12，实际出口已是 36.28.x（移动网络换基站），
// ipOk=false ⇒ mismatch ⇒ 全家 401。方案 A：IP 只决定 reason（match / ip-drift），
// 不再一票否决；UA 设备类别成为唯一硬门。
import test from 'node:test'
import assert from 'node:assert/strict'
import { __p0Helpers } from '../lib/index.js'

const { verifyFingerprint, ipPrefixOf, uaHashOf } = __p0Helpers

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36 EdgA/155'
const UA_MOBILE2 = 'Mozilla/5.0 (Linux; Android 11; K) AppleWebKit/537.36 Chrome/156.0.0.0 Mobile Safari/537.36 EdgA/156'
const UA_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36'
const UA_TABLET = 'Mozilla/5.0 (Linux; Android 10; SM-T500) AppleWebKit/537.36 Tablet Safari/537.36'
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const UA_CURL = 'curl/8.5.0'

const IP_BOUND = '60.12.30.224'     // 签发时的网段
const IP_DRIFT = '36.28.30.224'     // 用户当前实际出口（移动网络换基站）
const IP_DRIFT2 = '36.23.11.9'      // 再换一次基站

function mkReq (ua, ip) {
  return {
    url: '/api/x',
    headers: { 'user-agent': ua, 'x-forwarded-for': ip, host: 'dsh.example.com' },
    socket: { remoteAddress: ip },
  }
}

/** 新格式会话（带 bindUaClass） */
function newSession (ua, ip, uaClass) {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2),
    username: 'alice', role: 'user', expiresAt: Date.now() + 3600_000,
    bindIpPrefix: ipPrefixOf(ip, 16),
    bindUaHash: uaHashOf(ua),
    bindUaClass: uaClass,
  }
}

/** 老格式会话（v0.6.3 之前：只有 bindUaHash，无 bindUaClass）—— 复刻线上那条记录 */
function legacySession (ua, ip) {
  return {
    sessionId: 'sess-legacy-' + Math.random().toString(36).slice(2),
    username: 'alice', role: 'user', expiresAt: Date.now() + 3600_000,
    bindIpPrefix: ipPrefixOf(ip, 16),
    bindUaHash: uaHashOf(ua),
    // 注意：**没有** bindUaClass
  }
}

const noop = () => {}

// ───────────────── 1. UA 匹配 + IP 匹配 → match ─────────────────
test('1. UA 类别匹配 + IP 匹配 → ok, reason=match, ipOk=true', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_MOBILE, IP_BOUND), s, [], 16)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'match')
  assert.equal(v.ipOk, true)
  assert.equal(v.uaOk, true)
})

// ───────────────── 2. UA 匹配 + IP 不匹配 → ip-drift（核心）─────────────────
test('2. UA 类别匹配 + IP 不匹配 → ok=true, reason=ip-drift, ipOk=false（核心）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_MOBILE, IP_DRIFT), s, [], 16)
  assert.equal(v.ok, true, 'IP 漂移不再一票否决')
  assert.equal(v.reason, 'ip-drift')
  assert.equal(v.ipOk, false, '仍如实报告 IP 不匹配，供审计区分')
  assert.equal(v.uaOk, true)
})

test('2b. 线上真实形态：60.12 → 36.28 → 36.23 连续漂移都放行', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  for (const ip of [IP_DRIFT, IP_DRIFT2, '223.104.7.7']) {
    const v = verifyFingerprint(mkReq(UA_MOBILE, ip), s, [], 16)
    assert.equal(v.ok, true, ip)
    assert.equal(v.reason, 'ip-drift', ip)
    assert.equal(v.ipOk, false, ip)
  }
})

// ───────────────── 3. UA 类别不匹配 → 拒绝 ─────────────────
test('3. UA 类别不匹配（mobile→desktop）→ ok=false（即使 IP 匹配）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_DESKTOP, IP_BOUND), s, [], 16)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'mismatch')
  assert.equal(v.ipOk, true, 'IP 匹配也救不了 UA 类不符')
  assert.equal(v.uaOk, false)
})

test('3b. UA 类别不匹配（mobile→tablet）→ 拒绝（类之间不互通）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_TABLET, IP_BOUND), s, [], 16)
  assert.equal(v.ok, false)
  assert.equal(v.uaOk, false)
})

test('3c. UA 不匹配 + IP 也不匹配 → 拒绝（不会因 ip-drift 放行）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_DESKTOP, IP_DRIFT), s, [], 16)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'mismatch')
})

// ───────────────── 4. UA 为 'other' → 拒绝 ─────────────────
test("4. UA 为 'other'（bot/curl/空）→ ok=false（即使 IP 完全匹配）", () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  for (const ua of [UA_BOT, UA_CURL, '']) {
    const v = verifyFingerprint(mkReq(ua, IP_BOUND), s, [], 16)
    assert.equal(v.ok, false, JSON.stringify(ua))
    assert.equal(v.reason, 'mismatch', JSON.stringify(ua))
    assert.equal(v.uaClassActual, 'other', JSON.stringify(ua))
  }
})

// ───────────────── 5. 老会话 + 字节匹配 → match ─────────────────
test('5. 老会话 + UA 逐字节匹配 → ok, reason=match', () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const v = verifyFingerprint(mkReq(UA_MOBILE, IP_BOUND), s, [], 16, noop)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'match')
  assert.equal(v.ipOk, true)
  assert.equal(v.uaOk, true)
})

test('5b. 老会话 + 字节匹配 + IP 漂移 → ip-drift（放行，且不迁移）', () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  let migrated = 0
  const v = verifyFingerprint(mkReq(UA_MOBILE, IP_DRIFT), s, [], 16, () => { migrated++ })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'ip-drift')
  assert.equal(v.ipOk, false)
  assert.equal(migrated, 0, '字节仍匹配时无需迁移')
})

// ───────────────── 6. 老会话 + 字节失配 + 类别可识别 + IP 不匹配 → 放行 + 迁移 ─────────────────
test('6. 老会话 + UA 失配 + 类别可识别 + **IP 不匹配** → ok=true + 触发迁移（v0.12.2 核心）', () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const calls = []
  const v = verifyFingerprint(mkReq(UA_MOBILE2, IP_DRIFT), s, [], 16, (sid, cls) => { calls.push([sid, cls]) })
  assert.equal(v.ok, true, 'v0.12.2：迁移不再要求 ipOk')
  assert.equal(v.reason, 'legacy-migrated-ip-drift')
  assert.equal(v.ipOk, false)
  assert.deepEqual(calls, [[s.sessionId, 'mobile']], '必须触发迁移回调')
})

test('6b. 老会话 + UA 失配 + 类别可识别 + IP 匹配 → legacy-migrated（reason 可区分）', () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const v = verifyFingerprint(mkReq(UA_MOBILE2, IP_BOUND), s, [], 16, noop)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'legacy-migrated', 'IP 也匹配时用不带 ip-drift 的 reason，日志一眼可辨')
  assert.equal(v.ipOk, true)
})

test('6c. v0.12.2 线上复刻：ipPrefix=60.12 + 老会话 + 当前 36.28 → 必须放行', () => {
  // 完全按线上那条记录构造：只有 ipPrefix 与 uaHash，没有 uaClass
  const s = {
    sessionId: 'ff684923-4371-400e-94a7-b6bc5f92ca4e',
    username: 'ptrel', role: 'user', expiresAt: Date.now() + 3600_000,
    bindIpPrefix: '60.12',
    bindUaHash: 'a4bb48293c',
  }
  const v = verifyFingerprint(mkReq(UA_MOBILE, '36.28.30.224'), s, [], 16, noop)
  assert.equal(v.ipOk, false, 'IP 确实不匹配（复刻现场）')
  assert.equal(v.ok, true, 'v0.12.2 必须放行 —— 这正是本次修复的目标')
  assert.equal(v.reason, 'legacy-migrated-ip-drift')
})

// ───────────────── 7. 老会话 + 类别 other → 拒绝且不迁移 ─────────────────
test("7. 老会话 + UA 失配 + 类别 'other' → ok=false，不迁移", () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const calls = []
  for (const ua of [UA_BOT, UA_CURL, '']) {
    const v = verifyFingerprint(mkReq(ua, IP_BOUND), s, [], 16, (sid, cls) => { calls.push(cls) })
    assert.equal(v.ok, false, JSON.stringify(ua))
    assert.equal(v.reason, 'mismatch', JSON.stringify(ua))
  }
  assert.deepEqual(calls, [], "'other' 绝不允许迁移（否则等于给脚本永久放行）")
})

// ───────────────── 8. 完全无指纹 → legacy ─────────────────
test("8. 完全无指纹 → ok=false, reason='legacy'", () => {
  for (const s of [
    { sessionId: 'a' },
    { sessionId: 'b', bindIpPrefix: '60.12' },
    { sessionId: 'c', bindUaHash: 'x' },
    null, undefined,
  ]) {
    const v = verifyFingerprint(mkReq(UA_MOBILE, IP_BOUND), s, [], 16, noop)
    assert.equal(v.ok, false, JSON.stringify(s))
    assert.equal(v.reason, 'legacy', JSON.stringify(s))
  }
})

// ───────────────── 9. ipDriftPolicy='deny' → 回到旧行为 ─────────────────
test("9. 【v0.12.4 H2】ipDriftPolicy='deny' → IP 不匹配即拒，reason='ip-denied'（非 mismatch）", () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const vDeny = verifyFingerprint(mkReq(UA_MOBILE, IP_DRIFT), s, [], 16, undefined, 'deny')
  assert.equal(vDeny.ok, false, 'deny 下 IP 漂移被拒')
  // ⚠️ v0.12.4 语义变更（审查 H2）：此前返回 'mismatch'，会被上层 recordMismatch 累加 →
  // 3 次吊销 → 移动用户配了 deny 当天被踢。现改为独立 reason 'ip-denied'，
  // 上层对该 reason 只审计不计数。
  assert.equal(vDeny.reason, 'ip-denied', "deny 场景必须是独立 reason 'ip-denied'")
  assert.notEqual(vDeny.reason, 'mismatch', 'mismatch 只留给真实 UA 类失配')
  // 同一会话在 allow 下放行 → 证明差异仅来自策略
  const vAllow = verifyFingerprint(mkReq(UA_MOBILE, IP_DRIFT), s, [], 16, undefined, 'allow')
  assert.equal(vAllow.ok, true)
  // IP 匹配时 deny 也放行（策略只管漂移）
  assert.equal(verifyFingerprint(mkReq(UA_MOBILE, IP_BOUND), s, [], 16, undefined, 'deny').ok, true)
})

test("9b. deny 下老会话 + IP 漂移 → 拒绝且不迁移", () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const calls = []
  const v = verifyFingerprint(mkReq(UA_MOBILE2, IP_DRIFT), s, [], 16, (sid, c) => { calls.push(c) }, 'deny')
  assert.equal(v.ok, false)
  assert.deepEqual(calls, [], 'deny 下不应迁移')
})

test('9c. 非法 policy 值回退 allow（配置写错不该全踢）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  for (const p of [undefined, null, '', 'DENY', 'yes', 42]) {
    const v = verifyFingerprint(mkReq(UA_MOBILE, IP_DRIFT), s, [], 16, undefined, p)
    assert.equal(v.ok, true, String(p) + ' 应回退 allow')
    assert.equal(v.reason, 'ip-drift', String(p))
  }
})

// ───────────────── 10/11. 吊销语义：drift 不计数、UA 失配才计数 ─────────────────
test('10. 连续 5 次 ip-drift 都是 ok=true（上层不会累加 mismatchCount）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  let okCount = 0
  for (let i = 0; i < 5; i++) {
    const v = verifyFingerprint(mkReq(UA_MOBILE, '36.' + (20 + i) + '.1.1'), s, [], 16)
    if (v.ok) okCount++
  }
  // 上层 findSessionVerified 只在 verdict.ok === false 时调 recordMismatch，
  // 故 ok=true 的 ip-drift 绝不会累加计数 —— 这里从纯函数行为验证前提成立。
  assert.equal(okCount, 5, '5 次全部 ok，因此绝不会触发 recordMismatch')
})

test('11. 连续 3 次真实 UA 类失配仍返回 ok=false（吊销路径未被破坏）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  let reject = 0
  for (let i = 0; i < 3; i++) {
    const v = verifyFingerprint(mkReq(UA_DESKTOP, IP_BOUND), s, [], 16)
    if (!v.ok) reject++
  }
  assert.equal(reject, 3, 'UA 类失配每次都 ok=false → 上层会累加并吊销')
})

// ───────────────── 12. 迁移幂等 ─────────────────
test('12. 迁移幂等：多次调用回调都收到同一 uaClass（不产生第二个值）', () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const seen = new Set()
  for (let i = 0; i < 3; i++) {
    verifyFingerprint(mkReq(UA_MOBILE2, IP_DRIFT2), s, [], 16, (sid, cls) => { seen.add(sid + '|' + cls) })
  }
  assert.equal(seen.size, 1, '三次都是同一 (sid, uaClass)，迁移写的是同一值')
})

// ───────────────── 13. 既有兜底路径未变 ─────────────────
test('13. 回环 / 白名单仍然直接放行，不看指纹', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const loopReq = { url: '/x', headers: { 'user-agent': UA_BOT, host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(verifyFingerprint(loopReq, s, [], 16).reason, 'loopback')
  assert.equal(verifyFingerprint(mkReq(UA_BOT, '10.1.2.3'), s, ['10.0.0.0/8'], 16).reason, 'whitelist')
})

// ───────────────── 20. 伪回环（frp 直连）不得因 ip-drift 放宽 ─────────────────
test('20. 伪回环：socket 回环 + Host 公网 → 拒绝（不受 ip-drift 影响）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  // 模拟 frp 直连：socket 恒为 127.0.0.1，Host 是公网域名/公网 IP
  const req = {
    url: '/api/x',
    headers: { 'user-agent': UA_MOBILE, host: '47.98.244.173:53080' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  for (const policy of [undefined, 'allow', 'deny']) {
    const v = verifyFingerprint(req, s, [], 16, noop, policy)
    assert.equal(v.ok, false, 'policy=' + policy + ' 伪回环必须拒绝')
    // v0.12.4：伪回环按 deny 语义 → reason 'ip-denied'（不是 mismatch，不计数吊销）
    assert.equal(v.reason, 'ip-denied')
    assert.notEqual(v.reason, 'loopback', '绝不能被判成 loopback')
    assert.notEqual(v.reason, 'ip-drift', '绝不能被 ip-drift 放行')
  }
})

test('20b. 伪回环 + 老会话 → 也不迁移', () => {
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const calls = []
  const req = {
    url: '/api/x',
    headers: { 'user-agent': UA_MOBILE2, host: 'dsh.example.com' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const v = verifyFingerprint(req, s, [], 16, (sid, c) => { calls.push(c) })
  assert.equal(v.ok, false)
  assert.deepEqual(calls, [], '伪回环不应触发迁移')
})

test('20c. 真回环（socket + Host 都回环）仍然放行 loopback', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const req = {
    url: '/api/x',
    headers: { 'user-agent': UA_BOT, host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const v = verifyFingerprint(req, s, [], 16)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'loopback')
})

// ───────────────── H1：哈希历史集合（熵不降级）─────────────────
test('H1-1. 哈希命中（当前值）→ match；哈希不命中但类别对 → ua-hash-drift', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const hit = verifyFingerprint(mkReq(UA_MOBILE, IP_BOUND), s, [], 16)
  assert.equal(hit.reason, 'match')
  assert.equal(hit.uaHashOk, true)
  const drift = verifyFingerprint(mkReq(UA_MOBILE2, IP_BOUND), s, [], 16)
  assert.equal(drift.ok, true, '仍放行（否则一升级就被踢）')
  assert.equal(drift.reason, 'ua-hash-drift', '哈希不命中 → 独立 reason')
  assert.equal(drift.uaHashOk, false)
})

test('H1-2. 历史集合中的哈希仍算 match（旧版本 UA 可继续用）', () => {
  const s = newSession(UA_MOBILE2, IP_BOUND, 'mobile')
  // 模拟：会话当前哈希是 MOBILE2，历史里有 MOBILE（上一次的版本）
  s.bindUaHashHistory = [uaHashOf(UA_MOBILE)]
  const v = verifyFingerprint(mkReq(UA_MOBILE, IP_BOUND), s, [], 16)
  assert.equal(v.reason, 'match', '历史哈希命中 → match')
  assert.equal(v.uaHashOk, true)
})

test('H1-3. 历史集合之外的哈希 → ua-hash-drift（不是 match）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  s.bindUaHashHistory = [uaHashOf(UA_TABLET)]   // 无关的历史
  const v = verifyFingerprint(mkReq(UA_MOBILE2, IP_BOUND), s, [], 16)
  assert.equal(v.reason, 'ua-hash-drift')
  assert.equal(v.uaHashOk, false)
})

test('H1-4. 迁移后熵不降级：哈希仍参与判定（旧实现只看类别）', () => {
  // 老会话迁移。注意这里的回调要**真的写回会话**（模拟 SessionsStore.migrateUaClass），
  // 否则第二次调用仍是老会话，测不到「迁移后的行为」。
  const s = legacySession(UA_MOBILE, IP_BOUND)
  const calls = []
  const onMigrate = (sid, cls, hash) => {
    calls.push([cls, hash])
    s.bindUaClass = cls
    if (s.bindUaHash && s.bindUaHash !== hash) s.bindUaHashHistory = [s.bindUaHash]
    s.bindUaHash = hash
  }
  verifyFingerprint(mkReq(UA_MOBILE2, IP_BOUND), s, [], 16, onMigrate)
  assert.deepEqual(calls, [['mobile', uaHashOf(UA_MOBILE2)]], '迁移回调必须带当前 UA 哈希')
  // 迁移后再用同 UA → 哈希命中 → match（证明哈希真的被刷新了）
  const v = verifyFingerprint(mkReq(UA_MOBILE2, IP_BOUND), s, [], 16)
  assert.equal(v.reason, 'match', '迁移后同一 UA 应命中新哈希 → match')
})

test('H1-5. ua-hash-drift 在 deny 策略下被拒（且用 ip-denied，不计数）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_MOBILE2, IP_BOUND), s, [], 16, undefined, 'deny')
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'ip-denied', "deny 下必须是 'ip-denied'（H2：不触发吊销）")
})

// ───────────────── H2：deny 下不吊销 ─────────────────
test('H2-1. 连续 5 次 deny 拒绝都是 ip-denied（不是 mismatch → 不计数）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  for (let i = 0; i < 5; i++) {
    const v = verifyFingerprint(mkReq(UA_MOBILE, '36.' + (20 + i) + '.1.1'), s, [], 16, undefined, 'deny')
    assert.equal(v.ok, false)
    assert.equal(v.reason, 'ip-denied', '第 ' + (i + 1) + ' 次')
    assert.notEqual(v.reason, 'mismatch')
  }
})

test('H2-2. deny 下真实 UA 类失配仍返回 mismatch（可计数可吊销）', () => {
  const s = newSession(UA_MOBILE, IP_BOUND, 'mobile')
  const v = verifyFingerprint(mkReq(UA_DESKTOP, IP_BOUND), s, [], 16, undefined, 'deny')
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'mismatch', 'UA 类失配必须仍是 mismatch → 上层计数')
})
