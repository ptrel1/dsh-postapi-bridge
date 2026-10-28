// v0.11.0 老会话 UA 指纹惰性迁移 —— 单测（纯函数，不启动服务）
//
// 测试策略：verifyFingerprint 保持纯函数，迁移通过可选第 5 参回调注入。
// 这里用一个内存 Map 当「会话库」，回调写入 Map，从而验证「迁移是否发生」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { __p0Helpers } from '../lib/index.js'

const { verifyFingerprint, uaHashOf, ipPrefixOf } = __p0Helpers

const UA_ANDROID_EDGE_155 = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36 EdgA/155.0.0.0'
const UA_ANDROID_EDGE_156 = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 EdgA/156.0.0.0'
const UA_DESKTOP_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const UA_CURL = 'curl/8.5.0'
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

// 构造一个「看似真实」的请求对象：bindIpOf 读 x-forwarded-for / socket；
// isStrictLoopback 读 socket.remoteAddress + Host（这里给非回环，走指纹分支）。
function makeReq (ua, ip = '36.28.30.224') {
  return {
    url: '/api/x',
    headers: {
      'user-agent': ua,
      'x-forwarded-for': ip,
      host: 'dsh.example.com',
    },
    socket: { remoteAddress: ip },
  }
}

// 老格式会话（v0.6.3 之前签发）：只有 bindUaHash，没有 bindUaClass
function legacySession (ua, ip = '36.28.30.224') {
  return {
    sessionId: 'sess-legacy-' + Math.random().toString(36).slice(2),
    username: 'alice',
    role: 'user',
    expiresAt: Date.now() + 3600_000,
    bindIpPrefix: ipPrefixOf(ip, 16),
    bindUaHash: uaHashOf(ua),
  }
}

// 新格式会话（v0.6.3+ 签发）：带 bindUaClass
function newSession (ua, ip = '36.28.30.224') {
  const s = {
    sessionId: 'sess-new-' + Math.random().toString(36).slice(2),
    username: 'alice',
    role: 'user',
    expiresAt: Date.now() + 3600_000,
    bindIpPrefix: ipPrefixOf(ip, 16),
    bindUaHash: uaHashOf(ua),
    bindUaClass: 'mobile',
  }
  return s
}

// 内存会话库 + 迁移回调（模拟 SessionsStore.migrateUaClass 的语义）
function makeStore (session) {
  const map = new Map([[session.sessionId, session]])
  const migrations = []
  const onMigrate = (sid, uaClass) => {
    const s = map.get(sid)
    if (!s) return false
    if (!['desktop', 'mobile', 'tablet'].includes(uaClass)) return false
    s.bindUaClass = uaClass
    migrations.push([sid, uaClass])
    return true
  }
  return { map, migrations, onMigrate }
}

// ───────────────────────── 1. 新会话行为完全不变（回归） ─────────────────────────
// ⚠️ v0.12.4 语义变更（审查 H1）：此前「类别相同即 match」，把锁从逐字节哈希(2^57)
// 降成了设备类别三选一(2^2) 且不可逆。现在 match 要求**哈希也命中**；
// 类别对但哈希未命中 → 独立 reason 'ua-hash-drift'（仍放行，但留审计痕迹、不算 match）。
test('1. 【v0.12.4 H1】新会话：UA 字节变化但类别相同 → 放行但 reason=ua-hash-drift（原为 match）', () => {
  const s = newSession(UA_ANDROID_EDGE_155)
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16, onMigrate)
  assert.equal(v.ok, true, '仍然放行（否则一升级就被踢）')
  assert.equal(v.reason, 'ua-hash-drift', '哈希未命中 → 独立 reason，不是 match')
  assert.equal(v.ipOk, true)
  assert.equal(v.uaOk, true, '类别匹配')
  assert.equal(v.uaHashOk, false, '哈希不匹配（这正是要留痕的事实）')
})

test('1b. 新会话：设备类别变化（mobile→desktop）→ 拒绝（mismatch）', () => {
  const s = newSession(UA_ANDROID_EDGE_155)
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_DESKTOP_CHROME), s, [], 16, onMigrate)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'mismatch')
  assert.equal(v.ipOk, true)
  assert.equal(v.uaOk, false)
  assert.equal(migrations.length, 0)
})

// ⚠️ v0.12.2 语义变更（同测试 4）：新会话 + IP 不匹配，旧版拒绝、新版按 ip-drift 放行。
test('1c. 【v0.12.2 语义变更】新会话：IP 不匹配 + UA 匹配 → 放行(ip-drift)（原为「拒绝」）', () => {
  const s = newSession(UA_ANDROID_EDGE_155)
  const { onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_155, '8.8.8.8'), s, [], 16, onMigrate)
  assert.equal(v.ok, true, 'v0.12.2：UA 匹配即放行，IP 漂移只改 reason')
  assert.equal(v.reason, 'ip-drift')
  assert.equal(v.ipOk, false, '仍如实报告 IP 不匹配，供审计区分')
  assert.equal(v.uaOk, true)
})

test('1d. 【v0.12.2 语义变更】同一场景在 deny 策略下仍拒绝（旧行为可恢复）', () => {
  const s = newSession(UA_ANDROID_EDGE_155)
  const { onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_155, '8.8.8.8'), s, [], 16, onMigrate, 'deny')
  assert.equal(v.ok, false)
  assert.equal(v.ipOk, false)
  assert.equal(v.uaOk, true)
})

// ─────────────────── 2. 老会话 + IP 匹配 + 类别可识别 → 通过并迁移 ───────────────────
test('2. 老会话：IP 匹配 + UA 可识别 → 通过，reason=legacy-migrated，bindUaClass 被写回', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const { migrations, onMigrate } = makeStore(s)
  assert.equal(s.bindUaClass, undefined, '迁移前无 bindUaClass')
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16, onMigrate)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'legacy-migrated')
  assert.equal(v.ipOk, true)
  assert.equal(v.uaOk, false, '逐字节仍未匹配（正是迁移要解决的场景）')
  assert.equal(v.uaClassActual, 'mobile')
  assert.equal(v.uaClassExpected, null, '老会话没有绑定过类别')
  assert.deepEqual(migrations, [[s.sessionId, 'mobile']])
  assert.equal(s.bindUaClass, 'mobile', '迁移必须落回会话对象')
})

// ─────────────────── 3. 老会话 + IP 匹配 + UA 为 bot/空 → 拒绝且不迁移 ───────────────────
test('3. 老会话：UA 为 bot → 拒绝且不迁移', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_BOT), s, [], 16, onMigrate)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'mismatch')
  assert.equal(v.ipOk, true)
  assert.equal(v.uaClassActual, 'other')
  assert.equal(migrations.length, 0, 'other 类别不得迁移')
  assert.equal(s.bindUaClass, undefined)
})

test('3b. 老会话：UA 为空 → 拒绝且不迁移', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(''), s, [], 16, onMigrate)
  assert.equal(v.ok, false)
  assert.equal(v.uaClassActual, 'other')
  assert.equal(migrations.length, 0)
  assert.equal(s.bindUaClass, undefined)
})

test('3c. 老会话：UA 为 curl → 拒绝且不迁移', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_CURL), s, [], 16, onMigrate)
  assert.equal(v.ok, false)
  assert.equal(migrations.length, 0)
})

// ─────────────────── 4. 老会话 + IP 不匹配 → 拒绝且不迁移 ───────────────────
// ⚠️ v0.12.2 语义变更：本条断言与旧版相反。
//   旧（v0.11.0～v0.12.1）：IP 不匹配 → 拒绝且不迁移（IP 是硬前提）。
//   新（v0.12.2 方案 A）：IP 降级为软证据 → **放行并迁移**，reason=legacy-migrated-ip-drift。
//   变更原因：线上移动网络换基站导致 ipPrefix 60.12 → 36.28，老会话因此永远被踢，
//   而 v0.11.0 的迁移前提恰好也是 ipOk —— 等于救不了最需要救的人。
//   旧断言（IP 不匹配即拒）保留在下面的 v0.12.2 测试里，用 ipDriftPolicy='deny' 验证可恢复。
test('4. 【v0.12.2 语义变更】老会话 + IP 不匹配 → **放行并迁移**（原为「拒绝且不迁移」）', () => {
  const s = legacySession(UA_ANDROID_EDGE_155, '36.28.30.224')
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156, '8.8.8.8'), s, [], 16, onMigrate)
  assert.equal(v.ok, true, 'v0.12.2：IP 不再一票否决')
  assert.equal(v.reason, 'legacy-migrated-ip-drift')
  assert.equal(v.ipOk, false, '仍如实报告 IP 不匹配')
  assert.equal(migrations.length, 1, '必须触发迁移')
  assert.equal(s.bindUaClass, 'mobile', '迁移后写入类别')
})

test('4b. 【新增】同一场景在 ipDriftPolicy=deny 下恢复旧行为：拒绝且不迁移', () => {
  const s = legacySession(UA_ANDROID_EDGE_155, '36.28.30.224')
  const { migrations, onMigrate } = makeStore(s)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156, '8.8.8.8'), s, [], 16, onMigrate, 'deny')
  assert.equal(v.ok, false)
  // v0.12.4 H2：deny 场景用独立 reason 'ip-denied'，上层不计数（否则配 deny 的用户会被吊销）
  assert.equal(v.reason, 'ip-denied')
  assert.equal(v.ipOk, false)
  assert.equal(migrations.length, 0)
  assert.equal(s.bindUaClass, undefined)
})

// ─────────────────── 5. 迁移后再次校验：UA 字节变、类别同 → 通过 ───────────────────
test('5. 迁移后：UA 字节再变但类别相同 → 走新逻辑通过（证明迁移真的生效）', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const { onMigrate } = makeStore(s)
  // 第一次：用**字节已漂移**的 UA（这才是线上真实场景）→ 触发迁移
  const v1 = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16, onMigrate)
  assert.equal(v1.reason, 'legacy-migrated')
  assert.equal(s.bindUaClass, 'mobile')
  // 第二次：又一个字节不同的 UA（155 版本），但仍是 mobile → 走新逻辑
  const v2 = verifyFingerprint(makeReq(UA_ANDROID_EDGE_155), s, [], 16, onMigrate)
  assert.equal(v2.ok, true)
  assert.equal(v2.reason, 'match', '迁移后必须走新分支（match），不再是 legacy-migrated')
  assert.equal(v2.uaOk, true)
})

// ─────────────────── 6. 迁移后设备类别变化 → 拒绝 ───────────────────
test('6. 迁移后：类别变化（mobile→desktop）→ 拒绝', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const { onMigrate } = makeStore(s)
  // 用字节不同的 UA 触发迁移（同字节会先命中 match，不迁移）
  verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16, onMigrate)
  assert.equal(s.bindUaClass, 'mobile')
  const v = verifyFingerprint(makeReq(UA_DESKTOP_CHROME), s, [], 16, onMigrate)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'mismatch')
  assert.equal(v.uaOk, false)
  assert.equal(v.uaClassExpected, 'mobile')
  assert.equal(v.uaClassActual, 'desktop')
})

// ─────────────────── 7. 无指纹会话 → 仍 fail-closed（legacy） ───────────────────
test('7. 无 bindIpPrefix / 无任何 UA 字段 → 仍 legacy 拒绝', () => {
  for (const s of [
    { sessionId: 'a' },                                            // 什么都没有
    { sessionId: 'b', bindIpPrefix: '36.28' },                     // 只有 IP
    { sessionId: 'c', bindUaHash: 'deadbeef' },                    // 只有 UA 哈希，无 IP
    { sessionId: 'd', bindIpPrefix: '36.28', bindUaHash: '', bindUaClass: '' },
    null,
    undefined,
  ]) {
    const { migrations, onMigrate } = makeStore({ sessionId: s?.sessionId || 'x', ...s })
    const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_155), s, [], 16, onMigrate)
    assert.equal(v.ok, false, JSON.stringify(s))
    assert.equal(v.reason, 'legacy', JSON.stringify(s))
    assert.equal(migrations.length, 0)
  }
})

// ─────────────────── 8. 缺回调（纯函数模式）行为与改动前一致 ───────────────────
test('8. 无回调时：老会话走原逐字节逻辑，不迁移、不抛错', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  // 与改动前完全一致：字节相同 → match（step1 优先，不进入迁移分支）
  const v1 = verifyFingerprint(makeReq(UA_ANDROID_EDGE_155), s, [], 16)
  assert.equal(v1.ok, true)
  assert.equal(v1.reason, 'match')
  assert.equal(s.bindUaClass, undefined, '无回调时不得自行迁移')
  // 字节不同但类别相同 → 无回调时…仍会走迁移分支（放行），只是没有落盘
  const v2 = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16)
  assert.equal(v2.ok, true)
  assert.equal(v2.reason, 'legacy-migrated')
  assert.equal(s.bindUaClass, undefined, '无回调 → 状态不变')
})

test('8b. 回调抛错不影响本次判定（fail-safe：本次仍按 ipOk+类别放行）', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16, () => { throw new Error('boom') })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'legacy-migrated')
})

test('8c. 回调返回 false（会话已不存在）时本次仍放行', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const v = verifyFingerprint(makeReq(UA_ANDROID_EDGE_156), s, [], 16, () => false)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'legacy-migrated')
})

// ─────────────────── 9. 回环 / 白名单优先级不变 ───────────────────
test('9. 严格回环 → 直接放行（loopback），不看指纹', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const req = {
    url: '/api/x',
    headers: { 'user-agent': UA_BOT, host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const v = verifyFingerprint(req, s, [], 16)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'loopback')
})

test('9b. 白名单 CIDR 命中 → 直接放行（whitelist）', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  const v = verifyFingerprint(makeReq(UA_BOT, '10.1.2.3'), s, ['10.0.0.0/8'], 16)
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'whitelist')
})

// ─────────────────── 10. 返回值新增字段契约 ───────────────────
test('10. 返回值始终带 ipOk / uaOk 布尔（供审计拆分）', () => {
  const s = legacySession(UA_ANDROID_EDGE_155)
  for (const [req, sess] of [
    [makeReq(UA_ANDROID_EDGE_156), s],
    [makeReq(UA_DESKTOP_CHROME), s],
    [makeReq(UA_ANDROID_EDGE_155, '8.8.8.8'), s],
  ]) {
    const v = verifyFingerprint(req, sess, [], 16)
    assert.equal(typeof v.ipOk, 'boolean', JSON.stringify(v))
    assert.equal(typeof v.uaOk, 'boolean', JSON.stringify(v))
  }
})

// ─────────────────── 11. SessionsStore.migrateUaClass 真实落盘 ───────────────────
test('11. migrateUaClass：写入 bindUaClass 并持久化到磁盘', async () => {
  const { SessionsStore } = await import('../lib/users-store.js')
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'mig-'))
  const ss = new SessionsStore()
  const sid = 'mig-' + Date.now().toString(36)
  ss.create(sid, 'alice', 'user', 3600_000, { ipPrefix: '36.28', uaHash: 'ead889c375f13877' })
  const before = ss.get(sid)
  assert.equal(before.bindUaClass, undefined, '迁移前无 bindUaClass')
  assert.equal(before.bindUaHash, 'ead889c375f13877', '老字段保留')

  assert.equal(ss.migrateUaClass(sid, 'mobile'), true)
  assert.equal(ss.get(sid).bindUaClass, 'mobile')
  assert.equal(ss.get(sid).bindUaHash, 'ead889c375f13877', 'append-only：原哈希不得被删')

  // 落盘校验：重新 new 一个 store 读同一文件
  const fresh = new SessionsStore()
  assert.equal(fresh.get(sid).bindUaClass, 'mobile', '必须已持久化')
})

test('11b. migrateUaClass：会话不存在返回 false；非法类别拒绝写入', async () => {
  const { SessionsStore } = await import('../lib/users-store.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'mig2-'))
  const ss = new SessionsStore()
  assert.equal(ss.migrateUaClass('no-such-session', 'mobile'), false)
  const sid = 'mig2-' + Date.now().toString(36)
  ss.create(sid, 'bob', 'user', 3600_000, { ipPrefix: '36.28', uaHash: 'x' })
  // other 类别不允许写入（防把「不可识别」迁成永久的放行依据）
  assert.equal(ss.migrateUaClass(sid, 'other'), false)
  assert.equal(ss.get(sid).bindUaClass, undefined)
  assert.equal(ss.migrateUaClass(sid, ''), false)
})
