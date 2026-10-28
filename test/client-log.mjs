// v1.4.0 前端自动采集（lib/client.js）单测。
//
// 被测代码 = lib/client.js 里的**真实实现**（经 test/client-bundle-loader.mjs 求值），
// 不是复制品。采集器的依赖（window/document/fetch/now）全部可注入，因此这里给出
// 一个可控的假页面，验证阈值与增量语义 —— 不需要真的等 2 秒或造长任务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { clientLogHelpers } from './client-bundle-loader.mjs'

const {
  createClientLogCollector,
  CL_MAX_QUEUE, CL_MAX_BATCH, CL_FLUSH_INTERVAL_MS, CL_LONGTASK_MIN_MS, CL_ENDPOINT,
  CL_LONGTASK_MAX_QUEUE, CL_FPS_SAMPLE_INTERVAL_MS, CL_FPS_BAD_MS, CL_FPS_REPORT_MIN_GAP_MS,
  CL_CLS_EMIT_THRESHOLD, CL_CLS_EMIT_INTERVAL_MS, resolveClientLogEnabled,
} = clientLogHelpers

/** 记录所有上报请求的假 fetch（返回 ok）。 */
function makeFetch (ok = true) {
  const calls = []
  const fn = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({ ok, status: ok ? 200 : 500 })
  }
  fn.calls = calls
  return fn
}

/** 一个"什么都支持"的假页面。 */
function makeEnv (over = {}) {
  const listeners = {}
  const canvas = {
    getContext: (kind) => (kind === 'webgl' || kind === 'experimental-webgl'
      ? { getExtension: () => ({ loseContext: () => {} }) }
      : null),
  }
  const doc = {
    visibilityState: 'visible',
    hidden: false,
    createElement: () => canvas,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn) },
  }
  const win = {
    screen: { width: 390, height: 844 },
    devicePixelRatio: 3,
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      deviceMemory: 4,
      hardwareConcurrency: 8,
    },
    CompressionStream: function CompressionStream () {},
    ...over.win,
  }
  return { win, doc, listeners }
}

console.log('== ① 配置常量 ==')
test('阈值常量与需求一一对应', () => {
  assert.ok(CL_LONGTASK_MIN_MS === 100, '长任务阈值 100ms')
  // v1.6.0：帧率从「1 秒数 N 帧 + 常驻 rAF」改为「5 秒采一帧 + 量帧间隔」
  assert.equal(CL_FPS_SAMPLE_INTERVAL_MS, 5000, '帧率采样间隔 5 秒（不常驻 rAF）')
  assert.equal(CL_FPS_BAD_MS, 150, '单帧间隔 > 150ms（≈<7fps）才算掉帧')
  assert.equal(CL_FPS_REPORT_MIN_GAP_MS, 10000, '两条 fps 记录至少间隔 10 秒')
  // v1.6.0：longtask 限长 100
  assert.equal(CL_LONGTASK_MAX_QUEUE, 100, 'longtask 队列上限 100 条')
  // v1.6.0：CLS 聚合
  assert.equal(CL_CLS_EMIT_THRESHOLD, 0.1, 'CLS 累计阈值 0.1')
  assert.equal(CL_CLS_EMIT_INTERVAL_MS, 10000, 'CLS 汇总窗口 10 秒')
  assert.ok(CL_FLUSH_INTERVAL_MS === 60000, 'flush 间隔 60 秒')
  assert.ok(CL_MAX_BATCH === 200, '单批上限与服务端 entries 上限一致')
  assert.ok(CL_MAX_QUEUE >= CL_MAX_BATCH, '队列容量不小于单批')
  assert.equal(CL_ENDPOINT, '/api/dsh/v1/client-log')
})

console.log('== ② 环境快照字段完整 ==')
test('envSnapshot：ua/screen/dpr/deviceMemory/hardwareConcurrency/supports 齐全', () => {
  const { win, doc } = makeEnv()
  const c = createClientLogCollector({ window: win, document: doc, now: () => 1 })
  const env = c.envSnapshot()
  assert.deepEqual(env.screen, [390, 844])
  assert.equal(env.dpr, 3)
  assert.equal(env.deviceMemory, 4)
  assert.equal(env.hardwareConcurrency, 8)
  assert.equal(env.supports.webgl, true, 'WebGL 探针命中')
  assert.equal(env.supports.compression, true, 'CompressionStream 存在')
})

test('envSnapshot：老 WebView（缺 deviceMemory / 无 canvas）不抛错、字段为 null/false', () => {
  const win = { navigator: { userAgent: 'old' } }
  const doc = {}
  const c = createClientLogCollector({ window: win, document: doc, now: () => 1 })
  let env
  assert.doesNotThrow(() => { env = c.envSnapshot() })
  assert.deepEqual(env.screen, [])
  assert.equal(env.dpr, null)
  assert.equal(env.deviceMemory, null)
  assert.equal(env.hardwareConcurrency, null)
  assert.equal(env.supports.webgl, false)
  assert.equal(env.supports.compression, false)
})

test('snapshot 上报体包含 ua（关键：能看出 WebView 内核版本）', async () => {
  const { win, doc } = makeEnv()
  const fetchFn = makeFetch(true)
  const c = createClientLogCollector({ window: win, document: doc, fetch: fetchFn, now: () => 1700000000000 })
  await c.report('snapshot', [{ t: 1, level: 'info', kind: 'snapshot', msg: 'page load snapshot' }], true)
  assert.equal(fetchFn.calls.length, 1)
  const body = JSON.parse(fetchFn.calls[0].init.body)
  assert.equal(fetchFn.calls[0].url, CL_ENDPOINT)
  assert.equal(body.source, 'web')
  assert.equal(body.kind, 'snapshot')
  assert.ok(body.ua.includes('Android'), body.ua)
  assert.deepEqual(body.env.screen, [390, 844])
  assert.equal(body.entries.length, 1)
  assert.equal(body.entries[0].msg, 'page load snapshot')
})

console.log('== ③ 长任务：只记 > 100ms ==')
test('collector.push 不设阈值（阈值由安装器判定）；这里验证字段形态', () => {
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, now: () => 5 })
  const rec = c.push({ level: 'warn', kind: 'longtask', duration: 320, msg: 'longtask 320ms' })
  assert.equal(rec.duration, 320)
  assert.equal(rec.kind, 'longtask')
  assert.equal(rec.t, 5)
})

test('【安装器】长任务 < 100ms 不记录，> 100ms 记录（真实 install 路径）', async () => {
  const mod = await import('./_installer-harness.mjs')
  const r = mod.runLongTask({ threshold: CL_LONGTASK_MIN_MS })
  assert.deepEqual(r.kinds, ['longtask'], '只有一条 longtask 入队：' + JSON.stringify(r.entries))
  assert.equal(r.entries[0].duration, 320)
  assert.ok(r.entries[0].msg.includes('320ms'))
})

console.log('== ④ 帧率：低频采样（无常驻 rAF）+ CLS 聚合 ==')
test('【安装器】不跑定时器时，绝不会自己再排 rAF（防常驻循环回归）', async () => {
  const mod = await import('./_installer-harness.mjs')
  const r = mod.runNoRunawayRaf()
  assert.equal(r.atInstall, 1, '安装时只排 1 帧用于建立基线')
  assert.equal(r.afterDrain, 1, '🔴 跑掉那一帧后不得再自排（旧实现会无限递归），实际 ' + r.afterDrain)
  assert.equal(r.afterVisibility, 1, '可见性切换不得触发新采样')
})

test('【安装器】帧间隔 > 150ms 才记一条，且两条记录至少间隔 10s', async () => {
  const mod = await import('./_installer-harness.mjs')
  // 正常 16ms 帧间隔 → 一条都不记
  const ok = mod.runFrameGap({ gaps: [16, 16, 16, 16] })
  assert.equal(ok.entries.filter((x) => x.kind === 'fps').length, 0, JSON.stringify(ok.entries))
  // 连续两个大间隔 → 只记 1 条（第二条被 10s 最小间隔挡掉）
  const bad = mod.runFrameGap({ gaps: [1500, 1500, 16] })
  const fps = bad.entries.filter((x) => x.kind === 'fps')
  assert.equal(fps.length, 1, JSON.stringify(bad.entries))
  assert.equal(fps[0].duration, 1500, 'duration = 帧间隔毫秒')
  assert.ok(fps[0].msg.includes('1500ms'), fps[0].msg)
  assert.ok(/~1fps/.test(fps[0].msg), 'msg 应给出折算帧率：' + fps[0].msg)
})

test('【安装器】页面不可见时跳过采样', async () => {
  const mod = await import('./_installer-harness.mjs')
  const r = mod.runFrameGapHidden()
  assert.equal(r.scheduledWhileHidden, 0, '隐藏期间不得排 rAF，实际 ' + r.scheduledWhileHidden)
})

test('【安装器】CLS 聚合：多条 shift 收成一条汇总', async () => {
  const mod = await import('./_installer-harness.mjs')
  // 4 条 0.03 = 0.12 ≥ 0.1 → 恰好一条汇总，而不是 4 条
  const r = mod.runClsAggregate({ shifts: [0.03, 0.03, 0.03, 0.03] })
  assert.equal(r.clsEntries.length, 1, '应聚合成 1 条，实际 ' + r.clsEntries.length + '：' + JSON.stringify(r.clsEntries))
  assert.equal(r.clsEntries[0].duration, 0.12)
  assert.ok(/4 shifts/.test(r.clsEntries[0].msg), r.clsEntries[0].msg)
  assert.equal(r.clsEntries[0].level, 'warn', '达阈值应为 warn')
  // 未达阈值：不写（由 10s 窗口兜底，单测里不推进定时器）
  const small = mod.runClsAggregate({ shifts: [0.01, 0.01] })
  assert.equal(small.clsEntries.length, 0, '未达阈值不写：' + JSON.stringify(small.clsEntries))
})

console.log('== ④b longtask 队列限长 100（超出丢最旧）==')
test('longtask 超过 100 条时丢最旧的，其它 kind 不受牵连', () => {
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: makeFetch(true), now: () => 1 })
  c.push({ level: 'info', kind: 'fid', duration: 1, msg: 'keep-me' })
  for (let i = 0; i < 130; i++) c.push({ level: 'warn', kind: 'longtask', duration: 200 + i, msg: 'lt-' + i })
  const lts = c.queue.filter((x) => x.kind === 'longtask')
  assert.equal(lts.length, 100, 'longtask 恰好留 100 条，实际 ' + lts.length)
  assert.equal(lts[0].msg, 'lt-30', '丢的是最旧的 30 条')
  assert.equal(lts[lts.length - 1].msg, 'lt-129', '最新的在')
  assert.ok(c.queue.some((x) => x.kind === 'fid'), 'fid 不应被 longtask 挤掉')
})

console.log('== ④c 默认关闭：开关优先级 ==')
test('resolveClientLogEnabled：URL > localStorage > 默认关闭', () => {
  const store = (v) => ({ getItem: () => v })
  // 默认（无 URL、无存储）→ 关闭
  assert.deepEqual(resolveClientLogEnabled({ search: '', storage: store(null) }), { enabled: false, source: 'default' })
  // localStorage on → 开
  assert.deepEqual(resolveClientLogEnabled({ search: '', storage: store('on') }), { enabled: true, source: 'storage' })
  assert.deepEqual(resolveClientLogEnabled({ search: '', storage: store('off') }), { enabled: false, source: 'storage' })
  // URL 覆盖 localStorage（双向）
  assert.deepEqual(resolveClientLogEnabled({ search: '?clientlog=on', storage: store('off') }), { enabled: true, source: 'url' })
  assert.deepEqual(resolveClientLogEnabled({ search: '?a=1&clientlog=off', storage: store('on') }), { enabled: false, source: 'url' })
  // 无法读取存储（隐私模式抛错）→ 按默认关闭
  assert.deepEqual(resolveClientLogEnabled({ search: '', storage: { getItem: () => { throw new Error('blocked') } } }), { enabled: false, source: 'default' })
})
console.log('== ⑤ 增量上报不重复 ==')
test('flush 只发 lastSentSeq 之后的新条目', async () => {
  const fetchFn = makeFetch(true)
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: fetchFn, now: () => 1 })
  c.push({ level: 'info', kind: 'longtask', duration: 200, msg: 'a' })
  c.push({ level: 'info', kind: 'longtask', duration: 210, msg: 'b' })
  await c.flush()
  assert.equal(fetchFn.calls.length, 1)
  assert.equal(JSON.parse(fetchFn.calls[0].init.body).entries.length, 2)
  // 没有新条目 → 不发请求
  await c.flush()
  assert.equal(fetchFn.calls.length, 1, '空增量不得发请求')
  // 新增一条 → 只发那一条
  c.push({ level: 'info', kind: 'longtask', duration: 220, msg: 'c' })
  await c.flush()
  assert.equal(fetchFn.calls.length, 2)
  const second = JSON.parse(fetchFn.calls[1].init.body)
  assert.equal(second.entries.length, 1)
  assert.equal(second.entries[0].msg, 'c', '只发增量，不重发 a/b')
})

test('上报失败时不推进 lastSentSeq（下次重发同一批，不丢数据）', async () => {
  const badFetch = makeFetch(false)
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: badFetch, now: () => 1 })
  c.push({ level: 'error', kind: 'error', msg: 'boom' })
  const r = await c.flush()
  assert.equal(r.ok, false)
  // 换一个会成功的 fetch，再 flush：同一批应被重发
  const goodFetch = makeFetch(true)
  const c2 = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: goodFetch, now: () => 1 })
  c2.push({ level: 'error', kind: 'error', msg: 'boom' })
  await c2.flush()
  assert.equal(goodFetch.calls.length, 1)
  assert.equal(JSON.parse(goodFetch.calls[0].init.body).entries[0].msg, 'boom')
})

test('队列超上限时丢弃最旧的（内存不会无限增长）', () => {
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, now: () => 1 })
  for (let i = 0; i < CL_MAX_QUEUE + 50; i++) c.push({ level: 'info', kind: 'noise', msg: 'm' + i })
  assert.equal(c.queue.length, CL_MAX_QUEUE)
  assert.equal(c.queue[0].msg, 'm50', '最旧的 50 条被丢弃')
})

console.log('== ⑥ 失败静默不抛 ==')
test('fetch 抛同步异常 → report 不抛，返回 ok:false', async () => {
  const throwing = () => { throw new Error('network down') }
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: throwing, now: () => 1 })
  let r
  await assert.doesNotReject(async () => { r = await c.report('flush', [{ t: 1, level: 'info', kind: 'x', msg: 'm' }], true) })
  assert.equal(r.ok, false)
})

test('fetch 返回 rejected promise → 静默', async () => {
  const rejecting = () => Promise.reject(new Error('offline'))
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: rejecting, now: () => 1 })
  const r = await c.report('flush', [{ t: 1, level: 'info', kind: 'x', msg: 'm' }], true)
  assert.equal(r.ok, false)
})

test('无 fetch 可用 → 不抛，返回 no-fetch', async () => {
  const c = createClientLogCollector({ window: { }, document: {}, now: () => 1 })
  const r = await c.report('flush', [{ t: 1, level: 'info', kind: 'x', msg: 'm' }], true)
  assert.equal(r.skipped, 'no-fetch')
})

test('entries 为空 → 不发请求', async () => {
  const fetchFn = makeFetch(true)
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: fetchFn, now: () => 1 })
  const r = await c.flush()
  assert.equal(r.skipped, 'empty')
  assert.equal(fetchFn.calls.length, 0)
})

console.log('== ⑦ 错误采集 ==')
test('【安装器】window.onerror / unhandledrejection 立刻上报（不等 60 秒）', async () => {
  const mod = await import('./_installer-harness.mjs')
  const r = mod.runErrors()
  const kinds = r.entries.map((x) => x.kind)
  assert.ok(kinds.includes('error'), JSON.stringify(kinds))
  assert.ok(r.reports.length >= 2, '每次错误都应触发一次即时上报，实际 ' + r.reports.length)
})

test('【安装器】console.error 包装：保留原行为（原函数被调用、返回值透传）', async () => {
  const mod = await import('./_installer-harness.mjs')
  const r = mod.runConsoleError()
  assert.equal(r.originalCalls, 1, '原 console.error 必须被调用一次')
  assert.deepEqual(r.originalArgs, ['boom', { a: 1 }], '参数必须原样透传')
  assert.equal(r.returnValue, 'ORIG-RETURN', '返回值必须原样返回')
  assert.equal(r.entryCount, 1, '同时要额外记录一条')
  assert.equal(r.wrappedFlag, true, '包装标记 __postapiWrapped 应存在')
})

test('【安装器】console.error 内记录失败也不会吞掉原始输出', async () => {
  const mod = await import('./_installer-harness.mjs')
  const r = mod.runConsoleErrorWithBrokenCollector()
  assert.equal(r.originalCalls, 1, '采集器报错时原 console.error 仍必须被调用')
})

console.log('== ⑧ 序列化与生命周期 ==')
test('上报体里的 entry 只有协议字段（不带 seq/内部状态）', async () => {
  const fetchFn = makeFetch(true)
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, fetch: fetchFn, now: () => 1 })
  c.push({ level: 'warn', kind: 'longtask', duration: 150, msg: 'm', extra: { a: 1 } })
  await c.flush()
  const e = JSON.parse(fetchFn.calls[0].init.body).entries[0]
  assert.deepEqual(Object.keys(e).sort(), ['duration', 'extra', 'kind', 'level', 'msg', 't'])
})

test('stop() 之后不再入队', () => {
  const c = createClientLogCollector({ window: makeEnv().win, document: {}, now: () => 1 })
  c.push({ level: 'info', kind: 'a', msg: 'x' })
  c.stop()
  assert.equal(c.push({ level: 'info', kind: 'b', msg: 'y' }), null)
  assert.equal(c.queue.length, 1)
})
