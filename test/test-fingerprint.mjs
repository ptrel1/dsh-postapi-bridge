/**
 * P0 会话指纹绑定单元测试（PLAN-20260901-SEC01）
 * 覆盖：IP 段归并、UA 指纹、CIDR 白名单、指纹校验 verdict、失配计数吊销。
 * 运行：node test/test-fingerprint.mjs
 */
import assert from 'node:assert'
import { SessionsStore } from '../lib/users-store.js'

const mockReq = ({ ip, ua, xff }) => ({
  headers: { 'user-agent': ua, 'x-forwarded-for': xff },
  socket: { remoteAddress: ip },
})

const {
  ipPrefixOf, uaHashOf, cidrMatch, verifyFingerprint,
} = (await import('../lib/index.js')).__p0Helpers

// --- ipPrefixOf ---
assert.equal(ipPrefixOf('123.152.11.191', 24), '123.152.11')
assert.equal(ipPrefixOf('123.152.45.1', 24), '123.152.45')
assert.equal(ipPrefixOf('123.152.45.1', 16), '123.152')
assert.equal(ipPrefixOf('2408:8207:12ab:c1::5', 64), '2408:8207:12ab:c1')
assert.equal(ipPrefixOf('::ffff:123.152.11.191', 24), '123.152.11')

// --- bindIpOf 经 verifyFingerprint 间接验证：XFF 最后一跳优先 ---
// 攻击者在链首伪造 IP，最后一跳才是 nginx 见到的真实地址
const realIp = '123.152.11.191'
const session = { bindIpPrefix: ipPrefixOf(realIp, 24), bindUaHash: uaHashOf('Mozilla/5.0') }
const spoof = mockReq({ ip: '1.2.3.4', ua: 'Mozilla/5.0', xff: '9.9.9.9, ' + realIp })
assert.equal(verifyFingerprint(spoof, session, [], 24).ok, true, 'XFF 最后一跳应取真实 IP')

// --- 异地异 UA 盗用（0831 同款手法）→ mismatch ---
const stolen = mockReq({ ip: '1.2.3.4', ua: 'Python-urllib/3.10', xff: '1.2.3.4' })
const v1 = verifyFingerprint(stolen, session, [], 24)
assert.equal(v1.ok, false); assert.equal(v1.reason, 'mismatch')

// --- 同段换 IP 通过 ---
const v2 = verifyFingerprint(mockReq({ ip: '1.2.3.4', ua: 'Mozilla/5.0', xff: '123.152.11.77' }), session, [], 24)
assert.equal(v2.ok, true)

// --- 白名单网段放行 ---
const v3 = verifyFingerprint(mockReq({ ip: '1.2.3.4', ua: 'Python-urllib/3.10', xff: '192.168.1.100' }), session, ['192.168.0.0/16'], 24)
assert.equal(v3.ok, true); assert.equal(v3.reason, 'whitelist')
assert.equal(cidrMatch('192.168.1.100', '192.168.0.0/16'), true)
assert.equal(cidrMatch('192.169.1.100', '192.168.0.0/16'), false)

// --- loopback 恒放行 ---
const v4 = verifyFingerprint(mockReq({ ip: '127.0.0.1', ua: 'x', xff: '' }), session, [], 24)
assert.equal(v4.ok, true); assert.equal(v4.reason, 'loopback')

// --- legacy 无指纹会话 fail-closed ---
const v5 = verifyFingerprint(stolen, { username: 'ptrel' }, [], 24)
assert.equal(v5.ok, false); assert.equal(v5.reason, 'legacy')

// --- SessionsStore 失配计数：3 次吊销 ---
const store = new SessionsStore('/tmp/p0-test-sessions-' + Date.now() + '.json')
store.create('sid-x', 'ptrel', 'admin', 86400000, { ipPrefix: '123.152.11', uaHash: 'a'.repeat(16) })
assert.equal(store.recordMismatch('sid-x'), 'mismatch')
assert.equal(store.recordMismatch('sid-x'), 'mismatch')
assert.equal(store.recordMismatch('sid-x'), 'revoked')
assert.equal(store.get('sid-x'), undefined)
// 成功归零
store.create('sid-y', 'ptrel', 'user', 86400000, { ipPrefix: '1.1.1', uaHash: 'b'.repeat(16) })
store.recordMismatch('sid-y'); store.resetMismatch('sid-y')
assert.equal(store.get('sid-y').mismatchCount, undefined)

console.log('P0 fingerprint tests: ALL PASS')
