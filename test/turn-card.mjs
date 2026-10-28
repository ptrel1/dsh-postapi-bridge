import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { turnCardHelpers } from './client-bundle-loader.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// 统计 fetch 调用次数（loader 已在**求值期**读过 client.js，此处替换全局 fetch 即可影响运行时）
let fetchCount = 0
let fetchPayload = null
let fetchShouldFail = false
let fetchStatus = 200
globalThis.fetch = async (url) => {
  fetchCount += 1
  if (fetchShouldFail) throw new Error('network down')
  const body = fetchStatus === 200 ? JSON.stringify(fetchPayload) : '{"ok":false}'
  return {
    ok: fetchStatus === 200,
    status: fetchStatus,
    json: async () => JSON.parse(body),
    clone () { return this },
    text: async () => body,
  }
}

const helpers = turnCardHelpers
const FILES = [
  { seq: 10, index: 0, turn: 3, name: 'a.txt', size: 10, path: '/w/a.txt', description: '' },
  { seq: 10, index: 1, turn: 3, name: 'b.txt', size: 20, path: '/w/b.txt', description: '' },
  { seq: 12, index: 0, turn: 5, name: 'c.txt', size: 30, path: '/w/c.txt', description: '' },
]

test('setup: __turnCardHelpers 已导出', () => {
  assert.ok(helpers, 'client.js 必须导出 __turnCardHelpers')
  assert.equal(typeof helpers.loadSessionFiles, 'function')
  assert.equal(typeof helpers.__resetFilesCache, 'function')
  assert.ok(helpers.FILES_CACHE_TTL_MS > 0)
})

// ── 缓存 ──
test('缓存：多个 turn 同时渲染只触发一次 /files', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchStatus = 200
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  // 模拟一个会话里 3 个 turn 的组件实例**并发**取数
  const [r1, r2, r3] = await Promise.all([
    helpers.loadSessionFiles('/api/dsh/v1', 'sess-A'),
    helpers.loadSessionFiles('/api/dsh/v1', 'sess-A'),
    helpers.loadSessionFiles('/api/dsh/v1', 'sess-A'),
  ])
  assert.equal(fetchCount, 1, '并发三次只应发一次请求，实际 ' + fetchCount)
  assert.equal(r1.files.length, 3)
  assert.equal(r2.files.length, 3)
  assert.equal(r3.files.length, 3)
})

test('缓存：TTL 内后续调用不再联网', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-B')
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-B')
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-B')
  assert.equal(fetchCount, 1, 'TTL 内三次只应发一次，实际 ' + fetchCount)
})

test('缓存：不同 sessionId 各自独立请求', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-C1')
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-C2')
  assert.equal(fetchCount, 2, '不同会话不应共用缓存')
})

test('缓存：失败不缓存，下次渲染会重试', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchShouldFail = true
  const bad = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-D')
  assert.equal(bad.ok, false)
  assert.equal(fetchCount, 1)
  // 网络恢复后重试（失败条目已被清除）
  fetchShouldFail = false
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  const good = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-D')
  assert.equal(good.ok, true)
  assert.equal(fetchCount, 2, '失败后应重试，实际 ' + fetchCount)
})

test('缓存：HTTP 非 200 不缓存', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchStatus = 401
  const r1 = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-E')
  assert.equal(r1.ok, false)
  fetchStatus = 200
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  const r2 = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-E')
  assert.equal(r2.ok, true)
  assert.equal(fetchCount, 2)
})

// ── 按 turn 过滤（组件内联逻辑，此处按同样规则验证）──
test('过滤：同一 turn 的多个文件全部命中', () => {
  const mine = FILES.filter((f) => f.turn === 3)
  assert.equal(mine.length, 2)
  assert.deepEqual(mine.map((f) => f.index), [0, 1])
})

test('过滤：不同 turn 不串', () => {
  assert.deepEqual(FILES.filter((f) => f.turn === 5).map((f) => f.seq), [12])
  assert.deepEqual(FILES.filter((f) => f.turn === 99), [], '没有文件的 turn 应为空')
})

test('过滤：缺少 turn 的文件不会被任何 turn 命中（避免误挂）', () => {
  const noTurn = { seq: 1, index: 0, name: 'x', size: 1 }
  for (const t of [1, 3, 5]) {
    assert.equal([noTurn, ...FILES].filter((f) => f.turn === t).length,
      FILES.filter((f) => f.turn === t).length)
  }
})

// ── 下载坐标 ──
test('下载坐标直接取自 /files 的 seq/index（不依赖 actionUrl）', () => {
  for (const f of FILES) {
    assert.ok(Number.isSafeInteger(f.seq), 'seq 必须是整数')
    assert.ok(Number.isSafeInteger(f.index), 'index 必须是整数')
  }
  // 组件正是这么构造 coordinate 的（静态断言 ⑤c 守着）
  const coord = { sessionId: 'sess-A', seq: FILES[0].seq, index: FILES[0].index }
  assert.deepEqual(coord, { sessionId: 'sess-A', seq: 10, index: 0 })
})

// ───────── v1.1.0：新 present 文件必须能自动出现（不需刷新页面）─────────
//
// 用户实测痛点：磁盘上 3 个文件，界面只显示 2 个，刷新后才看到第 3 个。
// 根因：组件只在挂载时取一次数，新事件到达后不再拉取。
// 修法：① TTL 缩短到 3s；② 组件轮询（未打开抽屉 4s / 打开 2s）；③ invalidateFilesCache 主动失效。

test('刷新 1：新增 present 文件后，TTL 过期即能看到（2 → 3）', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchStatus = 200
  const two = FILES.slice(0, 2).map((f) => ({ ...f, turn: 3 }))
  fetchPayload = { ok: true, files: two, skipped: 0 }
  const first = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-REFRESH')
  assert.equal(first.files.length, 2, '初始 2 个')
  assert.equal(first.maxTurn, 3)

  // 后端新增一条 present 事件
  const three = [...two, { seq: 99, index: 0, turn: 5, name: 'new.apk', size: 100, path: '/w/n', description: '' }]
  fetchPayload = { ok: true, files: three, skipped: 0 }

  // TTL 内仍返回旧的（这是缓存的代价，可接受）
  const cached = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-REFRESH')
  assert.equal(cached.files.length, 2, 'TTL 内返回缓存')

  // 主动失效（组件发现 turn 号增长时就会这么做）
  helpers.invalidateFilesCache('sess-REFRESH')
  const after = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-REFRESH')
  assert.equal(after.files.length, 3, '失效后必须拿到 3 个')
  assert.equal(after.maxTurn, 5, 'maxTurn 跟随更新')
})

test('刷新 2：maxTurn 可用于判断「有没有新事件」', async () => {
  helpers.__resetFilesCache()
  fetchStatus = 200
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  const r = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-MAXTURN')
  assert.equal(r.maxTurn, 5, '应取最大的 turn（3,3,5 → 5）')
  // 空列表时 maxTurn = -1，任何 turn 都大于它 → 会触发重拉，符合预期
  helpers.__resetFilesCache()
  fetchPayload = { ok: true, files: [], skipped: 0 }
  const empty = await helpers.loadSessionFiles('/api/dsh/v1', 'sess-EMPTY')
  assert.equal(empty.maxTurn, -1)
})

test('刷新 3：invalidateFilesCache 只影响指定会话', async () => {
  helpers.__resetFilesCache()
  fetchCount = 0
  fetchStatus = 200
  fetchPayload = { ok: true, files: FILES, skipped: 0 }
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-X')
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-Y')
  assert.equal(fetchCount, 2)
  helpers.invalidateFilesCache('sess-X')
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-Y')
  assert.equal(fetchCount, 2, 'Y 的缓存不受影响')
  await helpers.loadSessionFiles('/api/dsh/v1', 'sess-X')
  assert.equal(fetchCount, 3, 'X 已失效需重拉')
})

test('刷新 4：TTL 为 3s（足够短，用户可感知的延迟上限）', () => {
  assert.ok(helpers.FILES_CACHE_TTL_MS <= 5000,
    'TTL 必须 ≤5s，否则发完文件要等太久才出现，实测 ' + helpers.FILES_CACHE_TTL_MS)
  assert.ok(helpers.FILES_CACHE_TTL_MS >= 1000, '过短会放大请求量')
})

test('刷新 5：组件轮询间隔存在且打开抽屉时更快', () => {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.ok(/setInterval\(tick, open \? 2000 : 4000\)/.test(src),
    '必须有轮询：抽屉打开 2s / 未打开 4s')
  assert.ok(/clearInterval\(timer\)/.test(src), '卸载必须清 timer（防泄漏）')
})

test('刷新 6：轮询只在有 sessionId 时启动', () => {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.ok(/if \(!sessionId\) return;[\s\S]{0,400}setInterval/.test(src),
    '无 sessionId 时不得起轮询')
})
