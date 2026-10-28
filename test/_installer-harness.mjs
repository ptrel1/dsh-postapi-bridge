
// v1.4.0 安装器（installClientLogAutoReport）的测试夹具。
//
// 为什么单独成文件：安装器读的是**全局** window/document（这是它在浏览器里的真实写法，
// 不该为了测试改成参数注入 —— 那会让线上代码多一层间接）。
//
// ⚠️ Node 下的关键坑（实测多轮才定位，写在这里免得后人重踩）：
//   ① `new Function(src)` 求值出的函数，闭包**绑定到全局作用域**；而 `globalThis.window = x`
//      只写属性、**不产生全局变量绑定** → bundle 内部 `typeof window` 恒为 "undefined"
//      （Chromium 不会：浏览器 window 既是全局对象属性又有 var 语义）；
//      表现为安装器第一行就 `return function () {}` 早退，**看起来像什么都没装**；
//   ② 只把**安装器**重新求值也没用：它引用的模块级常量（CL_LONGTASK_MIN_MS 等）属于原闭包
//      → ReferenceError → 被安装器自己的 try/catch 吞掉 → "装上了但什么都不采"，更难发现。
//
// 因此本夹具统一用「源码字符串 + indirect eval（(0, eval)）」—— 这才是真正的全局作用域，
// 且模块级常量与安装器在同一作用域内。测的仍是线上那一份代码（只额外注入一行导出）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(here, '..', 'lib', 'client.js')

const REACT_STUB = '(function () { return { useEffect: function(){}, useState: function(i){ return [i, function(){}] }, useCallback: function(f){ return f }, useMemo: function(f){ return f() }, useRef: function(i){ return { current: i } }, createElement: function(){ return {} } } })()'

/**
 * 在**全局作用域**求值整份 client.js，返回 module.exports（含 __clientLogHelpers 与安装器）。
 * @param {object} win
 * @param {object} doc
 */
export function evalBundle (win, doc) {
  const g = globalThis
  g.window = win
  g.document = doc
  let source = readFileSync(CLIENT_FILE, 'utf8')
  const marker = '\t\treturn module.exports;'
  if (!source.includes(marker)) throw new Error('client.js 结构变化：未找到 return module.exports')
  source = source.replace(marker,
    '\t\texports.__installClientLogAutoReport = installClientLogAutoReport;\n' + marker)
  g.__postapiTestSource = source
  try {
    return (0, eval)(
      '(function () {'
      + '  var captured = null;'
      + '  var inner = new Function("window", "document", "location", globalThis.__postapiTestSource);'
      + '  inner({ __ModuleLoader__: { load: function (def) { captured = def } } }, undefined, undefined);'
      + '  return captured.factory(function (id) {'
      + '    if (id === "react") return ' + REACT_STUB + ';'
      + '    throw new Error("unexpected require: " + id);'
      + '  });'
      + '})()'
    )
  } finally {
    try { delete g.__postapiTestSource } catch (e) {}
  }
}

/**
 * 装好采集器 + 安装器，返回带记录器的句柄。
 * @param {object} api { PerformanceObserver?, requestAnimationFrame?, consoleError? }
 */
export function setup (api = {}) {
  const entries = []
  const reports = []
  const listeners = {}
  const doc = {
    visibilityState: 'visible',
    hidden: false,
    createElement: () => ({ getContext: api.webgl ? () => ({ getExtension: () => null }) : () => null }),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn) },
  }
  const win = {
    screen: { width: 1, height: 1 },
    navigator: { userAgent: 'harness' },
    console: { error: api.consoleError || (() => 'ORIG-RETURN') },
    PerformanceObserver: api.PerformanceObserver,
    requestAnimationFrame: api.requestAnimationFrame,
    // v1.6.0：CLS 聚合与帧率采样都依赖定时器。默认给"不触发"的桩，
    // 需要推进定时器的用例传 api.setInterval 自行接管（见 runCls / runFrameGap）。
    setInterval: api.setInterval || (() => 1),
    clearInterval: api.clearInterval || (() => {}),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn) },
  }

  const savedWin = globalThis.window
  const savedDoc = globalThis.document
  const ex = evalBundle(win, doc)

  const collector = ex.__clientLogHelpers.createClientLogCollector({
    window: win, document: doc, fetch: () => Promise.resolve({ ok: true }),
  })
  // 用包装记录调用痕迹（不改真实实现）
  const realPush = collector.push
  const realReport = collector.report
  collector.push = (entry) => { const r = realPush(entry); if (r) entries.push(r); return r }
  collector.report = (kind, batch, mark) => {
    reports.push({ kind, size: Array.isArray(batch) ? batch.length : 0 })
    return realReport(kind, batch, mark)
  }

  // 安装器读的是**全局** window/document，但它的模块常量（CL_LONGTASK_MIN_MS 等）在
  // bundle 闭包里。两者必须同时可见 —— 只用 (0, eval) 重求值字符串做不到（实测在不同
  // 执行上下文里结果不稳定，且易被安装器自身的 try/catch 吞成「装上了但什么都不采」）。
  // ✅ 做法：直接用 bundle 闭包里的安装器函数，**调用点暴露 window/document**——
  //   当前上下文对同级 `window`/`document` 的解析来源不一致，故两个名字都显式提供：
  //   局部形参（=测试桩）+ 全局属性（bundle 闭包回退到全局作用域时读到），两侧同值。
  //   没有改线上实现，测的仍是 client.js 里那一份安装器。
  let uninstall
  try {
    const installerFn = ex.__installClientLogAutoReport
    // 阈值显式注入（数值与 lib/client.js 的模块常量一致）。
    // 为什么必须注入：安装器被 eval 到全局作用域后，引用的模块级常量属于 bundle 闭包，
    // 在全局作用域里读不到 → ReferenceError → 被安装器自己的 try/catch 吞掉。
    // v1.6.0：帧率改低频采样（fpsSampleIntervalMs / fpsBadMs / fpsReportMinGapMs），
    // CLS 改聚合（clsEmitThreshold / clsEmitIntervalMs）。数值与 lib/client.js 一致。
    const thresholds = {
      longTaskMinMs: 100,
      fpsSampleIntervalMs: 5000,
      fpsBadMs: 150,
      fpsReportMinGapMs: 10000,
      clsEmitThreshold: 0.1,
      clsEmitIntervalMs: 10000,
      flushIntervalMs: 60000,
      ...(api.thresholds || {}),
    }
    // 见上：把测试环境用 `const` 暴露成局部名（形参），同时确保全局属性同名同值。
    // 安装器先求 `typeof document === 'undefined' ? undefined : document`：bundle 闭包里
    // document 形参是 undefined，于是回退到**全局作用域**查 document。Node 的 ESM 模块作用域
    // 没有全局 window/document 绑定，只有 globalThis 上的属性 —— 若此时全局 document 指向
    // 上一轮残留或本就为 undefined，安装器会直接早退（`if (!win || !doc) return`）。
    // 因此安装期间把两个全局属性都指向本次测试桩，结束后 restore() 负责还原。
    globalThis.window = win
    globalThis.document = doc
    uninstall = installerFn(collector, thresholds) || (() => {})
  } finally {
    try { delete globalThis.__postapiTestInstallerSrc } catch (e) {}
  }
  const fire = (type, ev) => { for (const fn of (listeners[type] || []).slice()) fn(ev) }
  const restore = () => {
    try { uninstall() } catch (e) {}
    globalThis.window = savedWin
    globalThis.document = savedDoc
  }
  return { collector, uninstall: restore, entries, reports, win, doc, listeners, fire, exports: ex }
}

// ============================ 场景 ============================

/** ③ 长任务：喂 99ms 与 320ms 两条，只应留下后者。 */
export function runLongTask () {
  // 安装器会注册 3 个 observer（longtask / first-input / layout-shift），顺序固定，
  // 第一个就是 longtask 的 handler。
  const handlers = []
  const PerformanceObserver = function (cb) {
    handlers.push(cb)
    this.observe = () => {}
    this.disconnect = () => {}
  }
  const s = setup({ PerformanceObserver })
  const handler = handlers[0]
  if (handler) {
    handler({ getEntries: () => [
      { duration: 99, name: 'short' },
      { duration: 320, name: 'long' },
    ] })
  }
  s.uninstall()
  return { entries: s.entries, kinds: s.entries.map((e) => e.kind) }
}

/**
 * ④ 帧率（v1.6.0 低频采样）：安装器**只在定时器 tick 时**排一帧 rAF，
 *    用「相邻两次采样的帧时间戳差值」判断掉帧。
 *
 * 关键结构断言：
 *   · 不 tick 时 rAF 调用数**恒为 0**（证明没有常驻循环）；
 *   · 每次 tick 至多排 1 帧（fpsPending 去重）。
 *
 * @param {object} o { gaps: number[], threshold?: number }  gaps = 相邻采样帧的时间差(ms)
 */
export function runFrameGap ({ gaps = [], threshold } = {}) {
  const timers = []
  const rafQueue = []
  let rafCalls = 0
  let fakeNow = 0
  const requestAnimationFrame = (cb) => { rafCalls += 1; rafQueue.push(cb); return rafCalls }
  const setInterval = (fn) => { timers.push(fn); return timers.length }
  // 采样间隔压到 10ms 以便在单测里推进；阈值口径不变（>150ms 才记）
  const opts = { requestAnimationFrame, setInterval, thresholds: Object.assign({ fpsSampleIntervalMs: 10 }, threshold || {}) }
  const s = setup(opts)
  // 安装时排了第一帧（sampleOnce 立即调用）；先把它跑掉，避免干扰计数
  const before = rafCalls
  const fireTimers = () => { for (const fn of timers.slice()) fn() }
  const stepFrame = (ts) => { const cb = rafQueue.shift(); if (cb) cb(ts); return !!cb }
  // 首帧（安装时排的）→ 建立基线 fpsLastFrameTs
  stepFrame(fakeNow)
  // 之后每次：tick → 排 1 帧 → 跑该帧
  for (const gap of gaps) {
    fakeNow += gap
    fireTimers()
    stepFrame(fakeNow)
  }
  const r = {
    entries: s.entries,
    rafCallsAtInstall: before,
    rafCallsTotal: rafCalls,
    pendingAfterRun: rafQueue.length,
  }
  s.uninstall()
  s.uninstall()
  return r
}

/**
 * ④b 不常驻：装好之后**一帧都不跑**（不 tick 定时器），rAF 调用数必须停在安装时的那 1 次。
 *     旧实现会在这里无限自调用，本用例专防它回归。
 */
export function runNoRunawayRaf () {
  const rafQueue = []
  let rafCalls = 0
  const requestAnimationFrame = (cb) => { rafCalls += 1; rafQueue.push(cb); return rafCalls }
  const s = setup({ requestAnimationFrame, setInterval: () => 1, thresholds: { fpsSampleIntervalMs: 10 } })
  const atInstall = rafCalls
  // 依次跑掉安装时排的那一帧（真实页面里浏览器会回调它）
  while (rafQueue.length) { const cb = rafQueue.shift(); cb(0) }
  const afterDrain = rafCalls
  // 页面可见与否都不应再自动排帧：只有下次定时器 tick 才会
  s.doc.visibilityState = 'visible'
  s.fire('visibilitychange')
  s.doc.visibilityState = 'hidden'
  s.fire('visibilitychange')
  const r = { atInstall, afterDrain, afterVisibility: rafCalls, entries: s.entries }
  s.uninstall()
  return r
}

/**
 * ④c 页面不可见时采样直接跳过（后台页 rAF 被节流，量出来是假值）。
 */
export function runFrameGapHidden () {
  const timers = []
  let rafCalls = 0
  const rafQueue = []
  const requestAnimationFrame = (cb) => { rafCalls += 1; rafQueue.push(cb); return rafCalls }
  const s = setup({ requestAnimationFrame, setInterval: (fn) => { timers.push(fn); return 1 }, thresholds: { fpsSampleIntervalMs: 10 } })
  while (rafQueue.length) { const cb = rafQueue.shift(); cb(0) }
  s.doc.visibilityState = 'hidden'
  const before = rafCalls
  for (const fn of timers.slice()) fn()
  const r = { scheduledWhileHidden: rafCalls - before, entries: s.entries }
  s.uninstall()
  return r
}

/**
 * ④d CLS 聚合（v1.6.0）：喂 N 条 layout-shift，只有累计达阈值才写**一条汇总**。
 *     observers 顺序固定：longtask / first-input / layout-shift。
 */
export function runClsAggregate ({ shifts, threshold = 0.1 } = {}) {
  const handlers = []
  const PerformanceObserver = function (cb) { handlers.push(cb) }
  PerformanceObserver.prototype.observe = function () {}
  PerformanceObserver.prototype.disconnect = function () {}
  // clsEmitIntervalMs 压大：确保不会因为「窗口到期」而落一条，只测阈值聚合逻辑
  const s = setup({ PerformanceObserver, thresholds: { clsEmitThreshold: threshold, clsEmitIntervalMs: 10000 } })
  const clsHandler = handlers[2]
  if (!clsHandler) throw new Error('未注册 layout-shift observer')
  clsHandler({ getEntries: () => shifts.map((value, i) => ({ value, hadRecentInput: false, startTime: i })) })
  const r = { clsEntries: s.entries.filter((x) => x.kind === 'cls'), all: s.entries }
  s.uninstall()
  return r
}
/** ⑤ 错误：window.error 与 unhandledrejection 都应即时上报。 */
export function runErrors () {
  const s = setup({})
  s.fire('error', { message: 'boom', filename: 'a.js', lineno: 12 })
  s.fire('unhandledrejection', { reason: { message: 'rej-msg' } })
  const r = { entries: s.entries, reports: s.reports.filter((x) => x.kind === 'error') }
  s.uninstall()
  return r
}

/** ⑥ console.error 包装：原函数调用/参数/返回值必须完全保留。 */
export function runConsoleError () {
  const calls = []
  const orig = function () { calls.push(Array.from(arguments)); return 'ORIG-RETURN' }
  const s = setup({ consoleError: orig })
  const ret = s.win.console.error('boom', { a: 1 })
  const wrappedFlag = !!s.win.console.error.__postapiWrapped
  const r = {
    originalCalls: calls.length,
    originalArgs: calls[0] || [],
    returnValue: ret,
    wrappedFlag,
    entryCount: s.entries.length,
  }
  s.uninstall()
  r.restoredAfterUninstall = s.win.console.error === orig
  return r
}

/** ⑥b 采集器内部抛错时，原 console.error 仍必须被调用。 */
export function runConsoleErrorWithBrokenCollector () {
  const calls = []
  const orig = function () { calls.push(1); return 1 }
  const s = setup({ consoleError: orig })
  s.collector.push = () => { throw new Error('collector broken') }
  let threw = false
  try { s.win.console.error('boom') } catch (e) { threw = true }
  const r = { originalCalls: calls.length, threw }
  s.uninstall()
  return r
}
