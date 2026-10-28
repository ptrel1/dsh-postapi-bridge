// v1.2.0：旧 WebView 兼容 polyfill 的单元测试。
//
// 背景：安卓 App 的 WebView 报 `AbortSignal.any is not a function`，该调用来自
//   **DSH 官方客户端**（@deepseek-ai/dsh-api-gateway，271 处），不是本插件代码。
//   我们在 factory 最先几行补上这些 API，让官方代码跑到时能正常工作。
//
// 测试策略：
//   Node 26 已原生支持全部这些 API —— 若直接 import，polyfill 会因守卫而**全部跳过**，
//   等于什么都没测。所以每条用例先**删掉原生实现**，再重新求值 client bundle，
//   逼 polyfill 真正安装，然后按标准语义逐条验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')
const source = readFileSync(CLIENT, 'utf8')

/** 最小 React 替身（factory 只需要这几个成员） */
const reactStub = {
  useEffect: () => {},
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  createElement: (...args) => ({ type: 'element', args }),
}

/** 在没有原生实现的全局上求值 client.js，返回本次实际安装的 polyfill 列表 */
function evalBundle () {
  let captured = null
  const fakeWindow = { __ModuleLoader__: { load (def) { captured = def } } }
  const run = new Function('window', 'document', 'location', 'AbortSignal', 'AbortController', 'Promise', 'Array', 'String', source)
  run(fakeWindow, undefined, undefined, globalThis.AbortSignal, globalThis.AbortController, globalThis.Promise, globalThis.Array, globalThis.String)
  if (!captured) throw new Error('client.js 未调用 __ModuleLoader__.load')
  captured.factory((id) => { if (id === 'react') return reactStub; throw new Error('unexpected require: ' + id) })
  return fakeWindow.__postapiPolyfilled || []
}

// ───────────── AbortSignal.any ─────────────
test('AbortSignal.any：单个 signal abort → 结果 abort 且 reason 透传', () => {
  delete AbortSignal.any
  const installed = evalBundle()
  assert.ok(installed.includes('AbortSignal.any'), 'polyfill 必须被安装，实际：' + JSON.stringify(installed))
  assert.equal(typeof AbortSignal.any, 'function')

  const a = new AbortController()
  const any = AbortSignal.any([a.signal])
  assert.equal(any.aborted, false, '初始不应 aborted')
  a.abort('why')
  assert.equal(any.aborted, true)
  assert.equal(any.reason, 'why', 'reason 必须透传')
})

test('AbortSignal.any：多个 signal 中第二个 abort → 结果 abort', () => {
  delete AbortSignal.any
  evalBundle()
  const a = new AbortController()
  const b = new AbortController()
  const any = AbortSignal.any([a.signal, b.signal])
  assert.equal(any.aborted, false, '初始不应 aborted')
  // 只 abort 第二个（a 保持未 abort），验证「任一入参 abort 即触发」
  b.abort('second')
  assert.equal(any.aborted, true)
  assert.equal(any.reason, 'second')
})

test('AbortSignal.any：空数组 → 永不 abort', () => {
  delete AbortSignal.any
  evalBundle()
  const any = AbortSignal.any([])
  assert.equal(any.aborted, false)
  // 等一个宏任务，确认它不会自己 abort
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(any.aborted, false, '空数组的 signal 永远不 abort')
    resolve()
  }, 20))
})

test('AbortSignal.any：入参已有 aborted 的 signal → 立即 aborted，reason 取该入参', () => {
  delete AbortSignal.any
  evalBundle()
  const pre = new AbortController()
  pre.abort('already')
  const b = new AbortController()
  const any = AbortSignal.any([b.signal, pre.signal])
  // 关键：必须**同步**就是 aborted，不能等事件
  assert.equal(any.aborted, true, '已有 aborted 入参时必须立刻 aborted')
  assert.equal(any.reason, 'already')
})

test('AbortSignal.any：触发后移除其余监听器（防泄漏）', () => {
  delete AbortSignal.any
  evalBundle()
  const a = new AbortController()
  const b = new AbortController()
  let bListeners = 0
  const origAdd = b.signal.addEventListener.bind(b.signal)
  const origRemove = b.signal.removeEventListener.bind(b.signal)
  b.signal.addEventListener = function (type, fn, opts) { if (type === 'abort') bListeners++; return origAdd(type, fn, opts) }
  b.signal.removeEventListener = function (type, fn) { if (type === 'abort') bListeners--; return origRemove(type, fn) }
  AbortSignal.any([a.signal, b.signal])
  assert.equal(bListeners, 1, 'b 上应注册 1 个监听')
  a.abort('go')
  assert.equal(bListeners, 0, 'a 触发后必须移除 b 上的监听器')
})

test('AbortSignal.any：已存在原生实现时不覆盖', () => {
  // 恢复正常原生实现
  const nativeAny = evalBundle()
  // Node 26 有原生 any —— 由于我们前面 delete 过，这里重新赋一个哨兵验证「不覆盖」
  const sentinel = function () { return 'sentinel' }
  AbortSignal.any = sentinel
  const installed = evalBundle()
  assert.ok(!installed.includes('AbortSignal.any'), '已存在时不得再补')
  assert.equal(AbortSignal.any, sentinel, '不得覆盖已有实现')
})

// ───────────── AbortSignal.timeout ─────────────
test('AbortSignal.timeout：超时后 abort，reason 是 TimeoutError', async () => {
  delete AbortSignal.timeout
  const installed = evalBundle()
  assert.ok(installed.includes('AbortSignal.timeout'))
  const sig = AbortSignal.timeout(10)
  assert.equal(sig.aborted, false, '未超时不应 abort')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(sig.aborted, true, '超时后必须 abort')
  assert.equal(sig.reason && sig.reason.name, 'TimeoutError')
})

// ───────────── Promise.withResolvers ─────────────
test('Promise.withResolvers：resolve / reject / promise 三件套', async () => {
  const native = Promise.withResolvers
  delete Promise.withResolvers
  const installed = evalBundle()
  assert.ok(installed.includes('Promise.withResolvers'))

  const d1 = Promise.withResolvers()
  assert.equal(typeof d1.promise.then, 'function')
  d1.resolve(42)
  assert.equal(await d1.promise, 42)

  const d2 = Promise.withResolvers()
  d2.reject(new Error('nope'))
  await assert.rejects(d2.promise, /nope/)

  Promise.withResolvers = native
})

// ───────────── Array.prototype.at ─────────────
test('Array.prototype.at：正负索引与越界', () => {
  delete Array.prototype.at
  const installed = evalBundle()
  assert.ok(installed.includes('Array.prototype.at'))
  const arr = ['a', 'b', 'c']
  assert.equal(arr.at(0), 'a')
  assert.equal(arr.at(2), 'c')
  assert.equal(arr.at(-1), 'c', '负索引')
  assert.equal(arr.at(-3), 'a')
  assert.equal(arr.at(3), undefined, '越界返回 undefined')
  assert.equal(arr.at(-4), undefined)
  assert.equal([].at(0), undefined, '空数组')
  assert.equal(arr.at(1.9), 'b', '小数需截断')
})

// ───────────── String.prototype.replaceAll ─────────────
test('String.prototype.replaceAll：字符串替换全部', () => {
  delete String.prototype.replaceAll
  const installed = evalBundle()
  assert.ok(installed.includes('String.prototype.replaceAll'))
  assert.equal('a-b-c'.replaceAll('-', '+'), 'a+b+c')
  assert.equal('aaa'.replaceAll('a', 'b'), 'bbb')
  assert.equal('abc'.replaceAll('x', 'y'), 'abc', '无匹配时原样返回')
})

test('String.prototype.replaceAll：正则需带 g，不带 g 应抛 TypeError', () => {
  delete String.prototype.replaceAll
  evalBundle()
  assert.equal('a1b2'.replaceAll(/[0-9]/g, '#'), 'a#b#')
  assert.throws(() => 'a1b2'.replaceAll(/[0-9]/, '#'), TypeError, '非全局正则应抛错')
})

test('String.prototype.replaceAll：函数式替换', () => {
  delete String.prototype.replaceAll
  evalBundle()
  assert.equal('a-b-c'.replaceAll('-', () => '_'), 'a_b_c')
})

// ───────────── 守卫与日志 ─────────────
test('守卫：已存在的 API 不覆盖，也不打日志', () => {
  // 全部 API 都在（Node 26 原生）→ 不应补任何东西
  const installed = evalBundle()
  assert.deepEqual(installed, [], '原生齐全时不应补任何 API，实际：' + JSON.stringify(installed))
})

test('日志：补了才打，格式为 [dsh-postapi-download] polyfill: <name>', () => {
  const logs = []
  const origInfo = console.info
  console.info = (...a) => logs.push(a.join(' '))
  try {
    delete AbortSignal.any
    evalBundle()
  } finally {
    console.info = origInfo
  }
  assert.ok(logs.some((l) => l.includes('[dsh-postapi-download] polyfill: AbortSignal.any')),
    '必须打出补了什么，实际日志：' + JSON.stringify(logs))
})
