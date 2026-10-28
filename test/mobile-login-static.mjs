// v0.8.0 静态断言：/mobile-login 分流行号必须在 token 校验之前。
// 存在理由：新端点免 Bearer，一旦被后人挪到 token 校验之后就会「永远 401」，
// 这种回归用运行时测试很难发现（需要构造完整 ctx），故用纯文本行号断言兜住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8').split('\n')
const lineNo = (pred) => {
  const i = src.findIndex(pred)
  return i === -1 ? -1 : i + 1
}

test('mobile-login 分流行号 < apiToken fail-fast 行号 < isLoopback 校验行号', () => {
  const mobileLine = lineNo((l) => l.includes("req.method === 'POST' && subPath === '/mobile-login'"))
  const apiTokenLine = lineNo((l) => l.includes('if (!apiToken) {') && l.startsWith('    if'))
  const loopbackLine = lineNo((l) => l.includes('if (!isLoopback) {') && l.startsWith('    if'))
  const methodLine = lineNo((l) => l.trim().startsWith("if (req.method !== 'POST')"))

  assert.ok(mobileLine > 0, 'mobile-login 分流存在')
  assert.ok(apiTokenLine > 0, 'apiToken fail-fast 存在')
  assert.ok(loopbackLine > 0, 'isLoopback 校验存在')
  assert.ok(methodLine > 0, '405 方法守卫存在')
  assert.ok(mobileLine < apiTokenLine, `mobile(${mobileLine}) 必须早于 apiToken(${apiTokenLine})`)
  assert.ok(mobileLine < loopbackLine, `mobile(${mobileLine}) 必须早于 isLoopback(${loopbackLine})`)
  assert.ok(mobileLine < methodLine, `mobile(${mobileLine}) 必须早于 405 守卫(${methodLine})`)
})

test('白名单只放行 POST（GET 不进入 mobile 分支）', () => {
  const mobileLine = lineNo((l) => l.includes("req.method === 'POST' && subPath === '/mobile-login'"))
  const text = src[mobileLine - 1]
  assert.ok(text.includes("req.method === 'POST'"), '条件必须含 POST 判断')
})

test('限流复用 stepup 机制（未新造计数器）', () => {
  const text = src.join('\n')
  const handlerStart = src.findIndex((l) => l.includes('const handleMobileLogin'))
  const handlerEnd = src.findIndex((l, i) => i > handlerStart && l === '  }')
  const body = src.slice(handlerStart, handlerEnd).join('\n')
  assert.ok(body.includes('stepupThrottled(throttleIp)'), '必须调用 stepupThrottled')
  assert.ok(body.includes('stepupRecordFail(throttleIp)'), '必须调用 stepupRecordFail')
  assert.ok(!/const\s+(mobile\w*Fails|fails)\s*=\s*new Map/.test(text), '不得新造限流表')
})

test('审计事件名齐全且不含密码字段', () => {
  const text = src.join('\n')
  for (const ev of ['mobile-login-ok', 'mobile-login-failed', 'mobile-login-throttled']) {
    assert.ok(text.includes(ev), ev)
  }
  const handlerStart = src.findIndex((l) => l.includes('const handleMobileLogin'))
  const handlerEnd = src.findIndex((l, i) => i > handlerStart && l === '  }')
  const body = src.slice(handlerStart, handlerEnd).join('\n')
  assert.ok(!/password\s*:/.test(body.replace(/typeof body\[field\]/g, '')), '审计不得记录 password')
})

test('AUDIT_VERSION 与 package.json 版本一致（不写死版本号，避免每次升版都要改测试）', () => {
  const text = src.join('\n')
  const m = text.match(/const AUDIT_VERSION = '([^']+)'/)
  assert.ok(m, 'AUDIT_VERSION 声明存在')
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(m[1], pkg.version, '两者必须同步（历史上曾滞后）')
})
