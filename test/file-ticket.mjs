// v0.9.0 file ticket 纯函数单测（不启动服务、不碰真实权限）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __fileTicketHelpers } from '../lib/index.js'

const {
  signFileTicket, verifyFileTicket, newTicketId, ticketStateOf,
  rfc5987Encode, isRealpathInside, parseRangeHeader, redactAuditPath,
  FILE_TICKET_DEFAULT_ACTIVATE_HOURS, FILE_TICKET_DEFAULT_SESSION_HOURS,
  FILE_TICKET_VERSION, FILE_TICKET_STATE_VERSION,
} = __fileTicketHelpers

const SECRET = 'unit-test-secret'
const H = 3600 * 1000
const AH = FILE_TICKET_DEFAULT_ACTIVATE_HOURS   // 48
const SH = FILE_TICKET_DEFAULT_SESSION_HOURS    // 5
const T0 = 1700000000000
const base = { v: FILE_TICKET_VERSION, tid: 'a1b2c3d4e5f60718', sid: 'sess-1', seq: 7, index: 0, uid: 'alice' }

test('token 编码/解码往返（载荷无 exp）', () => {
  const { token } = signFileTicket(base, SECRET)
  const v = verifyFileTicket(token, SECRET)
  assert.equal(v.ok, true)
  assert.deepEqual(v.payload, base)
  assert.equal('exp' in v.payload, false, 'exp 不得出现在载荷里（时效由服务端状态判定）')
})

test('token 只含 URL 安全字符', () => {
  assert.match(signFileTicket(base, SECRET).token, /^[A-Za-z0-9_.-]+$/)
})

test('换 secret 验签失败', () => {
  const { token } = signFileTicket(base, SECRET)
  assert.deepEqual(verifyFileTicket(token, 'other'), { ok: false, reason: 'signature' })
})

test('篡改 payload 复用旧签名 → 验签失败', () => {
  const { token } = signFileTicket(base, SECRET)
  const [, sig] = token.split('.')
  const tampered = Buffer.from(JSON.stringify({ ...base, uid: 'bob' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.deepEqual(verifyFileTicket(tampered + '.' + sig, SECRET), { ok: false, reason: 'signature' })
})

test('结构非法 → 一律拒绝', () => {
  for (const bad of ['', 'abc', '.', 'a.', '.b', 'a.b.c', 'bad token!']) {
    const v = verifyFileTicket(bad, SECRET)
    assert.equal(v.ok, false, JSON.stringify(bad))
    assert.ok(v.reason === 'structure' || v.reason === 'signature', JSON.stringify(bad))
  }
})

test('多段 token 必须被拒', () => {
  const { token } = signFileTicket(base, SECRET)
  assert.equal(verifyFileTicket(token + '.extra', SECRET).ok, false)
  assert.equal(verifyFileTicket('x.' + token, SECRET).ok, false)
})

test('版本不符 → version', () => {
  const { token } = signFileTicket({ ...base, v: 99 }, SECRET)
  assert.deepEqual(verifyFileTicket(token, SECRET), { ok: false, reason: 'version' })
})

test('字段类型非法 → fields（含 ticketId 必须 16 hex）', () => {
  for (const bad of [
    { ...base, tid: '' }, { ...base, tid: 'XYZ' }, { ...base, tid: 'a1b2c3d4' },
    { ...base, tid: 'a1b2c3d4e5f60718ff' }, { ...base, tid: '../../etc/passwd' },
    { ...base, sid: '' }, { ...base, seq: -1 }, { ...base, seq: 1.5 },
    { ...base, index: -2 }, { ...base, uid: '' },
  ]) {
    const { token } = signFileTicket(bad, SECRET)
    assert.deepEqual(verifyFileTicket(token, SECRET), { ok: false, reason: 'fields' }, JSON.stringify(bad))
  }
})

test('ticketId：16 hex 且随机不重复', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i++) {
    const id = newTicketId()
    assert.match(id, /^[0-9a-f]{16}$/)
    ids.add(id)
  }
  assert.equal(ids.size, 200)
})

test('未激活：48h 内可用（含边界），到点失效', () => {
  const r = { issuedAt: T0, activatedAt: null }
  assert.equal(ticketStateOf(r, T0).state, 'pending')
  assert.equal(ticketStateOf(r, T0 + 47 * H).state, 'pending')
  assert.equal(ticketStateOf(r, T0 + AH * H - 1).state, 'pending')
  // 按「有效期半开区间」：deadline 那一刻即失效
  assert.deepEqual(ticketStateOf(r, T0 + AH * H), { state: 'expired', reason: 'activate-window-elapsed', deadline: T0 + AH * H })
})

test('已激活：5h 内可用（含边界-1），到点失效', () => {
  const r = { issuedAt: T0, activatedAt: T0 + H }
  assert.equal(ticketStateOf(r, T0 + H).state, 'active')
  assert.equal(ticketStateOf(r, T0 + H + SH * H - 1).state, 'active')
  assert.deepEqual(ticketStateOf(r, T0 + H + SH * H), { state: 'expired', reason: 'session-window-elapsed', deadline: T0 + H + SH * H })
})

test('激活窗口与 48h 无关：第 47h 激活仍可用满 5h', () => {
  const r = { issuedAt: T0, activatedAt: T0 + 47 * H }
  assert.equal(ticketStateOf(r, T0 + 47 * H + 4 * H).state, 'active')
  assert.equal(ticketStateOf(r, T0 + 47 * H + SH * H).state, 'expired')
})

test('缺失/脏数据 → expired', () => {
  assert.deepEqual(ticketStateOf(undefined, T0), { state: 'expired', reason: 'missing' })
  assert.deepEqual(ticketStateOf(null, T0), { state: 'expired', reason: 'missing' })
  assert.deepEqual(ticketStateOf({ issuedAt: 0 }, T0), { state: 'expired', reason: 'bad-issued-at' })
  assert.deepEqual(ticketStateOf({ issuedAt: T0, activatedAt: -5 }, T0), { state: 'expired', reason: 'bad-activated-at' })
})

test('配置非正数回退默认', () => {
  const r = { issuedAt: T0, activatedAt: null }
  // activateHours=0 → 回退 48
  assert.equal(ticketStateOf(r, T0 + 47 * H, 0, 5).state, 'pending')
  assert.equal(ticketStateOf(r, T0 + 49 * H, -1, 5).state, 'expired')
  // sessionHours=0 → 回退 5
  const a = { issuedAt: T0, activatedAt: T0 }
  assert.equal(ticketStateOf(a, T0 + 4 * H, 48, 0).state, 'active')
  assert.equal(ticketStateOf(a, T0 + 6 * H, 48, undefined).state, 'expired')
})

test('无次数限制：同一时刻反复判定都是 active（不存在 consumed）', () => {
  const r = { issuedAt: T0, activatedAt: T0 }
  for (let i = 0; i < 5; i++) assert.equal(ticketStateOf(r, T0 + i * 1000).state, 'active')
})

test('RFC5987 编码', () => {
  assert.equal(rfc5987Encode('报告.pdf'), '%E6%8A%A5%E5%91%8A.pdf')
  assert.equal(rfc5987Encode('a b.txt'), 'a%20b.txt')
  assert.equal(rfc5987Encode("a'b.txt"), 'a%27b.txt')
  assert.equal(rfc5987Encode('a(b).txt'), 'a%28b%29.txt')
  assert.equal(rfc5987Encode('a*b.txt'), 'a%2Ab.txt')
  assert.ok(!/[ '"()*]/.test(rfc5987Encode('复 杂 名 (1)*.docx')))
})

test('realpath 归属：工作区内放行', () => {
  const root = mkdtempSync(join(tmpdir(), 'tail-'))
  const sub = join(root, 'a', 'b')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'x.txt'), 'hi')
  assert.equal(isRealpathInside(join(sub, 'x.txt'), root), true)
  assert.equal(isRealpathInside(root, root), true)
})

test('realpath 归属：../ 逃逸被拒', () => {
  const root = mkdtempSync(join(tmpdir(), 'tail-'))
  mkdirSync(join(root, 'ws'), { recursive: true })
  writeFileSync(join(root, 'outside.txt'), 'secret')
  assert.equal(isRealpathInside(join(root, 'ws', '..', 'outside.txt'), join(root, 'ws')), false)
})

test('realpath 归属：符号链接逃逸被拒（前缀会误放行）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tail-'))
  const ws = join(root, 'ws')
  mkdirSync(ws)
  writeFileSync(join(root, 'secret.txt'), 's')
  symlinkSync(join(root, 'secret.txt'), join(ws, 'link.txt'))
  assert.equal(join(ws, 'link.txt').startsWith(ws), true)
  assert.equal(isRealpathInside(join(ws, 'link.txt'), ws), false)
})

test('realpath 归属：/a/bc 不属于 /a/b', () => {
  const root = mkdtempSync(join(tmpdir(), 'tail-'))
  const a = join(root, 'a')
  mkdirSync(a); mkdirSync(join(a, 'bc')); mkdirSync(join(root, 'ab'))
  assert.equal(isRealpathInside(join(a, 'bc'), a), true)
  assert.equal(isRealpathInside(join(root, 'ab'), a), false)
})

test('realpath 归属：路径不存在 → false', () => {
  const root = mkdtempSync(join(tmpdir(), 'tail-'))
  assert.equal(isRealpathInside(join(root, 'nope.txt'), root), false)
  assert.equal(isRealpathInside('/etc/passwd', '/nonexistent-root'), false)
})

test('Range 解析：单区间与开放区间', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRangeHeader('bytes=10-', 100), { start: 10, end: 99 })
  assert.deepEqual(parseRangeHeader('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRangeHeader('bytes=0-9999', 10), { start: 0, end: 9 })
})

test('Range 解析：不可满足 / 忽略', () => {
  assert.deepEqual(parseRangeHeader('bytes=100-', 10), { unsatisfiable: true })
  assert.deepEqual(parseRangeHeader('bytes=-0', 10), { unsatisfiable: true })
  for (const h of [undefined, '', 'items=0-1', 'bytes=0-1,5-6', 'bytes=abc']) {
    assert.deepEqual(parseRangeHeader(h, 100), { ignore: true }, String(h))
  }
})

test('审计路径脱敏：下载 token 不落盘', () => {
  const { token } = signFileTicket(base, SECRET)
  assert.equal(redactAuditPath('/file/' + token), '/file/<redacted>')
  assert.equal(redactAuditPath('/task'), '/task')
  assert.ok(!redactAuditPath('/file/' + token).includes(token.slice(0, 12)))
})

test('常量约定：48h / 5h / v2 / 状态文件 v1', () => {
  assert.equal(FILE_TICKET_DEFAULT_ACTIVATE_HOURS, 48)
  assert.equal(FILE_TICKET_DEFAULT_SESSION_HOURS, 5)
  assert.equal(FILE_TICKET_VERSION, 2)
  assert.equal(FILE_TICKET_STATE_VERSION, 1)
})
