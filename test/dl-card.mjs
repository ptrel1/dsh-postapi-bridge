// v1.5.0 聊天流内「直链下载」卡片测试。
//
// 用户核心诉求：「卡片点击就是直接的下载地址」。
// 因此本文件最重要的一条是 **卡片必须是真实的 <a href>**（不可用 onClick + fetch 替代）——
// 那正是用户已经踩过的坑（官方卡片在手机 WebView 里点了没反应）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { dlCardHelpers } from './client-bundle-loader.mjs'
import { blockOf, codeOnly, lineNo } from './_static-helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientRaw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const clientLines = clientRaw.split('\n')

const { TurnDeliverablesLinks, pickTurnDownloadFiles, isUsableDownloadUrl } = dlCardHelpers

// ── ① 纯函数：turn 过滤 ──
const FILES = [
  { seq: 10, index: 0, turn: 3, name: 'a.txt', size: 10, downloadUrl: '/api/dsh/v1/dl/tok1' },
  { seq: 10, index: 1, turn: 3, name: 'b.txt', size: 20, downloadUrl: '/api/dsh/v1/dl/tok2' },
  { seq: 12, index: 0, turn: 5, name: 'c.apk', size: 30, downloadUrl: '/api/dsh/v1/dl/tok3' },
]

test('① 只渲染属于当前 turn 的文件', () => {
  const mine3 = pickTurnDownloadFiles(FILES, 3)
  assert.equal(mine3.length, 2, 'turn 3 应有 2 个文件')
  assert.deepEqual(mine3.map((f) => f.index), [0, 1])

  const mine5 = pickTurnDownloadFiles(FILES, 5)
  assert.equal(mine5.length, 1)
  assert.equal(mine5[0].name, 'c.apk')

  assert.deepEqual(pickTurnDownloadFiles(FILES, 99), [], '没有文件的 turn 必须为空（不渲染）')
})

test('①b 同一批文件不会在别的 turn 重复出现（v1.1.0 回退的真实原因）', () => {
  const all = [3, 4, 5, 6].flatMap((t) => pickTurnDownloadFiles(FILES, t))
  assert.equal(all.length, 3, '三个文件在整个会话里总共只应出现三次')
  const keys = new Set(all.map((f) => f.seq + ':' + f.index))
  assert.equal(keys.size, 3, '不得重复出现同一个文件')
})

test('①c 缺 turn 的老数据不会被误挂到任何 turn', () => {
  const noTurn = [{ seq: 1, index: 0, name: 'x', size: 1, downloadUrl: '/api/dsh/v1/dl/t' }]
  for (const t of [1, 3, 5]) assert.deepEqual(pickTurnDownloadFiles(noTurn, t), [])
})

test('①d turn 非整数时不做过滤（返回空，避免 toString 之类的意外匹配）', () => {
  for (const bad of [null, undefined, '3', 3.5, NaN]) {
    assert.deepEqual(pickTurnDownloadFiles(FILES, bad), [], JSON.stringify(bad))
  }
})

// ── ② downloadUrl 缺失/异常 → 静默不渲染该卡片 ──
test('② downloadUrl 缺失 → 该条不进入渲染列表（静默降级）', () => {
  const withMissing = [
    { seq: 1, index: 0, turn: 3, name: 'ok.txt', size: 1, downloadUrl: '/api/dsh/v1/dl/ok' },
    { seq: 2, index: 0, turn: 3, name: 'null.txt', size: 1, downloadUrl: null },
    { seq: 3, index: 0, turn: 3, name: 'undefined.txt', size: 1 },
    { seq: 4, index: 0, turn: 3, name: 'empty.txt', size: 1, downloadUrl: '' },
    { seq: 5, index: 0, turn: 3, name: 'external.txt', size: 1, downloadUrl: 'https://evil.example/dl/x' },
    { seq: 6, index: 0, turn: 3, name: 'proto.txt', size: 1, downloadUrl: '//evil.example/dl/x' },
    { seq: 7, index: 0, turn: 3, name: 'wrongpath.txt', size: 1, downloadUrl: '/api/dsh/v1/file/tok' },
    { seq: 8, index: 0, turn: 3, name: 'space.txt', size: 1, downloadUrl: '/api/dsh/v1/dl/a b' },
  ]
  const mine = pickTurnDownloadFiles(withMissing, 3)
  assert.equal(mine.length, 1, '只有 ok.txt 可渲染，实际 ' + mine.map((f) => f.name).join(','))
  assert.equal(mine[0].name, 'ok.txt')
})

test('②b isUsableDownloadUrl 与后端同口径', () => {
  assert.equal(isUsableDownloadUrl('/api/dsh/v1/dl/abc.def_-1'), true)
  assert.equal(isUsableDownloadUrl('/api/dsh/v1/dl/'), false)
  assert.equal(isUsableDownloadUrl('/dl/x'), true, '任何以 /dl/ 结尾的文档相对路径都可')
  assert.equal(isUsableDownloadUrl('http://x/dl/y'), false)
  assert.equal(isUsableDownloadUrl(null), false)
  assert.equal(isUsableDownloadUrl(123), false)
})

// ── ③ 渲染：卡片是真实的 <a href download>（核心诉求）──
// client.js 的 e() 直接返回 React.createElement，loader 的 reactStub 把结果包成
// { type: 'element', args }，这里据此检查 DOM 结构（测的是线上那一份代码）。
function renderTree (props) {
  return TurnDeliverablesLinks(props)
}
function flatten (node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (node.type === 'element') {
    const [tag, p] = node.args
    out.push({ tag, props: p || {} })
    const children = node.args.slice(2)
    for (const c of children) flatten(c, out)
  }
  return out
}

test('③ 卡片渲染成真实链接：a[href=downloadUrl] + download 属性', async () => {
  // 用受控的 fetch 提供 /files 数据
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, files: FILES, skipped: 0 }),
    clone () { return this }, text: async () => '{}',
  })
  // 直接验证纯函数产物 + 静态结构（组件里的 hooks 需要 React 运行时，这里以源码断言 + 纯函数覆盖）
  const mine = pickTurnDownloadFiles(FILES, 3)
  assert.equal(mine.length, 2)
  // href 必须**逐字等于**后端给的 downloadUrl（不做任何拼接/改写）
  for (const f of mine) {
    assert.match(f.downloadUrl, /^\/api\/dsh\/v1\/dl\//)
  }

  // 源码级断言：e('a', {... href: f.downloadUrl, download: ...})
  const body = codeOnly(blockOf(clientLines, (l) => l.includes('function TurnDeliverablesLinks')))
  assert.ok(/e\('a', \{/.test(body), '卡片必须是 <a> 元素')
  assert.ok(/href: f\.downloadUrl/.test(body), 'href 必须直接取 downloadUrl（不得改写/加参数）')
  assert.ok(/download:/.test(body), '必须有 download 属性（让浏览器走下载通道）')
  assert.ok(/rel: 'noopener'/.test(body), '外部可点链接必须带 rel=noopener')
})

test('③b 【核心】卡片区域**不得**出现 onClick / fetch / triggerBrowserDownload', () => {
  // 这是本功能的唯一诉求：点击 = 浏览器原生下载，JS 不参与。
  // 只要卡片区出现 onClick+fetch，就退化成用户已经踩过的坑（官方卡片点了没反应）。
  const raw = blockOf(clientLines, (l) => l.includes('function TurnDeliverablesLinks'))
  assert.ok(raw, '必须能定位 TurnDeliverablesLinks')
  const body = codeOnly(raw)
  assert.ok(!/onClick/.test(body), '卡片不得挂 onClick（点击必须由浏览器原生处理）')
  assert.ok(!/\bfetch\s*\(/.test(body), '卡片渲染路径不得发请求（数据来自缓存）')
  assert.ok(!/triggerBrowserDownload/.test(body), '不得用隐藏 <a> 的 JS 触发替代真实链接')
  assert.ok(!/location\.(href|assign|replace)/.test(body), '不得改 location（会丢 SPA 状态、把 token 写进历史）')
  assert.ok(!/window\.open/.test(body), '不得用 window.open（会被手机 WebView 拦）')
})

test('③c 卡片不显示 description（用户反馈会撑破布局）', () => {
  const body = codeOnly(blockOf(clientLines, (l) => l.includes('function TurnDeliverablesLinks')))
  assert.ok(!/description/.test(body), '卡片内不得使用 description 字段')
  assert.ok(/formatBytes\(f\.size\)/.test(body), '只显示大小')
})

test('③d 卡片有独立 DOM 标记与独立样式命名（不影响官方卡片）', () => {
  const body = blockOf(clientLines, (l) => l.includes('function TurnDeliverablesLinks'))
  assert.ok(/data-postapi-download-card/.test(body), '卡片必须有独立 data 标记便于排查')
  assert.ok(/data-postapi-download-cards/.test(body), '容器必须有独立 data 标记')
  assert.ok(/dsa-dlc-list/.test(body) && /dsa-dlc\b/.test(body), '样式必须用 dsa-dlc-* 命名')
  // 不得复用抽屉的 dsa-dl-* 类名（两套 DOM 可能同屏）
  assert.ok(!/dsa-dl-row|dsa-dl-list/.test(body), '不得复用抽屉的类名')
})

test('③e 文件名过长有 ellipsis（flex:1 + min-width:0 三件套）', () => {
  const cssStart = clientLines.findIndex((l) => l.includes('.dsa-dlc-name {'))
  assert.ok(cssStart > 0, '必须有 .dsa-dlc-name 样式')
  const css = clientLines.slice(cssStart, cssStart + 8).join('\n')
  assert.ok(/overflow:\s*hidden/.test(css), '必须 overflow:hidden')
  assert.ok(/text-overflow:\s*ellipsis/.test(css), '必须 text-overflow:ellipsis')
  assert.ok(/white-space:\s*nowrap/.test(css), '必须 nowrap')
  const mainStart = clientLines.findIndex((l) => l.includes('.dsa-dlc-main {'))
  const mainCss = clientLines.slice(mainStart, mainStart + 3).join('\n')
  assert.ok(/flex:\s*1 1 auto/.test(mainCss), '名字容器必须 flex:1 1 auto')
  assert.ok(/min-width:\s*0/.test(mainCss), '必须 min-width:0（否则 flex 子项会撑破）')
  // 兜底：容器自身也要限制宽度
  const listStart = clientLines.findIndex((l) => l.includes('.dsa-dlc-list {'))
  assert.ok(/max-width:\s*100%/.test(clientLines.slice(listStart, listStart + 3).join('\n')))
})

test('③f 暗色模式：只用官方语义 token（自带深浅色）', () => {
  const cssStart = clientLines.findIndex((l) => l.includes('.dsa-dlc {'))
  const css = clientLines.slice(cssStart, cssStart + 40).join('\n')
  assert.ok(/--dsw-alias-/.test(css), '必须使用 --dsw-alias-* 语义 token（跟随主题）')
  assert.ok(!/#[0-9a-fA-F]{6}/.test(css.split('var(')[0] || ''), '不得硬编码十六进制前景/背景色')
})

// ── ④ 数据来源复用缓存（不新增请求）──
test('④ 卡片复用 loadSessionFiles 缓存，不新增请求路径', () => {
  const body = codeOnly(blockOf(clientLines, (l) => l.includes('function TurnDeliverablesLinks')))
  assert.ok(/loadSessionFiles\(base, sessionId\)/.test(body), '必须经共享 loader 取数')
  assert.ok(!/files\?sessionId=/.test(body), '不得自己拼 /files 请求')
})

test('④b 缺少 sessionId 或 turn → 不渲染、不请求', () => {
  const body = codeOnly(blockOf(clientLines, (l) => l.includes('function TurnDeliverablesLinks')))
  assert.ok(/const enabled = !!sessionId && turn !== null/.test(body), '必须有 enable 判定')
  assert.ok(/if \(!enabled\) return null/.test(body), '不满足条件必须 return null')
})

// ── ⑤ 挂载点 ──
test('⑤ 挂在 conversation.chat.turnTail，且注册块包在 try/catch（不影响官方卡片）', () => {
  const injectAt = lineNo(clientLines, (l) => l.includes("ctx.slots.inject('conversation.chat.turnTail'"))
  assert.ok(injectAt > 0, '必须注入 conversation.chat.turnTail')
  assert.ok(/name: 'conversation\.chat\.turnTail'/.test(clientRaw), 'register 的 name 必须正确')
  assert.ok(/id: 'dsh-postapi-bridge\/download-cards'/.test(clientRaw), '必须用自有命名空间 id')
  // 向前找 try {
  let tryLine = -1
  for (let i = injectAt - 2; i >= 0 && i > injectAt - 20; i--) {
    if (clientLines[i].trim() === 'try {') { tryLine = i + 1; break }
  }
  assert.ok(tryLine > 0 && tryLine < injectAt, '注册必须包在 try 里（异常不得污染官方卡片）')
})

test('⑤b 官方 deliverables.file.actions 与抽屉入口仍然保留（能力不退化）', () => {
  assert.ok(/ctx\.slots\.inject\('deliverables\.file\.actions'/.test(clientRaw), '官方卡片下载按钮必须保留')
  assert.ok(/ctx\.slots\.inject\('conversation\.session\.header\.actions'/.test(clientRaw), '抽屉入口必须保留')
})
