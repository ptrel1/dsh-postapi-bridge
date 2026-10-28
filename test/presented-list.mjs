// v0.12.0 交付物清单（presented list）纯函数单测：事件筛选 / 排序 / 展开 / 跳过
import test from 'node:test'
import assert from 'node:assert/strict'
import { __presentedHelpers } from '../lib/index.js'

const { pickPresentedEvents, flattenPresentedFiles } = __presentedHelpers

const mkEvent = (seq, files, turn = 1, time = 1000 + seq) => ({
  type: 'deliverables/presented', seq, time,
  data: { turn, callId: 'call-' + seq, files },
})

// ── 筛选 ──
test('pickPresentedEvents：只保留 deliverables/presented', () => {
  const records = [
    { type: 'user/message', seq: 1, data: {} },
    mkEvent(2, [{ path: 'a.txt' }]),
    { type: 'assistant/message', seq: 3, data: {} },
    mkEvent(4, [{ path: 'b.txt' }]),
    { type: 'turn/start', seq: 5, data: {} },
  ]
  const out = pickPresentedEvents(records)
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((e) => e.seq), [4, 2], '必须按 seq 倒序')
})

// ⚠️ v1.0.3 语义变更：pickPresentedEvents 改为只看 type + seq（不再检查 data.files）。
//   原因：listEvents 返回的是**轻量**记录，本来就没有 data —— 旧的 data 检查会把所有
//   真实事件全部过滤掉（线上 files 恒为 []）。data 的形状校验下沉到 readEvent 之后。
test('【v1.0.3 语义变更】pickPresentedEvents：脏数据被忽略（只看 type/seq，不看 data）', () => {
  const records = [
    null, undefined, 42, 'str', {},
    { type: 'deliverables/presented' },                            // 无 seq → 丢弃（无法 readEvent）
    { type: 'deliverables/presented', seq: 1 },                    // 无 data → **保留**（listEvents 本就没有）
    { type: 'deliverables/presented', seq: 2, data: {} },          // 同上，保留
    { type: 'deliverables/presented', seq: 3, data: { files: {} } }, // 同上，保留
    mkEvent(4, [{ path: 'ok.txt' }]),
  ]
  const out = pickPresentedEvents(records)
  assert.equal(out.length, 4, '有 seq 的一律保留（data 形状由 readEvent 之后校验）')
  assert.deepEqual(out.map((e) => e.seq), [4, 3, 2, 1], 'seq 倒序')
  // 返回的是轻量引用，不含 data
  assert.ok(!('data' in out[0]), '返回项不得带 data 字段')
  assert.deepEqual(pickPresentedEvents([]), [])
  assert.deepEqual(pickPresentedEvents(undefined), [])
})

test('【v1.0.3 语义变更】pickPresentedEvents：seq 缺失的记录直接丢弃（无法 readEvent）', () => {
  // 旧语义：保留无 seq 的记录（排序时按 0 处理）。
  // 新语义：没有 seq 就无法向 readEvent 取完整事件 → 一律丢弃，避免下游拿到不可用的引用。
  const records = [
    { type: 'deliverables/presented', data: { files: [{ path: 'x' }] } },  // 无 seq → 丢
    { type: 'deliverables/presented', seq: 'not-a-number' },               // seq 非整数 → 丢
    mkEvent(10, [{ path: 'y' }]),
  ]
  const out = pickPresentedEvents(records)
  assert.equal(out.length, 1, '只有合法 seq 的保留')
  assert.equal(out[0].seq, 10)
})

// ── 展开 ──
test('flattenPresentedFiles：每个文件一条，携带 seq/index/turn/time/description', () => {
  const events = [mkEvent(20, [
    { path: '/ws/a.txt', description: '甲' },
    { path: '/ws/b.txt' },
  ], 7, 1792636949516)]
  const out = flattenPresentedFiles(events)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], {
    seq: 20, index: 0, turn: 7, time: 1792636949516,
    path: '/ws/a.txt', description: '甲',
  })
  assert.equal(out[1].index, 1)
  assert.equal(out[1].description, '', '缺 description 归一为空串')
})

test('flattenPresentedFiles：保持事件 seq 倒序、事件内 index 升序', () => {
  const events = [
    mkEvent(30, [{ path: 'new1' }, { path: 'new2' }]),
    mkEvent(10, [{ path: 'old1' }]),
  ]
  const out = flattenPresentedFiles(events)
  assert.deepEqual(out.map((x) => [x.seq, x.index]), [[30, 0], [30, 1], [10, 0]])
})

test('flattenPresentedFiles：空/非字符串 path 被丢弃', () => {
  const events = [mkEvent(1, [
    { path: '' }, { path: '   ' }, { path: 123 }, {}, null, { path: 'good.txt' },
  ])]
  const out = flattenPresentedFiles(events)
  assert.equal(out.length, 1)
  assert.equal(out[0].path, 'good.txt')
})

test('flattenPresentedFiles：turn/time 非数字时归一为 null', () => {
  const ev = { type: 'deliverables/presented', seq: 5, data: { turn: 'x', files: [{ path: 'a' }] } }
  const out = flattenPresentedFiles([ev])
  assert.equal(out[0].turn, null)
  assert.equal(out[0].time, null)
})

test('flattenPresentedFiles：空输入安全', () => {
  assert.deepEqual(flattenPresentedFiles([]), [])
  assert.deepEqual(flattenPresentedFiles(undefined), [])
  assert.deepEqual(flattenPresentedFiles([{ type: 'x' }]), [])
})

// ── 组合：模拟 handlePresentedList 的筛选→展开链路 ──
// ⚠️ v1.0.3：pick 与 flatten 之间隔了一次 readEvent。
//   pickPresentedEvents 只从**轻量** listEvents 记录里挑 seq；
//   完整事件（含 data）由 readEvent 拿；flattenPresentedFiles 吃的是后者的结果。
//   本用例显式模拟这个两段式流程（mock readEvent = 按 seq 从全量里查）。
test('【v1.0.3 语义变更】组合：轻量记录 → readEvent → 候选条目（真实两段式流程）', () => {
  // ① 全量事件（readEvent 才会返回的东西）
  const fullEvents = [
    mkEvent(1781, [{ path: 'test-download.txt', description: '测试文件' }], 33, 1792636949516),
    mkEvent(2365, [{ path: 'a.docx' }, { path: 'b.xlsx' }], 41, 1792638000000),
  ]
  // ② listEvents 返回的**轻量**记录（无 data）—— 这才是真实 API 的形状
  const records = [
    { sessionId: 's', seq: 100, type: 'user/message', time: 100, surface: 'main' },
    { sessionId: 's', seq: 1781, type: 'deliverables/presented', time: 1792636949516, surface: 'main' },
    { sessionId: 's', seq: 2000, type: 'assistant/message', time: 2000, surface: 'main' },
    { sessionId: 's', seq: 2365, type: 'deliverables/presented', time: 1792638000000, surface: 'main' },
  ]
  // ③ 第一段：从轻量记录里挑 seq（只有 present 类型）
  const refs = pickPresentedEvents(records)
  assert.deepEqual(refs.map((r) => r.seq), [2365, 1781], '只挑 present，seq 倒序')
  // ④ 第二段：逐个 readEvent 取完整事件（此处 mock）
  const hydrated = refs.map((r) => fullEvents.find((e) => e.seq === r.seq))
  // ⑤ 展开成候选条目
  const cands = flattenPresentedFiles(hydrated)
  assert.equal(cands.length, 3)
  assert.deepEqual(cands.map((c) => c.seq), [2365, 2365, 1781], '最新交付在最前')
  assert.equal(cands[2].turn, 33)
  assert.equal(cands[2].description, '测试文件')
})
