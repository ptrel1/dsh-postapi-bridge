// v0.11.1 maskDownloadUrl 运行时单测：证明日志里的 token 不可还原
import test from 'node:test'
import assert from 'node:assert/strict'

// 从 client.js 抽出两个纯函数（该文件是浏览器 bundle 包装，用源码切片求值避免模拟 window）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

function extractFn(name) {
  const start = raw.indexOf('function ' + name + '(')
  if (start === -1) throw new Error('not found: ' + name)
  // 用花括号配平取出完整函数体
  let depth = 0, i = raw.indexOf('{', start), started = false
  for (; i < raw.length; i++) {
    if (raw[i] === '{') { depth++; started = true }
    else if (raw[i] === '}') { depth--; if (started && depth === 0) { i++; break } }
  }
  return raw.slice(start, i)
}

const src = extractFn('maskDownloadUrl')
const maskDownloadUrl = new Function('return (' + src + ')')()

const TOKEN = 'ab12cd34ef56ab78deadbeefcafebabe0123456789abcdef0123456789abcdef'
const MASKED = '/api/dsh/v1/file/ab12****************cdef'   // 前 4 = ab12，后 4 = cdef

test('中文/长 token：保留前后各 4 位，中间打码', () => {
  const m = maskDownloadUrl('/api/dsh/v1/file/' + TOKEN)
  assert.equal(m, MASKED)
  assert.ok(!m.includes(TOKEN), '不得包含完整 token')
  // 中段（除首尾 4 位外）一个字符都不能出现
  const middle = TOKEN.slice(4, -4)
  for (let i = 0; i < middle.length; i += 8) {
    assert.ok(!m.includes(middle.slice(i, i + 8)), '不得泄露 token 中段')
  }
})

test('绝对 URL 也能脱敏（只输出 path）', () => {
  const m = maskDownloadUrl('https://dsh.example.com/api/dsh/v1/file/' + TOKEN)
  assert.equal(m, MASKED)
})

test('短 token：整段打码，不暴露任何位', () => {
  const m = maskDownloadUrl('/api/dsh/v1/file/shorttok')
  assert.ok(m.endsWith('/****'), m)
  assert.ok(!m.includes('shorttok'))
})

test('不可解析输入 → 固定占位，不回退原串（防泄露）', () => {
  // 注意：裸 Symbol 经 String() 会变 'Symbol(x)'，是合法相对路径，不会抛错。
  // 真正会让 new URL 抛错的是「base 非法的字符串」场景，这里用 toString 抛错的
  // 对象来模拟（等价于任意异常输入），确认走 catch 分支且不回显原值。
  const evil = { toString () { throw new Error('nope') } }
  const m = maskDownloadUrl(evil)
  assert.equal(m, '<unparsable-url>')
  assert.ok(!m.includes('nope'), '异常信息不得回显')
})

test('其余路径段保持可读（便于排查是否走错前缀）', () => {
  const m = maskDownloadUrl('/api/dsh/v1/file/' + TOKEN)
  assert.ok(m.startsWith('/api/dsh/v1/file/'), '前缀段必须可读，否则无法判断 apiPrefix 是否正确')
})
