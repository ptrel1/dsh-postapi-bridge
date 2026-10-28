// v0.10.0 静态断言：下载按钮的注册方式与实现约束（纯文本检查，不启动服务）
//
// 存在理由：这些都是「改了就静默坏掉、运行时很难发现」的约定 ——
//   · slot 名写错 → 按钮永远不出现
//   · 漏 credentials → 有会话也 401（表现为「请先登录」却明明已登录）
//   · 用了 alert/window.open/改 location → 破坏 SPA 状态或留下 token 历史
// 用行号/文本断言把它们钉住，比每次人工审查便宜。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const src = raw.split('\n')
// 取「从 function DownloadFileAction 起、到该函数体闭合」的完整源码块。
// 为什么不用固定的 compLine + 130 行窗口：组件里加日志/注释会把它推长，
// 窗口一超出就取不到后面的按钮定义（v0.11.1 加诊断日志时就踩了这个坑）。
const componentChunk = () => {
  const start = src.findIndex((l) => l.includes('function DownloadFileAction'))
  if (start === -1) throw new Error('DownloadFileAction not found')
  // 组件函数在源码里以「\t\t}」结束（两级缩进），从 start 往后找第一个这样的行
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\t\t}") return src.slice(start, i + 1).join('\n')
  }
  return src.slice(start, start + 300).join('\n')
}
const lineNo = (pred) => {
  const i = src.findIndex(pred)
  return i === -1 ? -1 : i + 1
}

test('④ client.js 确实注册了 deliverables.file.actions，且经 ctx.slots.inject', () => {
  const injectLine = lineNo((l) => l.includes("ctx.slots.inject('deliverables.file.actions'"))
  assert.ok(injectLine > 0, "必须出现 ctx.slots.inject('deliverables.file.actions', ...)")
  const nameLine = lineNo((l) => l.includes("name: 'deliverables.file.actions'"))
  assert.ok(nameLine > 0, 'register 的 name 必须是官方 slot 名')
  const idLine = lineNo((l) => l.includes("id: 'postapi-bridge'") && l.trim().startsWith('id:'))
  assert.ok(idLine > 0, 'list 槽必须给唯一 id')
  // 必须声明为 list + session（与官方 file-actions.ts 的 SlotMap 定义一致）
  assert.ok(/deliverables\.file\.actions/.test(raw))
})

test('④b 注册不能影响官方卡片：注册块包在 try/catch 里', () => {
  const injectLine = lineNo((l) => l.includes("ctx.slots.inject('deliverables.file.actions'"))
  // 向前找 try {（允许中间夹注释行）
  let tryLine = -1
  for (let i = injectLine - 1; i >= 0 && i > injectLine - 15; i--) {
    if (src[i].trim() === 'try {') { tryLine = i + 1; break }
  }
  assert.ok(tryLine > 0, 'deliverables.file.actions 的 inject 必须包在 try 里')
  assert.ok(tryLine < injectLine, 'try 必须在 inject 之前')
})

test('⑤ 请求带 credentials: \'same-origin\'（否则有会话也会被当未登录）', () => {
  assert.ok(/credentials:\s*'same-origin'/.test(raw), "必须显式写 credentials: 'same-origin'")
  // 且必须出现在 file-ticket 的 fetch 调用里
  const ticketFetch = lineNo((l) => l.includes("'/file-ticket'"))
  assert.ok(ticketFetch > 0, '必须请求 /file-ticket')
  const credLine = lineNo((l) => /credentials:\s*'same-origin'/.test(l))
  assert.ok(credLine > 0)
  assert.ok(Math.abs(credLine - ticketFetch) < 8, 'credentials 必须就在该 fetch 的 init 里（行距 ' + Math.abs(credLine - ticketFetch) + '）')
})

/**
 * 按大括号配平切出一个函数/块的**代码体**（从给定行开始，遇到配平后的收尾大括号为止）。
 * 不能用「找第一个 '}' 行」—— 函数里有 if/else 嵌套，第一个 '}' 只是内层的。
 * @param {number} startIndex 起始行下标（0 基）
 * @returns {string}
 */
function braceBlock (startIndex) {
  let depth = 0
  let started = false
  const out = []
  for (let i = startIndex; i < src.length; i++) {
    const line = src[i]
    out.push(line)
    for (const ch of line) {
      if (ch === '{') { depth += 1; started = true } else if (ch === '}') depth -= 1
    }
    if (started && depth <= 0) break
  }
  return out.join('\n')
}

/**
 * 去掉注释行，只留代码。
 * 断言「没有 location.href =」这类**行为约束**时必须基于代码，
 * 否则文档里解释「为什么不用 location.href」的那句注释会把自己判违规。
 * @param {string} text
 * @returns {string}
 */
function codeOnly (text) {
  return text.split('\n')
    .filter((l) => {
      const s = l.trim()
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
    })
    .join('\n')
}
/** 切出「下载按钮」这一区块的源码（从区块标题到 apply 定义之前）。 */
function downloadBlock () {
  const start = src.findIndex((l) => l.includes('v0.10.0 交付物卡片「下载」按钮'))
  const end = src.findIndex((l, i) => i > start && l.includes('Cordis 客户端插件生命周期注册'))
  assert.ok(start > 0 && end > start, '下载按钮区块存在')
  return src.slice(start, end).join('\n')
}

test('⑥ 下载按钮区块里没有 alert / window.open / location 赋值', () => {
  // 只扫代码不扫注释：区块里有「为什么不用 window.location.href = url」的说明文字，
  // 那是设计依据，不是用法。
  const block = codeOnly(downloadBlock())
  assert.ok(!/\balert\s*\(/.test(block), '禁止 alert（要求 inline 错误态）')
  assert.ok(!/window\.open\s*\(/.test(block), '禁止 window.open（会被弹窗拦截，且丢 cookie 语义）')
  // 不允许把下载地址赋给 location：会留下含 token 的历史记录，且打断 SPA。
  // 注意：文件别处的 `window.location.href = '/login'`（未登录跳转，v0.7.0 起）
  // 属于既有合法逻辑，不在本断言范围内 —— 故这里只扫区块，不扫全文。
  assert.ok(!/location\.href\s*=/.test(block), '禁止 location.href = ...（改由 <a download> 触发）')
  assert.ok(!/location\.assign\s*\(/.test(block), '禁止 location.assign')
  assert.ok(!/location\.replace\s*\(/.test(block), '禁止 location.replace')
})

test('⑥b 下载通过 <a download> 触发（保 SPA 状态 + 不污染历史）', () => {
  assert.ok(/function triggerBrowserDownload/.test(raw), '必须有 triggerBrowserDownload')
  const start = src.findIndex((l) => l.includes('function triggerBrowserDownload'))
  const end = src.findIndex((l, i) => i > start && l.trim() === '}')
  const body = src.slice(start, end).join('\n')
  assert.ok(/createElement\('a'\)/.test(body), '必须 createElement("a")')
  assert.ok(/\.download\s*=/.test(body), '必须设置 a.download')
  assert.ok(/\.click\(\)/.test(body), '必须调用 a.click()')
  assert.ok(/removeChild/.test(body), '临时节点必须移除')
})

test('⑦ actionUrl 用 new URL(...) 解析，不用字符串 split', () => {
  const start = src.findIndex((l) => l.includes('function parsePresentedActionUrl'))
  assert.ok(start >= 0, '必须有 parsePresentedActionUrl')
  const body = codeOnly(braceBlock(start))
  assert.ok(/new URL\(actionUrl, base\)/.test(body), '必须 new URL(actionUrl, base)')
  // base 必须来自显式 origin 参数或 location.origin（不依赖调用点传入绝对 URL）
  assert.ok(/base = origin/.test(body), 'base 必须可由调用方注入（便于单测）')
  assert.ok(/base = location\.origin/.test(body), '缺省 base 必须是 location.origin')
  assert.ok(!/\.split\(/.test(body), '不得用字符串 split 解析 URL')
  assert.ok(/searchParams\.get\('sessionId'\)/.test(body), '必须用 searchParams 而非手工切分')
})

test('⑦b 解析失败必须 return null（静默降级），不得 throw', () => {
  const start = src.findIndex((l) => l.includes('function parsePresentedActionUrl'))
  const body = codeOnly(braceBlock(start))
  assert.ok(!/\.finally\(/.test(body))
  // 所有失败分支都是 return null；唯一 catch 也 return null
  // 注意源码形态是 `} catch (err) {` 换行 + 中文注释 + `return null;`，
  // 故用 [\s\S]*? 跨行匹配，不允许顺手把注释删掉就悄悄失败。
  assert.ok(/\} catch \(err\) \{[\s\S]*?return null;\s*\}/.test(body), 'catch 里必须 return null')
  // 组件里解析失败分支必须直接 return null（不渲染按钮）
  const compLine = lineNo((l) => l.includes('function DownloadFileAction'))
  assert.ok(compLine > 0)
  const compBody = codeOnly(braceBlock(compLine - 1))
  assert.ok(/if \(coordinate === null\) \{[\s\S]{0,300}?return null;/.test(compBody), '解析失败必须 return null（不渲染）')
  assert.ok(/warnParseFailureOnce\(actionUrl\)/.test(compBody), '解析失败必须留一条控制台线索')
})

test('⑧ 在途防抖用 ref（state 异步生效，只靠 state 会漏一帧）', () => {
  const compLine = lineNo((l) => l.includes('function DownloadFileAction'))
  const chunk = componentChunk()
  assert.ok(/useRef\(false\)/.test(chunk), '必须有 inFlightRef = useRef(false)')
  assert.ok(/inFlightRef\.current\) return/.test(chunk), '在途必须直接 return（防抖）')
  assert.ok(/inFlightRef\.current = false/.test(chunk), '必须在 finally 里复位')
})

test('⑨ pending 与自身在途合并判断（owner.pending 参与 disabled）', () => {
  const compLine = lineNo((l) => l.includes('function DownloadFileAction'))
  const chunk = componentChunk()
  assert.ok(/ownerPending/.test(chunk), '必须读 owner.pending')
  assert.ok(/const busy = state === 'loading' \|\| ownerPending/.test(chunk), 'busy 必须合并两者')
  assert.ok(/disabled: busy/.test(chunk), '按钮 disabled 必须用合并后的 busy')
})

test('⑩ 失败态是 inline（setErrorText + data-state），不是弹窗', () => {
  const compLine = lineNo((l) => l.includes('function DownloadFileAction'))
  const chunk = componentChunk()
  assert.ok(/setErrorText/.test(chunk), '必须有 inline 错误文案 state')
  assert.ok(/'data-state': state/.test(chunk), '必须用 data-state 驱动样式')
  assert.ok(/DOWNLOAD_ERROR_HOLD_MS/.test(raw), '错误态必须自动回落（有限停留）')
})

test('⑪ 返回的 url 必须同源校验后才交给浏览器（防开放重定向）', () => {
  const compLine = lineNo((l) => l.includes('function DownloadFileAction'))
  const chunk = componentChunk()
  assert.ok(/new URL\(url, location\.origin\)/.test(chunk), '必须校验下发 url 的同源性')
  assert.ok(/sameOrigin/.test(chunk), '必须有 sameOrigin 判定')
})

test('⑫ 依赖契约（官方 URL 形态）必须写在注释里', () => {
  assert.ok(/presentedFileUrl/.test(raw), '注释必须点名官方 presentedFileUrl()')
  assert.ok(/present\/open\?sessionId/.test(raw), '注释必须写明 URL 形态')
  assert.ok(/隐性依赖/.test(raw), '注释必须标注这是隐性依赖')
  assert.ok(/静默不渲染|静默隐藏/.test(raw), '注释必须说明解析失败是静默降级')
})

test('⑬ 样式沿用 dsa-* 命名并有暗黑模式语义 token', () => {
  assert.ok(/\.dsa-dl\s*\{/.test(raw), '必须有 .dsa-dl 主样式')
  assert.ok(/\.dsa-dl:hover/.test(raw), '必须有 hover 态')
  assert.ok(/\.dsa-dl\[data-state="error"\]/.test(raw), '必须有错误态样式')
  assert.ok(/--dsw-alias-/.test(raw), '必须使用官方语义 token（自带暗黑模式）')
  // 尺寸与官方文件卡片 open/reveal 按钮协调：24px 高
  const cssStart = raw.indexOf('.dsa-dl {')
  const cssChunk = raw.slice(cssStart, cssStart + 800)
  assert.ok(/height:\s*24px/.test(cssChunk), '高度 24px，与官方 open/reveal 按钮一致')
})

test('⑭ 版本号：AUDIT_VERSION 与 package.json 同步（不写死版本号，避免每次升版都要改测试）', async () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  // 版本号本身不在此断言具体值：它随发布变化，硬编码只会让每次升版都要改测试
  // （v0.11.0 时这个测试就因为写死 0.10.0 而误报失败）。这里只校验「两者一致」。
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json 版本号格式合法')
  const idx = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  const m = idx.match(/const AUDIT_VERSION = '([^']+)'/)
  assert.ok(m, 'AUDIT_VERSION 声明存在')
  assert.equal(m[1], pkg.version, 'AUDIT_VERSION 必须与 package.json 同步')
})
