/**
 * v1.7.0 单元测试：切换会话后自动收起左侧栏（仅窄屏）。
 *
 * 为什么必须测：这段代码只在「窄屏 + 会话真的换了 + 侧栏当前展开」时动 toggleSidebar，
 * 而 toggleSidebar 是**开关语义** —— 判错一次就是把用户刚收起的侧栏展开（比没有功能更糟）。
 * 所以每个边界都要有用例钉住：首次加载不动作、宽屏不动作、已收起不动作、DOM 属性缺失
 * 不动作（且不猜状态）、服务缺失静默跳过、逃生阀 ?autocollapse=off 生效。
 *
 * 测的是**线上那一份代码**（经 client-bundle-loader 求值 lib/client.js 的 factory），
 * 不是复制品。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClientBundle } from './client-bundle-loader.mjs'

const H = loadClientBundle().exports.__autoCollapseHelpers
const { evaluateAutoCollapse, setupAutoCollapseSidebar, resolveAutoCollapseEnabled, POSTAPI_AUTOCLOSE_BREAKPOINT } = H

// ---------------------------------------------------------------- 开关解析
test('v1.7.0 开关：默认开启；?autocollapse=off 关闭；on 开启；其它值回落默认', () => {
  assert.deepEqual(resolveAutoCollapseEnabled({ search: '' }), { enabled: true, source: 'default' })
  assert.deepEqual(resolveAutoCollapseEnabled({ search: '?autocollapse=off' }), { enabled: false, source: 'url' })
  assert.deepEqual(resolveAutoCollapseEnabled({ search: '?autocollapse=OFF' }), { enabled: false, source: 'url' })
  assert.deepEqual(resolveAutoCollapseEnabled({ search: '?a=1&autocollapse=on' }), { enabled: true, source: 'url' })
  // 未表态的值（拼错）不得被当成 off —— 否则「拼错了就悄悄少个功能」
  assert.deepEqual(resolveAutoCollapseEnabled({ search: '?autocollapse=disable' }), { enabled: true, source: 'default' })
  // 阈值与 DSH 的 SIDEBAR_AUTO_COLLAPSE 一致（columns.ts:23）
  assert.equal(POSTAPI_AUTOCLOSE_BREAKPOINT, 1024)
})

// ---------------------------------------------------------------- 纯决策
const base = { prevSessionId: 'A', sessionId: 'B', innerWidth: 390, collapsed: false, inConversation: true }

test('v1.7.0 决策：首次加载不收起（prevSessionId === null）', () => {
  let called = 0
  const r = evaluateAutoCollapse({ ...base, prevSessionId: null, toggle: () => { called += 1 } })
  assert.equal(r.action, 'skip'); assert.equal(r.reason, 'first-load'); assert.equal(called, 0)
})

test('v1.7.0 决策：会话没变不收起（面板切换/retain 抖动）', () => {
  let called = 0
  const r = evaluateAutoCollapse({ ...base, prevSessionId: 'A', sessionId: 'A', toggle: () => { called += 1 } })
  // v1.7.1：reason 由 'unchanged' 更名为 'same-session'（诊断浮层要它自解释）
  assert.equal(r.action, 'skip'); assert.equal(r.reason, 'same-session'); assert.equal(called, 0)
  // undefined/null 都视为「没有会话」，互相之间也算没变
  const r2 = evaluateAutoCollapse({ ...base, prevSessionId: undefined, sessionId: null })
  assert.equal(r2.reason, 'first-load')
})

test('v1.7.0 决策：切到「没有会话」不收（不是切到另一个会话）', () => {
  let called = 0
  const r = evaluateAutoCollapse({ ...base, prevSessionId: 'A', sessionId: undefined, toggle: () => { called += 1 } })
  assert.equal(r.reason, 'no-session'); assert.equal(called, 0)
})

test('v1.7.0 决策：宽屏（>=1024）不收起；1023 收起（与 SIDEBAR_AUTO_COLLAPSE 对齐）', () => {
  let called = 0
  assert.equal(evaluateAutoCollapse({ ...base, innerWidth: 1024, toggle: () => { called += 1 } }).reason, 'wide')
  assert.equal(evaluateAutoCollapse({ ...base, innerWidth: 1440, toggle: () => { called += 1 } }).reason, 'wide')
  assert.equal(called, 0)
  const r = evaluateAutoCollapse({ ...base, innerWidth: 1023, toggle: () => { called += 1 } })
  assert.equal(r.action, 'collapsed'); assert.equal(called, 1)
})

test('v1.7.0 决策：不在会话视图不收起', () => {
  let called = 0
  const r = evaluateAutoCollapse({ ...base, inConversation: false, toggle: () => { called += 1 } })
  assert.equal(r.reason, 'not-conversation'); assert.equal(called, 0)
})

test('v1.7.0 决策：已经是收起状态不动（toggle 是开关，再调会展开）', () => {
  let called = 0
  const r = evaluateAutoCollapse({ ...base, collapsed: true, toggle: () => { called += 1 } })
  assert.equal(r.reason, 'already-collapsed'); assert.equal(called, 0)
})

test('v1.7.0 决策：toggle 抛错不外抛，返回 skip', () => {
  const r = evaluateAutoCollapse({ ...base, toggle: () => { throw new Error('boom') } })
  assert.equal(r.action, 'skip'); assert.equal(r.reason, 'toggle-threw')
})

// ---------------------------------------------------------------- 安装器（可注入 DOM/服务）
/** 造一个最小 document：selectors 里的选择器命中即「存在」。 */
function makeDoc (present) {
  return { querySelector: (sel) => (present.includes(sel) ? {} : null) }
}
/** 造一个最小 ObservableSnapshot<{ key }>。 */
function makeSource (initialKey) {
  const listeners = new Set()
  const src = {
    value: { key: initialKey },
    getSnapshot () { return src.value },
    subscribe (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit (key) { src.value = { key }; for (const fn of [...listeners]) fn() },
    listenerCount: () => listeners.size,
  }
  return src
}
function makeCtx ({ layout, source }) {
  const services = { layout, uiSession: { adapter: { current: source } } }
  return { get: (name) => services[name] }
}

test('v1.7.0 安装器：首次安装不动作；之后会话变化才收起（窄屏 + 在会话视图 + 未收起）', () => {
  let toggles = 0
  const layout = { toggleSidebar: () => { toggles += 1 } }
  const source = makeSource('A')
  const win = { innerWidth: 390 }
  // 侧栏当前展开：没有 [data-sidebar-collapsed]；在会话视图
  const doc = makeDoc(['[data-panel-conversation]'])
  const h = setupAutoCollapseSidebar(makeCtx({ layout, source }), { win, doc, search: '' })
  assert.equal(h.active, true)
  assert.equal(h.__getLastSessionId(), 'A')
  assert.equal(toggles, 0)             // 首次安装不得动侧栏

  source.emit('B')
  assert.equal(toggles, 1)             // 切到 B → 收起一次

  // 收起之后 DOM 上出现 [data-sidebar-collapsed]：再切会话不得再 toggle（否则会展开）
  const doc2 = { querySelector: (sel) => ({ '[data-panel-conversation]': {}, '[data-sidebar-collapsed]': {} }[sel] ?? null) }
  const h2 = setupAutoCollapseSidebar(makeCtx({ layout, source: makeSource('B') }), { win, doc: doc2, search: '' })
  assert.equal(h2.active, true)
  assert.equal(toggles, 1)
  h.dispose()
})

test('v1.7.0 安装器：toggle 只在校验全通过时调用一次；解除订阅后不再响应', () => {
  let toggles = 0
  const layout = { toggleSidebar: () => { toggles += 1 } }
  const source = makeSource('A')
  const h = setupAutoCollapseSidebar(makeCtx({ layout, source }), {
    win: { innerWidth: 390 }, doc: makeDoc(['[data-panel-conversation]']), search: '',
  })
  assert.equal(source.listenerCount(), 1)
  source.emit('B')
  source.emit('B')            // 重复通知（同一会话）不得重复 toggle
  assert.equal(toggles, 1)
  h.dispose()
  assert.equal(source.listenerCount(), 0)
  source.emit('C')            // 已解绑 → 不再响应
  assert.equal(toggles, 1)
})

test('v1.7.0 安装器：DOM 上查不到 [data-sidebar-collapsed] 也不报错、不猜测状态', () => {
  // querySelector 对侧栏选择器返回 null 而普通实现会当作「未收起」——
  // 这里要验证的是：**不抛错、不动作**。用会 throw 的 document 模拟改版后异常。
  let toggles = 0
  const layout = { toggleSidebar: () => { toggles += 1 } }
  const source = makeSource('A')
  const doc = { querySelector: () => { throw new Error('nope') } }
  const h = setupAutoCollapseSidebar(makeCtx({ layout, source }), { win: { innerWidth: 390 }, doc, search: '' })
  assert.equal(h.active, true)
  assert.doesNotThrow(() => source.emit('B'))
  assert.equal(toggles, 0)
})

test('v1.7.0 安装器：服务缺失（layout / uiSession）静默跳过，不抛错', () => {
  const source = makeSource('A')
  const win = { innerWidth: 390 }
  const doc = makeDoc(['[data-panel-conversation]'])
  const r1 = setupAutoCollapseSidebar({ get: () => undefined }, { win, doc, search: '' })
  assert.equal(r1.active, false); assert.equal(r1.reason, 'no-layout')
  const r2 = setupAutoCollapseSidebar({ get: (n) => (n === 'layout' ? { toggleSidebar () {} } : undefined) }, { win, doc, search: '' })
  assert.equal(r2.active, false); assert.equal(r2.reason, 'no-uisession')
  // layout 存在但 toggleSidebar 不是函数（版本不匹配）
  const r3 = setupAutoCollapseSidebar({ get: (n) => (n === 'layout' ? { toggleSidebar: 'x' } : { adapter: { current: source } }) }, { win, doc, search: '' })
  assert.equal(r3.active, false); assert.equal(r3.reason, 'no-layout')
  // ctx.get 自己抛错（cordis 语义下探测失败）也不得冒泡
  const r4 = setupAutoCollapseSidebar({ get: () => { throw new Error('cannot get property') } }, { win, doc, search: '' })
  assert.equal(r4.active, false)
})

test('v1.7.0 安装器：?autocollapse=off 时不订阅任何东西', () => {
  let toggles = 0
  const source = makeSource('A')
  const h = setupAutoCollapseSidebar(
    makeCtx({ layout: { toggleSidebar: () => { toggles += 1 } }, source }),
    { win: { innerWidth: 390 }, doc: makeDoc(['[data-panel-conversation]']), search: '?autocollapse=off' },
  )
  assert.equal(h.active, false); assert.equal(h.reason, 'disabled')
  assert.equal(source.listenerCount(), 0)
  assert.equal(toggles, 0)
  assert.equal(H.__getState().enabled, false)
})

test('v1.7.0 安装器：宽屏下会话变化不收起', () => {
  let toggles = 0
  const source = makeSource('A')
  setupAutoCollapseSidebar(makeCtx({ layout: { toggleSidebar: () => { toggles += 1 } }, source }), {
    win: { innerWidth: 1440 }, doc: makeDoc(['[data-panel-conversation]']), search: '',
  })
  source.emit('B')
  assert.equal(toggles, 0)
})
