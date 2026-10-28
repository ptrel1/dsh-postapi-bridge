// v0.12.0 静态断言：presented 清单接口 + 自渲染面板
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { blockOf, codeOnly, lineNo as sharedLineNo } from './_static-helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const indexRaw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const clientRaw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const indexLines = indexRaw.split('\n')
const clientLines = clientRaw.split('\n')
const lineNo = (arr, pred) => { const i = arr.findIndex(pred); return i === -1 ? -1 : i + 1 }

// ── ① 接口鉴权位置（在 Bearer 之后、405 之前） ──
test('① v0.12.3：/files（原 /presented）属人类通道，走 cookie 鉴权且早于机器通道判定', () => {
  // 设计变更：原先要求 Bearer（机器通道），线上实测浏览器只带 cookie → 必然 401。
  // 现在改为人类通道：cookie 优先，回环可用 Bearer 兜底。
  const human = lineNo(indexLines, (l) => l.includes('const isHumanEndpoint = HUMAN_ENDPOINTS.includes(subPath)'))
  const bearer = lineNo(indexLines, (l) => l.startsWith('    if (!isLoopback) {'))
  const guard = lineNo(indexLines, (l) => l.trim().startsWith("if (req.method !== 'POST')"))
  assert.ok(human > 0 && bearer > 0 && guard > 0)
  assert.ok(human < bearer, '人类通道分流(' + human + ') 必须早于机器通道判定(' + bearer + ')')
  assert.ok(human < guard, '且必须早于 405 守卫(' + guard + ')')
  assert.ok(indexRaw.includes("'/files'"), '须列入 HUMAN_ENDPOINTS（v0.12.3 改名）')
})
test('①b handler 内部先做登录鉴权（findSessionVerified）', () => {
  const at = lineNo(indexLines, (l) => l.includes('const handlePresentedList'))
  assert.ok(at > 0)
  const body = indexLines.slice(at - 1, at + 20).join('\n')
  assert.ok(/findSessionVerified\(req\)/.test(body), '必须先校验登录态')
  const authAt = body.indexOf('findSessionVerified')
  const listAt = body.indexOf('listEvents')
  assert.ok(authAt < listAt || listAt === -1, '鉴权必须在读事件之前')
})

test('①c sessionQuery 缺失 → 503（与下载端点同口径）', () => {
  // v1.0.2：改用配平取块 + ctx.get() 口径（原断言写死了 `ctx.sessionQuery` 旧写法）
  const body = blockOf(indexLines, (l) => l.includes('const handlePresentedList'))
  assert.ok(body, '必须能定位 handlePresentedList')
  assert.ok(/typeof sq\.listEvents !== 'function'/.test(body), '须有 listEvents 可用性判断')
  assert.ok(/sessionQueryOf\(ctx\)/.test(body), "须用 sessionQueryOf(ctx) 取服务（不可直接读属性）")
  assert.ok(/files list disabled: session query service unavailable/.test(body))
})

// ── ② 不签发票据 ──
test('② /files 不签发票据（不得出现 signFileTicket / ticketStore.put）', () => {
  const at = lineNo(indexLines, (l) => l.includes('const handlePresentedList'))
  // 取到下一个函数定义为止
  const nextAt = indexLines.findIndex((l, i) => i > at && l.includes('const handleFileTicket'))
  const body = indexLines.slice(at - 1, nextAt > 0 ? nextAt : at + 150).join('\n')
  assert.ok(!/signFileTicket/.test(body), '清单接口不得签发 token')
  assert.ok(!/ticketStore\.put/.test(body), '清单接口不得写票据库')
  assert.ok(!/ticketStore\.persist/.test(body), '清单接口不得落盘票据')
})

test('②b 返回字段：ticketUrl 仍是固定端点；v1.5.0 另加 downloadUrl/downloadExpiresAt', () => {
  // ⚠️ 取块方式从「固定 150 行窗口」改为 braces 配平（blockOf）：
  //   v1.5.0 给本函数加了直链签发逻辑，函数变长后固定窗口会截断到块外，
  //   断言会「因为窗口问题」失败而不是因为代码问题 —— 那正是 _static-helpers 要消除的假阴性。
  const body = blockOf(indexLines, (l) => l.includes('const handlePresentedList'))
  assert.ok(body, '必须能定位 handlePresentedList')
  assert.ok(/ticketUrl: apiPrefix \+ '\/file-ticket'/.test(body), 'ticketUrl 为固定端点')
  assert.ok(/name: basename\(safe\.absPath\)/.test(body), 'name 为 basename')
  assert.ok(/size: safe\.size/.test(body))
  // v1.5.0：卡片直链必须随清单一起下发（否则前端又要「点击才换地址」）
  assert.ok(/downloadUrl: dl\.ok \? dl\.url : null/.test(body), '每条必须带 downloadUrl')
  assert.ok(/downloadExpiresAt:/.test(body), '每条必须带 downloadExpiresAt')
})

// ── ③ 跳过逻辑 ──
test('③ 单条不合格只跳过，不整批失败', () => {
  const at = lineNo(indexLines, (l) => l.includes('const handlePresentedList'))
  const body = indexLines.slice(at - 1, at + 150).join('\n')
  assert.ok(/bump\('path-' \+ safe\.reason\)/.test(body), '路径不合格 → 跳过并计数')
  assert.ok(/bump\('too-large'\)/.test(body), '超限 → 跳过并计数')
  assert.ok(/continue/.test(body), '必须 continue 而非 return')
  assert.ok(/skippedReasons/.test(body), '必须返回原因摘要')
})

test('③b 路径安全复用 resolveSafeFilePath（realpath 口径与下载一致）', () => {
  const at = lineNo(indexLines, (l) => l.includes('const handlePresentedList'))
  const body = indexLines.slice(at - 1, at + 150).join('\n')
  assert.ok(/resolveSafeFilePath\(cand\.path, headCwd\)/.test(body))
  assert.ok(!/startsWith\(/.test(body), '归属判断不得用 startsWith')
})

// ── ④ 审计 ──
test('④ 审计事件 files-list（v0.12.3 改名），记 sid/文件数/skipped，不记 token', () => {
  // 同样改用配平取块（v1.5.0 函数变长，固定窗口会截断）
  const body = blockOf(indexLines, (l) => l.includes('const handlePresentedList'))
  assert.ok(/event: 'files-list'/.test(body))
  assert.ok(/uid: session\.username, sid: sessionId/.test(body))
  assert.ok(/files: files\.length, skipped/.test(body))
  // 注意：body 里合法的 'ticketUrl' / '/file-ticket' 含 'ticket' 字样，不是 token，
  // 因此不能粗暴匹配 /token/。这里精确检查「有没有把票据值/签名塞进审计或返回体」。
  for (const bad of ['signed.token', 'signFileTicket(', 'ticketStore.put', '.value']) {
    assert.ok(!body.includes(bad), '审计与返回体不得含 token 相关内容：' + bad)
  }
})

// ── ⑤ client 面板 ──
test('⑤ 【v1.1.0】client 有 DeliverablesLauncher（按钮+抽屉），旧形态已移除', () => {
  // 形态演进：平铺面板 → turn 尾平铺卡片 → **按钮 + 右侧抽屉**（当前）
  assert.ok(/function DeliverablesLauncher\(props\)/.test(clientRaw), '必须有按钮+抽屉组件')
  assert.ok(!/function PresentedFilesPanel\(props\)/.test(clientRaw), '旧顶部面板组件应已移除')
  assert.ok(!/function TurnDeliverablesCard\(props\)/.test(clientRaw), 'turn 尾卡片形态应已移除')
  for (const kw of ['launcher slot:', 'files fetched n=', 'files skip:']) {
    assert.ok(clientRaw.includes(kw), '缺少日志：' + kw)
  }
  assert.ok(/launcher: no slot available/.test(clientRaw), '无可用 slot 时必须留痕')
})

test('⑤b 【v1.1.0】不依赖官方卡片 DOM，改走自有 /files 接口（经共享 loader）', () => {
  const body = blockOf(clientLines, (l) => l.includes('function DeliverablesLauncher'))
  assert.ok(body, '必须能定位组件')
  assert.ok(!/data-presented-file/.test(body), '不得依赖官方卡片 DOM')
  assert.ok(/loadSessionFiles\(base, sessionId\)/.test(body), '必须经共享 loader 取数')
})

test('⑤c 【v1.1.0】抽屉内每行有下载按钮，坐标取自 /files 的 seq/index', () => {
  const body = blockOf(clientLines, (l) => l.includes('function DeliverablesLauncher'))
  assert.ok(/e\(DownloadFileAction, \{/.test(body), '必须有下载按钮')
  assert.ok(/coordinate: \{ sessionId, seq: f\.seq, index: f\.index \}/.test(body),
    '坐标必须来自 /files 的 seq/index')
})

test('⑤d DownloadFileAction 支持显式坐标且优先于 actionUrl', () => {
  const at = clientLines.findIndex((l) => l.includes('function DownloadFileAction'))
  const body = clientLines.slice(at, at + 40).join('\n')
  assert.ok(/const explicit = props && props\.coordinate/.test(body))
  assert.ok(/hasExplicit/.test(body))
  assert.ok(/Number\.isSafeInteger\(explicit\.seq\)/.test(body), 'seq 必须做整数校验')
})

test('⑤e 注入点正确且旧的 deliverables.file.actions 保留', () => {
  assert.ok(/ctx\.slots\.inject\('deliverables\.file\.actions'/.test(clientRaw), '旧入口不得删除')
  assert.ok(/ctx\.slots\.inject\('conversation\.session\.header\.actions'/.test(clientRaw),
    '按钮须挂在会话顶部 actions')
  assert.ok(/id: 'dsh-postapi-bridge\/files'/.test(clientRaw), 'id 用自有命名空间')
  // v1.1.0 曾回退 turnTail，理由是「会话级清单不该逐 turn 重复」。
  // v1.5.0 重新启用，但**语义不同**：turn 尾卡片按 turn 字段过滤，只渲染本轮产出的文件，
  // 每个文件只出现在自己那一轮 —— 没有重复。抽屉（会话级汇总）继续保留，两者职责不同。
  // 因此这里断言的是「turnTail 必须按 turn 过滤」，而不是「不许出现 turnTail」。
  assert.ok(/ctx\.slots\.inject\('conversation\.chat\.turnTail'/.test(clientRaw),
    'v1.5.0：turn 尾直链卡片必须挂在 conversation.chat.turnTail')
  assert.ok(/pickTurnDownloadFiles/.test(clientRaw), 'turn 尾卡片必须按 turn 过滤')
})

test('⑤f 【v1.1.0】N=0 时按钮不渲染（不占位）', () => {
  const body = blockOf(clientLines, (l) => l.includes('function DeliverablesLauncher'))
  const code = codeOnly(body)
  assert.ok(/if \(!sessionId \|\| !files \|\| files\.length === 0\) return null/.test(code),
    '无文件或无会话时必须 return null')
})

test('⑤g 【v1.1.0】抽屉有关闭三件套：遮罩点击 / ESC / 关闭按钮', () => {
  const body = blockOf(clientLines, (l) => l.includes('function DeliverablesLauncher'))
  const code = codeOnly(body)
  assert.ok(/dsa-dl-mask/.test(body), '必须有遮罩')
  assert.ok(/onClick: \(\) => setOpen\(false\)/.test(code), '遮罩点击须关闭')
  assert.ok(/'Escape'/.test(code), 'ESC 须关闭')
  assert.ok(/dsa-dl-close/.test(body), '必须有关闭按钮')
  assert.ok(/data-postapi-deliverables-drawer/.test(body), '抽屉须有 data 标记便于排查')
})

test('⑤h 【v1.1.0】长文件名不撑破：ellipsis + min-width:0', () => {
  // 用户实测痛点：「文字太长超出屏幕」。
  // 三条缺一不可：flex:1 1 auto / min-width:0 / text-overflow:ellipsis。
  const cssStart = clientLines.findIndex((l) => l.includes('v1.1.0 交付物入口：紧凑按钮'))
  const cssEnd = clientLines.findIndex((l, i) => i > cssStart && l.includes('.dsa-dl-skipped'))
  assert.ok(cssStart >= 0 && cssEnd > cssStart, '必须能定位样式区')
  const css = clientLines.slice(cssStart, cssEnd + 3).join('\n')
  const nameRule = css.match(/\.dsa-dl-name\s*\{([\s\S]*?)\}/)
  assert.ok(nameRule, '必须有 .dsa-dl-name 规则')
  assert.ok(/min-width:\s*0/.test(nameRule[1]), 'flex 子项必须有 min-width:0，否则 ellipsis 不生效')
  assert.ok(/text-overflow:\s*ellipsis/.test(nameRule[1]), '必须有 text-overflow: ellipsis')
  assert.ok(/overflow:\s*hidden/.test(nameRule[1]), '必须有 overflow: hidden')
  assert.ok(/white-space:\s*nowrap/.test(nameRule[1]), '必须不换行')
  // description 不得进正文（只放 title）
  const body = blockOf(clientLines, (l) => l.includes('function DeliverablesLauncher'))
  assert.ok(/title: f\.description \|\| f\.path \|\| f\.name/.test(body), 'description 只放 title')
  assert.ok(!/dsa-dl-desc/.test(body), '行内不得渲染 description 元素')
})

test('⑤i 【v1.1.0】抽屉样式：内部滚动、不超视口、暗色走语义 token', () => {
  const cssStart = clientLines.findIndex((l) => l.includes('v1.1.0 交付物入口：紧凑按钮'))
  const cssEnd = clientLines.findIndex((l, i) => i > cssStart && l.includes('.dsa-dl-skipped'))
  const css = clientLines.slice(cssStart, cssEnd + 3).join('\n')
  const drawer = css.match(/\.dsa-dl-drawer\s*\{([\s\S]*?)\}/)
  assert.ok(drawer, '必须有 .dsa-dl-drawer 规则')
  assert.ok(/max-height:\s*100vh/.test(drawer[1]), '抽屉不得超出视口')
  const list = css.match(/\.dsa-dl-list\s*\{([\s\S]*?)\}/)
  assert.ok(list, '必须有 .dsa-dl-list 规则')
  assert.ok(/overflow-y:\s*auto/.test(list[1]), '文件多时列表内部滚动')
  assert.ok(/min-height:\s*0/.test(list[1]), 'flex 子项需 min-height:0 才能正确滚动')
  // 语义 token（暗色自适应）
  assert.ok(/var\(--dsw-alias-/.test(drawer[1]), '抽屉须用语义 token')
})

test('⑤j 组件日志不含敏感信息且走 dlLog', () => {
  const body = blockOf(clientLines, (l) => l.includes('function DeliverablesLauncher'))
  assert.ok(!/console\.(log|info|warn)\(/.test(codeOnly(body)), '日志必须走 dlLog')
  assert.ok(/dlLog\(/.test(body) || /loadSessionFiles/.test(body), '须有统一日志路径')
})
test('⑥ AUDIT_VERSION 与 package.json 同步（不写死版本号）', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  const m = indexRaw.match(/const AUDIT_VERSION = '([^']+)'/)
  assert.equal(m[1], pkg.version)
})

// ── v0.12.3 防回归：路由不得再出现 '/presented' ──
test("⑦ 【防回归】HUMAN_ENDPOINTS 不得含 '/presented'", () => {
  // 历史：v0.12.3 把 /presented 改名 /files，当时以为是**路径**与宿主 present.open 冲突。
  // v1.0.0 实测更正：真正的拦截发生在**参数名**层面（带 `sessionId` query 的 /api/* 请求
  // 会被宿主网关拦成空白 400）。/files 这个名字本身没问题，保留；参数名已改为 sid。
  // 本断言仍然有效：/presented 这个名字虽不是根因，但改回去没有收益且会混淆，故禁止。
  const m = indexRaw.match(/const HUMAN_ENDPOINTS = \[([^\]]*)\]/)
  assert.ok(m, 'HUMAN_ENDPOINTS 存在')
  assert.ok(!m[1].includes("'/presented'"), 'HUMAN_ENDPOINTS 不得包含 /presented')
  assert.ok(m[1].includes("'/files'"), 'HUMAN_ENDPOINTS 必须包含 /files')
})
test("⑦b 【防回归】代码里不得出现 '/presented' 作为 subPath/URL（注释除外）", () => {
  // 只检查非注释行里的字符串字面量，避免误伤说明注释。
  const offenders = indexLines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(([, l]) => l.includes("'/presented'") || /\/presented\?/.test(l))
  assert.deepEqual(offenders, [], '不得再把 /presented 当路由用：' + JSON.stringify(offenders))
})

test("⑦c 【防回归】client.js 调用的清单接口是 /files 而非 /presented", () => {
  assert.ok(/base \+ '\/files\?sessionId='/.test(clientRaw), '前端必须调 /files?sessionId=（v1.0.1）')
  const bad = clientLines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(([, l]) => l.includes("'/presented?") || l.includes("'/presented'"))
  assert.deepEqual(bad, [], '前端不得再调 /presented：' + JSON.stringify(bad))
})

test('⑦d 【v1.1.0】失败日志保留请求 URL 输出（便于排查路径劫持）', () => {
  // v1.1.0：日志从 panel skip 改名 files skip（数据源统一到共享 loader）
  assert.ok(/files skip: http status=' \+ res\.status \+ ' url=' \+ url/.test(clientRaw),
    '失败日志须带 url，否则端点被劫持时无从定位')
})

// ── v1.0.1 防回归：query 参数名必须是 sessionId（`sid` 是宿主网关保留名）──
test("⑧ 【防回归】必须用 queryOf(req, 'sessionId')，不得用保留名 'sid'", () => {
  // 根因（20261022 v1.0.0 线上实测）：宿主 API 网关把 **`sid`** 当作保留参数名 ——
  // 它拿 sid 做自己的会话解析，值不认识就直接返回**空白 400**（body 空、无 content-type），
  // 请求根本到不了本插件 handler。`sessionId` 不是保留名。
  //
  // 实测对照（同一条路径只换参数名，值均为真实会话 ID）：
  //   无参数               → 400 size=56  Missing required query param: sid   ✅ 进了 handler
  //   ?sid=<真实ID>        → 400 size=0                                        ❌ 没进 handler
  //   ?sessionId=<真实ID>  → 400 size=56                                       ✅ 进了 handler
  //   ?session / ?session_id / ?id / ?q → 400 size=56                          ✅
  //
  // **决定性判据**：handler 入口加临时诊断日志，`?sid=` 时零输出（请求没进来），其它都有输出。
  //
  // 【历史更正】v1.0.0 曾判反：当时看到 `?sessionId=x → 400 size=0`，但那是 v0.12.x 时代，
  // 请求其实**进了** handler，是内部 listEvents 抛异常导致空响应。两个时期两种原因混在一起了。
  const code = codeOnly(indexRaw)
  assert.ok(/queryOf\(\s*req\s*,\s*'sessionId'\s*\)/.test(code),
    "必须使用 queryOf(req, 'sessionId')")
  assert.ok(!/queryOf\(\s*req\s*,\s*'sid'\s*\)/.test(code),
    "不得使用 queryOf(req, 'sid') —— sid 是宿主网关保留名，会被拦成空白 400")
})

test('⑧b 【防回归】client.js 调 /files 必须用 sessionId 参数', () => {
  const code = codeOnly(clientRaw)
  // 只检查我们自己的 /files 请求串（client.js 里另有官方 actionUrl 形态说明，不能误伤）。
  assert.ok(/\/files\?sessionId=/.test(code), 'client.js 必须拼 /files?sessionId=')
  assert.ok(!/\/files\?sid=/.test(code), 'client.js 不得拼 /files?sid=（宿主保留名）')
})

test('⑧c 错误文案指向 sessionId（而非 sid）', () => {
  assert.ok(indexRaw.includes('Missing required query param: sessionId'))
  assert.ok(!indexRaw.includes('Missing required query param: sid\''))
})
test('⑧d body 字段也用 sessionId（query 与 body 字段名一致，不易混淆）', () => {
  const code = codeOnly(indexRaw)
  // file-ticket 读 body.sessionId —— 这是 POST body，不是 query，无需改
  assert.ok(/body\.sessionId|const \{ sessionId, seq, index \} = body/.test(code),
    'body 仍应使用 sessionId 字段')
})

// ── v1.1.1 防回归：遮罩半透明、抽屉不透明白 ──
test('⑨ 【v1.1.1】遮罩必须用 bg-mask-*（半透明），不得用 bg-overlay', () => {
  // 用户实测：抽屉打开后整页变白。
  // 根因：--dsw-alias-bg-overlay 是「弹层**自身**的背景色」（不透明表面色，
  //       浅色主题下接近白色），拿它当遮罩 ⇒ 整页被不透明白盖住。
  // 正确：--dsw-alias-bg-mask-1（浅色 rgba(0,0,0,.24) / 深色 rgba(0,0,0,.5)）。
  const cssStart = clientLines.findIndex((l) => l.includes('v1.1.0 交付物入口：紧凑按钮'))
  const cssEnd = clientLines.findIndex((l, i) => i > cssStart && l.includes('.dsa-dl-skipped'))
  assert.ok(cssStart >= 0 && cssEnd > cssStart, '必须能定位样式区')
  const css = clientLines.slice(cssStart, cssEnd + 3).join('\n')

  const mask = css.match(/\.dsa-dl-mask\s*\{([\s\S]*?)\}/)
  assert.ok(mask, '必须有 .dsa-dl-mask 规则')
  assert.ok(/var\(--dsw-alias-bg-mask/.test(mask[1]),
    '遮罩 background 必须用 --dsw-alias-bg-mask-*（半透明）')
  assert.ok(!/--dsw-alias-bg-overlay/.test(mask[1]),
    '遮罩不得用 --dsw-alias-bg-overlay（那是不透明的弹层背景色，会导致整页变白）')
  // 兜底色必须是半透明黑（alpha < 1），不能是纯色
  const fallback = mask[1].match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\s*\)/)
  assert.ok(fallback, '遮罩必须有 rgba 半透明兜底')
  assert.ok(Number(fallback[1]) > 0 && Number(fallback[1]) < 1,
    '遮罩兜底的 alpha 必须在 (0,1) 开区间，实际 ' + fallback[1])
  // 官方约定带 blur(2px)
  assert.ok(/backdrop-filter:\s*blur\(/.test(mask[1]), '遮罩应有 backdrop-filter: blur')
})

test('⑨b 【v1.1.1】抽屉背景必须不透明（不得 transparent/none）', () => {
  const cssStart = clientLines.findIndex((l) => l.includes('v1.1.0 交付物入口：紧凑按钮'))
  const cssEnd = clientLines.findIndex((l, i) => i > cssStart && l.includes('.dsa-dl-skipped'))
  const css = clientLines.slice(cssStart, cssEnd + 3).join('\n')
  const drawer = css.match(/\.dsa-dl-drawer\s*\{([\s\S]*?)\}/)
  assert.ok(drawer, '必须有 .dsa-dl-drawer 规则')
  assert.ok(/background:/.test(drawer[1]), '抽屉必须设置 background')
  assert.ok(!/background:\s*(transparent|none)/.test(drawer[1]),
    '抽屉背景不得是 transparent/none（否则会透出下面的聊天内容）')
  // 抽屉用层表面色，不是遮罩色
  assert.ok(/var\(--dsw-alias-bg-layer-1/.test(drawer[1]),
    '抽屉应使用 --dsw-alias-bg-layer-1（层表面色）')
  assert.ok(!/--dsw-alias-bg-mask/.test(drawer[1]), '抽屉不得用遮罩色（那是半透明的）')
})

test('⑨c 【v1.1.1】遮罩与抽屉用的是**不同**的背景变量（各司其职）', () => {
  const cssStart = clientLines.findIndex((l) => l.includes('v1.1.0 交付物入口：紧凑按钮'))
  const cssEnd = clientLines.findIndex((l, i) => i > cssStart && l.includes('.dsa-dl-skipped'))
  const css = clientLines.slice(cssStart, cssEnd + 3).join('\n')
  const mask = css.match(/\.dsa-dl-mask\s*\{([\s\S]*?)\}/)[1]
  const drawer = css.match(/\.dsa-dl-drawer\s*\{([\s\S]*?)\}/)[1]
  const maskVar = (mask.match(/var\((--dsw-alias-bg-[a-z0-9-]+)/) || [])[1]
  const drawerVar = (drawer.match(/var\((--dsw-alias-bg-[a-z0-9-]+)/) || [])[1]
  assert.ok(maskVar && drawerVar, '两者都必须用主题变量')
  assert.notEqual(maskVar, drawerVar, '遮罩与抽屉不得共用同一个背景变量')
})

// ── v1.2.0 防回归：polyfill 必须在模块顶层、带守卫、不覆盖原生 ──
test('⑩ 【v1.2.0】polyfill 覆盖 5 个 API，且在 factory 顶层（早于 React require）', () => {
  for (const name of ['AbortSignal.any', 'AbortSignal.timeout', 'Promise.withResolvers',
    'Array.prototype.at', 'String.prototype.replaceAll']) {
    assert.ok(clientRaw.includes("'" + name + "'"), '缺少 polyfill：' + name)
  }
  // 必须在 factory 顶层、且早于 require('react') —— 否则官方代码可能已经跑过
  const polyAt = clientRaw.indexOf('postapiPolyfilled = []')
  const reactAt = clientRaw.indexOf("require('react')")
  assert.ok(polyAt > 0 && reactAt > 0, '两者都应存在')
  assert.ok(polyAt < reactAt, 'polyfill 必须在 require(react) 之前（要在最早时机生效）')
  // 不能出现在 apply/useEffect 里（那时官方代码可能已执行）
  const factoryAt = clientRaw.indexOf('factory: (require) =>')
  assert.ok(polyAt > factoryAt, 'polyfill 必须在 factory 内')
})

test('⑩b 【v1.2.0】每个 polyfill 都有「已存在则不覆盖」的守卫', () => {
  // 逐条检查：每种 API 的守卫写法
  const guards = [
    "if (typeof AbortSignal.any === 'function') return false",
    "if (typeof AbortSignal.timeout === 'function') return false",
    "if (typeof Promise.withResolvers === 'function') return false",
    "if (typeof Array.prototype.at === 'function') return false",
    "if (typeof String.prototype.replaceAll === 'function') return false",
  ]
  for (const g of guards) {
    assert.ok(clientRaw.includes(g), '缺少守卫：' + g)
  }
})

test('⑩c 【v1.2.0】polyfill 不得在 Node 环境炸（typeof 守卫 + try/catch 包裹）', () => {
  assert.ok(/if \(typeof AbortSignal === 'undefined'\) return false/.test(clientRaw),
    'AbortSignal 相关必须判 typeof')
  assert.ok(/function __postapiTryPolyfill/.test(clientRaw), '必须有统一 try/catch 包装器')
  assert.ok(/catch \(e\) \{[\s\S]{0,200}polyfill failed/.test(clientRaw),
    '安装失败必须被捕获并留痕，不得冒泡')
})

test('⑩d 【v1.2.0】AbortSignal.any 处理了已 aborted 入参（不能只 addEventListener）', () => {
  const body = blockOf(clientLines, (l) => l.includes("__postapiTryPolyfill('AbortSignal.any'"))
  assert.ok(body, '必须能定位 AbortSignal.any 的 polyfill')
  const code = codeOnly(body)
  assert.ok(/\.aborted/.test(code), '必须检查入参是否已 aborted')
  assert.ok(/once: true/.test(code), '监听必须用 once: true')
  assert.ok(/removeEventListener/.test(code), '必须清理监听器（防泄漏）')
  assert.ok(/reasonOf/.test(code), '必须透传 reason')
})

// ── v1.3.0 防回归：App 分发端点的安全约束 ──
test('⑪ 【v1.3.0】App 端点路径固定：不接受任何用户输入参与拼接', () => {
  // 安全要求 ①：文件名是编译期常量，只能取这两个固定名字。
  assert.ok(/const APP_APK_NAME = 'app-latest\.apk'/.test(indexRaw), 'APK 文件名必须是常量')
  assert.ok(/const APP_VERSION_NAME = 'app-version\.json'/.test(indexRaw), '版本文件名必须是常量')
  // 取文件时不得用 query/body/params 拼路径
  const body = blockOf(indexLines, (l) => l.includes('const resolveAppFile'))
  assert.ok(body, '必须能定位 resolveAppFile')
  const code = codeOnly(body)
  assert.ok(/join\(dir, name\)/.test(code), '必须用白名单文件名拼接')
  for (const bad of ['queryOf', 'req.url', 'body.', 'params']) {
    assert.ok(!code.includes(bad), 'resolveAppFile 不得接入用户输入：' + bad)
  }
})

test('⑫ 【v1.3.0】有 realpath 归属校验（防 symlink 逃逸）', () => {
  const body = blockOf(indexLines, (l) => l.includes('const resolveAppFile'))
  const code = codeOnly(body)
  assert.ok(/realpathSync\(/.test(code), '必须用 realpathSync 解析真实路径')
  assert.ok(/relative\(dirReal, real\)/.test(code), '必须用 path.relative 做归属判断')
  assert.ok(/rel\.startsWith\('..'\)/.test(code), '必须检查是否逃出目录')
  assert.ok(/isAbsolute\(rel\)/.test(code), '必须检查绝对路径情形')
  // 明确不鼓励 startsWith 前缀判断（/a/app-evil 会被误判为 /a/app 的子路径）
  assert.ok(!/real\.startsWith\(dirReal\)/.test(code), '不得用 startsWith 做归属判断')
})

test('⑬ 【v1.3.0】Range 复用 parseRangeHeader（不另写一套）', () => {
  const body = blockOf(indexLines, (l) => l.includes('const handleAppApk'))
  assert.ok(body, '必须能定位 handleAppApk')
  const code = codeOnly(body)
  assert.ok(/parseRangeHeader\(/.test(code), '必须复用 parseRangeHeader')
  assert.ok(/206/.test(code), '必须支持 206 Partial Content')
  assert.ok(/content-range/.test(code), '必须返回 Content-Range')
  assert.ok(/416/.test(code), 'Range 不可满足时须返回 416')
  // 不得在 handleAppApk 里自造 Range 解析
  assert.ok(!/bytes=\\\(\\d/.test(code), '不得自行解析 Range 字符串')
})

test('⑭ 【v1.3.0】未配置分发时返回 503（fail-closed），不是空 200', () => {
  const body = blockOf(indexLines, (l) => l.includes('const handleAppVersion'))
  assert.ok(body, '必须能定位 handleAppVersion')
  const code = codeOnly(body)
  assert.ok(/503/.test(code), '必须返回 503')
  assert.ok(/app distribution not configured/.test(code), '必须有明确文案')
  // 关键反证：不得在文件缺失时返回 200 + 空对象
  assert.ok(!/sendJson\(res, 200, \{ ok: true, version: null/.test(code))
})

test('⑮ 【v1.3.0】APK 大小上限：stat 后再决定是否读（超限 413）', () => {
  const body = blockOf(indexLines, (l) => l.includes('const resolveAppFile'))
  const code = codeOnly(body)
  assert.ok(/st\.size > maxBytes/.test(code), '必须比较大小')
  assert.ok(/413/.test(code), '超限须返回 413')
  // 上限必须在 stat 之后、createReadStream 之前判断
  const apkBody = codeOnly(blockOf(indexLines, (l) => l.includes('const handleAppApk')))
  assert.ok(/createReadStream/.test(apkBody), 'APK 必须流式返回（不整份读进内存）')
})

test('⑯ 【v1.3.0】两个 App 端点属人类通道（不要求 Bearer）', () => {
  assert.ok(/const APP_ENDPOINTS = \['\/app-version', '\/app-latest\.apk'\]/.test(indexRaw),
    '必须把两个端点列为人类通道')
  assert.ok(/HUMAN_ENDPOINTS = \['\/file-ticket', '\/files', \.\.\.APP_ENDPOINTS\]/.test(indexRaw),
    '必须并入 HUMAN_ENDPOINTS')
})

test('⑰ 【v1.3.0】读文件用 _readFileSync 别名（本文件导入即是别名）', () => {
  // v1.3.0 实现时踩过：直接写 readFileSync 会 ReferenceError（导入名是 readFileSync as _readFileSync），
  // 表现为运行时 503 'app version unreadable'。这条断言防止再犯。
  assert.ok(/_readFileSync\(/.test(indexRaw), '必须使用 _readFileSync 别名')
  const naked = indexLines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /[^_\w]readFileSync\(/.test(l))
  assert.deepEqual(naked, [], '不得直接调用 readFileSync（未导入）：' + JSON.stringify(naked))
})
