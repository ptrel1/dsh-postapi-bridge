/**
 * P0 会话指纹绑定单元测试（PLAN-20260901-SEC01）
 * 覆盖：IP 段归并、UA 指纹、CIDR 白名单、指纹校验 verdict、失配计数吊销。
 * 运行：node test/test-fingerprint.mjs
 */
import assert from 'node:assert'
import { SessionsStore } from '../lib/users-store.js'

const mockReq = ({ ip, ua, xff, host }) => ({
  headers: { 'user-agent': ua, 'x-forwarded-for': xff, host: host || 'dsh.ptrel.cc.cd' },
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

// --- loopback 恒放行(socket 与 Host 双回环) ---
const v4 = verifyFingerprint(mockReq({ ip: '127.0.0.1', ua: 'x', xff: '', host: '127.0.0.1:3080' }), session, [], 24)
assert.equal(v4.ok, true); assert.equal(v4.reason, 'loopback')

// --- 审查修复回归: socket 回环但 Host 公网(frp直连 IP:53080) → 不得放行 ---
const v4b = verifyFingerprint(mockReq({ ip: '127.0.0.1', ua: 'Mozilla/5.0', xff: '', host: '47.98.244.173:53080' }), session, [], 24)
assert.equal(v4b.ok, false, 'frp直连伪回环必须拦截')

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

// ==================== v1.9.4：伪回环判定不许误伤正常反代 ====================
//
// 背景（20261104 实踩）：frp / nginx 这类正常反向代理，socket 恒为回环、
// Host 恒为域名，但**带着可信 XFF**。旧代码只看「socket 回环 + Host 非回环」
// 就判成伪回环，于是一刀 deny —— 连「UA 类别对、仅哈希变了」也拒。
// 后果：App 改一次 UA 字符串，所有走 frp 的用户全部登录失效。
//
// 判据是「有没有可信 XFF」：有 → 真实 IP 可判，按正常逻辑走；
// 无 → 才是真的借道回环端口，保持 deny。

const uaNow = 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 DSH-PostAPI-Android'
const uaOld = 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 DSH-PostAPI-Android/0.1'
// 会话：同 IP 段、类别 mobile、哈希是旧 UA
const frpSession = {
  bindIpPrefix: ipPrefixOf('36.21.129.243', 24),
  bindUaHash: uaHashOf(uaOld),
  bindUaClass: 'mobile',
}

// ① 正常 frp 代理 + UA 哈希漂移 → 必须放行（ua-hash-drift），不能 deny
const frpReq = mockReq({ ip: '127.0.0.1', ua: uaNow, xff: '36.21.129.243' })
const vFrp = verifyFingerprint(frpReq, frpSession, [], 24, undefined, 'allow')
assert.equal(vFrp.ok, true, '正常 frp 代理下 UA 哈希漂移应放行，实际 reason=' + vFrp.reason)
assert.equal(vFrp.reason, 'ua-hash-drift')

// ② 真伪回环（无 XFF，借道回环端口）→ 仍须拒绝
//    这是原设计的防线，不能被上面的修正削弱
const fakeReq = {
  headers: { 'user-agent': uaNow, host: 'dsh.ptrel.cc.cd' },
  socket: { remoteAddress: '127.0.0.1' },
}
const vFake = verifyFingerprint(fakeReq, frpSession, [], 24, undefined, 'allow')
assert.equal(vFake.ok, false, '无 XFF 的伪回环必须拒绝')
assert.equal(vFake.reason, 'ip-denied')

// ③ 正常 frp + 类别不匹配（真的盗用）→ 仍须 mismatch 并计数
const stolenUA = mockReq({ ip: '127.0.0.1', ua: 'Python-urllib/3.10', xff: '36.21.129.243' })
const vStolen = verifyFingerprint(stolenUA, frpSession, [], 24, undefined, 'allow')
assert.equal(vStolen.ok, false, '类别不匹配仍须拒绝')
assert.equal(vStolen.reason, 'mismatch')

console.log('fingerprint: all assertions passed')
