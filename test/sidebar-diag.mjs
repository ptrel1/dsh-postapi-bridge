/**
 * v1.7.1 测试：诊断浮层（?sidebardiag=1）+ evaluateAutoCollapse 的 reason 覆盖。
 *
 * 为什么必须测：
 *   ① 浮层**默认绝不能显示** —— 普通用户看到这堆黑话会以为出 bug 了。
 *   ② 浮层是纯诊断，但它在 apply() 里跑，若抛错会连累插件（所以必须自己兜住）。
 *   ③ reason 是现场唯一的判据来源，名字错了等于没有诊断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClientBundle } from './client-bundle-loader.mjs'

const H = loadClientBundle().exports.__autoCollapseHelpers
const { evaluateAutoCollapse, setupSidebarDiag, collectSidebarDiag, readDshViewportWidth } = H

// ---------------------------------------------------------------- reason 覆盖
test('v1.7.1 reason：每个分支都有独立、自解释的名字', () => {
  const base = { prevSessionId: 'A', sessionId: 'B', innerWidth: 390, collapsed: false, inConversation: true }
  const seen = new Set()
  const push = (r) => { seen.add(r.reason); return r }

  push(evaluateAutoCollapse({ ...base, prevSessionId: null }))
  push(evaluateAutoCollapse({ ...base, sessionId: 'A' }))
  push(evaluateAutoCollapse({ ...base, sessionId: undefined }))
  push(evaluateAutoCollapse({ ...base, innerWidth: 1024 }))
  push(evaluateAutoCollapse({ ...base, innerWidth: '390' }))   // 非数字同样归 wide（不猜）
  push(evaluateAutoCollapse({ ...base, collapsed: true }))
  push(evaluateAutoCollapse({ ...base, inConversation: false }))
  push(evaluateAutoCollapse({ ...base, toggle: () => {} }))
  push(evaluateAutoCollapse({ ...base, toggle: () => { throw new Error('x') } }))

  assert.deepEqual([...seen].sort(), [
    'already-collapsed', 'collapsed', 'first-load', 'no-session', 'not-conversation',
    'same-session', 'toggle-threw', 'wide',
  ])
  // 任务书点名的几条必须在（改名时测试先炸）
  for (const r of ['no-session', 'same-session', 'wide', 'already-collapsed', 'not-conversation', 'collapsed']) {
    assert.ok(seen.has(r), '缺少 reason: ' + r)
  }
})

test('v1.7.1 reason：collapsed 分支的 action 与 reason 同名（浮层一眼可读）', () => {
  const r = evaluateAutoCollapse({ prevSessionId: 'A', sessionId: 'B', innerWidth: 390, collapsed: false, inConversation: true, toggle: () => {} })
  assert.equal(r.action, 'collapsed')
  assert.equal(r.reason, 'collapsed')
})

// ---------------------------------------------------------------- 开关：默认不显示
function makeFakeDom () {
  const appended = []
  const doc = {
    body: { appendChild: (n) => { appended.push(n); n.parentNode = doc.body }, removeChild: () => {} },
    createElement: (tag) => ({
      tag, style: {}, children: [], firstChild: null, parentNode: null,
      attrs: {}, setAttribute (k, v) { this.attrs[k] = v }, appendChild (c) { this.children.push(c); this.firstChild = this.children[0] },
      removeChild (c) { this.children = this.children.filter((x) => x !== c); this.firstChild = this.children[0] || null },
      textContent: '',
    }),
    querySelector: () => null,
  }
  return { doc, appended }
}

test('v1.7.1 浮层：不带 ?sidebardiag=1 时**完全不安装**（普通用户看不到）', () => {
  for (const search of ['', '?x=1', '?sidebardiag=0', '?sidebardiag', '?asidebardiag=1']) {
    const { doc, appended } = makeFakeDom()
    let intervals = 0
    const win = { innerWidth: 440, setInterval: () => { intervals += 1; return 1 }, clearInterval: () => {} }
    const h = setupSidebarDiag({}, { win, doc, search })
    assert.equal(h.active, false, 'search=' + search)
    assert.equal(h.reason, 'not-requested')
    assert.equal(intervals, 0, '未请求时不得启动定时器: ' + search)
    assert.equal(appended.length, 0, '未请求时不得插 DOM: ' + search)
  }
})

test('v1.7.1 浮层：?sidebardiag=1 时安装，样式符合约定，且 pointer-events: none', () => {
  const { doc, appended } = makeFakeDom()
  let intervals = 0
  const win = {
    innerWidth: 440,
    setInterval: (fn, ms) => { intervals += 1; assert.equal(ms, 500); return 1 },
    clearInterval: () => {},
  }
  const h = setupSidebarDiag({}, { win, doc, search: '?sidebardiag=1' })
  assert.equal(h.active, true)
  assert.equal(intervals, 1, '必须有一个 500ms 定时器')
  assert.equal(appended.length, 1)

  const el = appended[0]
  assert.equal(el.style.position, 'fixed')
  assert.equal(el.style.top, '8px')
  assert.equal(el.style.right, '8px')
  assert.equal(el.style.zIndex, '99999')
  assert.equal(el.style.background, 'rgba(0,0,0,.82)')
  assert.equal(el.style.fontSize, '11px')
  assert.equal(el.style.fontFamily, 'monospace')
  assert.equal(el.style.pointerEvents, 'none', '浮层不得挡住用户操作')
  assert.equal(el.style.maxWidth, '46vw')
  assert.equal(el.style.wordBreak, 'break-all')
  assert.equal(el.tag, 'div')
  assert.deepEqual(el.attrs, { 'data-postapi-sidebar-diag': '1' })
  h.dispose()
})

// ---------------------------------------------------------------- 内容
test('v1.7.1 浮层内容：8 行齐全；读不到的值一律 unknown/null，绝不猜', () => {
  const { doc } = makeFakeDom()
  const rows = collectSidebarDiag({
    doc: { querySelector: () => null },
    win: { innerWidth: 440 },
    handle: null,
    lastDiag: { action: 'skip', reason: 'same-session' },
    state: { enabled: true, source: 'default' },
  })
  const labels = rows.map((r) => r[0].trim())
  assert.deepEqual(labels, [
    'innerWidth:', 'DSH viewportWidth:', '[data-sidebar-collapsed]:', '[data-panel-conversation]:',
    'autocollapse:', 'lastSessionId:', 'sessionId(now):', 'lastAction:',
  ])
  const map = Object.fromEntries(rows.map((r) => [r[0].trim(), r[1]]))
  assert.equal(map['innerWidth:'], '440')
  assert.equal(map['DSH viewportWidth:'], 'unknown', '读不到就 unknown')
  assert.equal(map['[data-sidebar-collapsed]:'], '不存在')
  assert.equal(map['[data-panel-conversation]:'], '不存在')
  assert.equal(map['autocollapse:'], 'none')
  assert.equal(map['lastSessionId:'], 'null')
  assert.equal(map['sessionId(now):'], 'null')
  assert.equal(map['lastAction:'], 'skip / same-session')
  void doc
})

test('v1.7.1 浮层内容：安装成功 + 侧栏已收起 + 在会话视图 → 逐行如实反映', () => {
  const rows = collectSidebarDiag({
    doc: { querySelector: (sel) => (sel === '[data-sidebar-collapsed]' || sel === '[data-panel-conversation]' ? {} : null) },
    win: { innerWidth: 440 },
    handle: { active: true, __getLastSessionId: () => 'S1', __getSessionIdNow: () => 'S2' },
    lastDiag: { action: 'collapsed', reason: 'collapsed' },
    state: { enabled: true, source: 'default' },
  })
  const map = Object.fromEntries(rows.map((r) => [r[0].trim(), r[1]]))
  assert.equal(map['[data-sidebar-collapsed]:'], '存在')
  assert.equal(map['[data-panel-conversation]:'], '存在')
  assert.equal(map['autocollapse:'], 'active')
  assert.equal(map['lastSessionId:'], 'S1')
  assert.equal(map['sessionId(now):'], 'S2')
  assert.equal(map['lastAction:'], 'collapsed / collapsed')
})

test('v1.7.1 浮层内容：安装失败要显示失败原因（不能只说 none）', () => {
  const rows = collectSidebarDiag({
    doc: { querySelector: () => null },
    win: { innerWidth: 440 },
    handle: null,
    lastDiag: { action: 'off', reason: 'no-uisession' },
    state: { enabled: true, source: 'default' },
  })
  const map = Object.fromEntries(rows.map((r) => [r[0].trim(), r[1]]))
  assert.equal(map['autocollapse:'], 'no-uisession')
  // ?autocollapse=off 也要看得出来
  const rows2 = collectSidebarDiag({
    doc: { querySelector: () => null }, win: { innerWidth: 440 }, handle: null,
    lastDiag: { action: 'none', reason: 'none' }, state: { enabled: false, source: 'url' },
  })
  assert.equal(Object.fromEntries(rows2.map((r) => [r[0].trim(), r[1]]))['autocollapse:'], 'disabled')
})

test('v1.7.1 浮层内容：querySelector 抛错不炸，显示「查询失败」', () => {
  const rows = collectSidebarDiag({
    doc: { querySelector: () => { throw new Error('boom') } },
    win: { innerWidth: 440 }, handle: null, lastDiag: { action: 'none', reason: 'none' },
  })
  const v = Object.fromEntries(rows.map((r) => [r[0].trim(), r[1]]))['[data-sidebar-collapsed]:']
  assert.match(v, /^查询失败/)
})

// ---------------------------------------------------------------- DSH viewportWidth
test('v1.7.1 viewportWidth：优先读 .frame 的 gridTemplateColumns 第一段', () => {
  const doc = { querySelector: (sel) => (sel === '.frame' ? { style: { gridTemplateColumns: '86px 0px 0px 354px' } } : null) }
  assert.equal(readDshViewportWidth(doc), '86')
})

test('v1.7.1 viewportWidth：无 inline 样式时退到 getBoundingClientRect；再读不到 unknown', () => {
  globalThis.window = { getComputedStyle: () => ({ gridTemplateColumns: '' }) }
  const frame = { style: { gridTemplateColumns: '' }, getBoundingClientRect: () => ({ width: 439.6 }) }
  const doc = { querySelector: () => frame }
  assert.equal(readDshViewportWidth(doc), '440')
  delete globalThis.window
  // 既无 grid 也无宽度 → unknown（不许猜 0 或 100%）
  const doc2 = { querySelector: () => ({ style: {}, getBoundingClientRect: () => ({ width: 0 }) }) }
  assert.equal(readDshViewportWidth(doc2), 'unknown')
  // 没有 .frame（改版/未挂载）→ unknown
  assert.equal(readDshViewportWidth({ querySelector: () => null }), 'unknown')
  assert.equal(readDshViewportWidth(null), 'unknown')
})

// ---------------------------------------------------------------- 与安装器的联动
test('v1.7.1 联动：setupAutoCollapseSidebar 把最近一次判定写进 lastDiag', () => {
  const listeners = new Set()
  const src = {
    value: { key: 'A' },
    getSnapshot () { return src.value },
    subscribe (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit (key) { src.value = { key }; for (const fn of [...listeners]) fn() },
  }
  let toggles = 0
  const ctx = { get: (n) => (n === 'layout' ? { toggleSidebar: () => { toggles += 1 } } : { adapter: { current: src } }) }
  const win = { innerWidth: 440 }
  const doc = { querySelector: (sel) => (sel === '[data-panel-conversation]' ? {} : null) }
  const h = H.setupAutoCollapseSidebar(ctx, { win, doc, search: '' })
  assert.equal(h.active, true)
  assert.equal(H.__getHandle(), h, '成功的控制器必须登记给浮层')
  assert.equal(typeof h.__getSessionIdNow, 'function')
  assert.equal(h.__getSessionIdNow(), 'A', '实时读会话 id 不得改动基线')

  src.emit('B')
  const d = H.__getLastDiag()
  assert.equal(d.action, 'collapsed')
  assert.equal(d.reason, 'collapsed')
  assert.equal(d.prevSessionId, 'A', '记录的是比较时的旧基线')
  assert.equal(d.sessionId, 'B')
  assert.equal(toggles, 1)
  assert.equal(h.__getLastSessionId(), 'B')
  h.dispose()
})

test('v1.7.1 联动：安装失败时 lastDiag 记录失败原因（浮层才有的看）', () => {
  H.setupAutoCollapseSidebar({ get: () => undefined }, { win: { innerWidth: 440 }, doc: { querySelector: () => null }, search: '' })
  assert.equal(H.__getLastDiag().reason, 'no-layout')
  H.setupAutoCollapseSidebar({ get: () => undefined }, { win: { innerWidth: 440 }, doc: { querySelector: () => null }, search: '?autocollapse=off' })
  assert.equal(H.__getLastDiag().reason, 'disabled')
})
