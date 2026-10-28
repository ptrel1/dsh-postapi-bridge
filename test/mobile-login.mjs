// v0.8.0 mobile-login 纯函数单测（不启动服务、不触碰运行时状态）
import test from 'node:test'
import assert from 'node:assert/strict'
import { __mobileLoginHelpers } from '../lib/index.js'

const { normalizeAuthority, normalizeScheme } = __mobileLoginHelpers

test('normalizeAuthority: 合法 host 原样通过', () => {
  for (const h of ['localhost', '127.0.0.1', '127.0.0.1:3080', 'dsh.example.com',
                   'dsh.example.com:53080', 'my-host.local', '[::1]', '[::1]:3080']) {
    assert.equal(normalizeAuthority(h).ok, true, h)
    assert.equal(normalizeAuthority(h).host, h)
  }
})

test('normalizeAuthority: 注入/SSRF 形态一律拒绝', () => {
  for (const h of ['', '   ', 'http://evil.com', '//evil.com', 'evil.com/path',
                   'evil.com?x=1', 'evil.com#f', 'user@evil.com', 'evil.com\r\nX: y',
                   'evil.com ', ' evil.com', '::1', 'a:b:c', '[::1]:0', '[]', '[::1]:99999', '::1:3080', 'a..b', '.evil.com', 'evil.com.', 'evil.com:0',
                   'evil.com:99999', 'evil.com:abc', 'evil_com', 'evil.com:80:81']) {
    assert.equal(normalizeAuthority(h).ok, false, JSON.stringify(h))
  }
})

test('normalizeAuthority: 超长截断拒绝', () => {
  assert.equal(normalizeAuthority('a'.repeat(300)).ok, false)
})

test('normalizeScheme: 只允许 http/https，缺省 https', () => {
  assert.deepEqual(normalizeScheme('https'), { ok: true, scheme: 'https', from: 'explicit' })
  assert.deepEqual(normalizeScheme('HTTP'), { ok: true, scheme: 'http', from: 'explicit' })
  assert.equal(normalizeScheme('').scheme, 'https')
  assert.equal(normalizeScheme('').from, 'default')
  for (const s of ['ftp', 'javascript', 'file', 'https ', ' ws', 'ws']) {
    assert.equal(normalizeScheme(s).ok, false, s)
  }
})

test('normalizeScheme: 大小写与首尾空白归一', () => {
  assert.equal(normalizeScheme('HTTPS').scheme, 'https')
  // 首尾空白判非法（不静默清洗）
  assert.equal(normalizeScheme(' HTTPS ').ok, false)
})
