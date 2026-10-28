// v0.9.0 静态断言：下载路由的位置与实现约束（纯文本检查，不启动服务）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const src = raw.split('\n')
const lineNo = (pred) => {
  const i = src.findIndex(pred)
  return i === -1 ? -1 : i + 1
}

test('v0.12.1：下载路由属人类通道，走 cookie 鉴权且早于机器通道判定', () => {
  // 设计变更说明（v0.12.1）：下载不再要求 Bearer —— 浏览器点下载是同源 GET + 会话 cookie。
  // 因此它现在位于「人类通道分流」内，**早于** if (!isLoopback) 机器通道判定。
  const human = lineNo((l) => l.includes('const isHumanEndpoint = HUMAN_ENDPOINTS.includes(subPath)'))
  const bearer = lineNo((l) => l.startsWith('    if (!isLoopback) {'))
  const dl = lineNo((l) => l.includes("const isFileDownload = req.method === 'GET' && subPath.startsWith('/file/')"))
  const guard = lineNo((l) => l.trim().startsWith("if (req.method !== 'POST')"))
  assert.ok(human > 0 && bearer > 0 && dl > 0 && guard > 0)
  assert.ok(dl === human - 1 || dl < human, '下载判定须在人类通道分流之前紧邻声明')
  assert.ok(human < bearer, '人类通道分流(' + human + ') 必须在机器通道判定(' + bearer + ') 之前')
  assert.ok(human < guard, '且必须在 405 守卫(' + guard + ') 之前')
})

test('v0.12.1：file-ticket 属人类通道，走 cookie 鉴权', () => {
  const human = lineNo((l) => l.includes('const isHumanEndpoint = HUMAN_ENDPOINTS.includes(subPath)'))
  const bearer = lineNo((l) => l.startsWith('    if (!isLoopback) {'))
  // v1.3.0：HUMAN_ENDPOINTS 改为 ['/file-ticket', '/files', ...APP_ENDPOINTS]，
  // 精确字面量断言会误伤，改为按成员判断。
  const m = raw.match(/const HUMAN_ENDPOINTS = \[([^\]]*)\]/)
  assert.ok(m, 'HUMAN_ENDPOINTS 必须存在')
  assert.ok(m[1].includes("'/file-ticket'"), '必须含 /file-ticket')
  assert.ok(m[1].includes("'/files'"), 'v0.12.3：/presented 已改名 /files')
  assert.ok(human < bearer, 'file-ticket 分流必须在机器通道判定之前')
})
test('禁止 readFileSync 下发文件内容（必须流式）', () => {
  const handlerStart = src.findIndex((l) => l.includes('const handleFileDownload'))
  const handlerEnd = src.findIndex((l, i) => i > handlerStart && l === '  }')
  const body = src.slice(handlerStart, handlerEnd).join('\n')
  assert.ok(!/readFileSync/.test(body), '下载处理器内不得出现 readFileSync')
  assert.ok(/createReadStream/.test(body), '必须使用 createReadStream')
  assert.ok(/\.pipe\(res\)/.test(body), '必须 pipe 到响应')
})

test('realpath 校验存在且未被 startsWith 替代', () => {
  const start = src.findIndex((l) => l.includes('const resolveSafeFilePath'))
  const end = src.findIndex((l, i) => i > start && l === '  }')
  const body = src.slice(start, end).join('\n')
  assert.ok(/isRealpathInside\(/.test(body), '必须调用 isRealpathInside')
  assert.ok(!/startsWith\(/.test(body), '归属判断不得使用 startsWith')
  const helperStart = src.findIndex((l) => l.includes('function isRealpathInside'))
  const helperBody = src.slice(helperStart, helperStart + 15).join('\n')
  assert.ok(/realpathSync\(childPath\)/.test(helperBody))
  assert.ok(/realpathSync\(parentPath\)/.test(helperBody))
  assert.ok(/relative\(parentReal, childReal\)/.test(helperBody))
})

test('时效锚点：48h 从 issuedAt、5h 从 activatedAt（均非 present 事件 time）', () => {
  assert.ok(/FILE_TICKET_DEFAULT_ACTIVATE_HOURS = 48/.test(raw))
  assert.ok(/FILE_TICKET_DEFAULT_SESSION_HOURS = 5/.test(raw))
  assert.ok(/issuedAt \+ ah \* 3600 \* 1000/.test(raw), '待激活上限基于 issuedAt')
  assert.ok(/activatedAt \+ sh \* 3600 \* 1000/.test(raw), '激活窗口基于 activatedAt')
  // token 载荷不得含 exp（时效必须查服务端状态）
  assert.ok(!/payload\.exp|uid: session\.username, exp/.test(raw))
})

test('消费语义已移除（无 bytesServed / consumed / 区间并集）', () => {
  for (const gone of ['bytesServed', 'consumed', 'mergeByteRanges', 'coversWholeFile']) {
    assert.ok(!raw.includes(gone), gone + ' 应已删除（最终规则为 5h 内不限次数）')
  }
})

test('审计事件齐全；下载审计落在 finish/close，且不记 token', () => {
  for (const ev of ['file-ticket-issued', 'file-ticket-activated', 'file-download', 'file-download-denied']) {
    assert.ok(raw.includes(ev), ev)
  }
  assert.ok(/res\.on\('finish'/.test(raw) && /res\.on\('close'/.test(raw))
  const start = src.findIndex((l) => l.includes('const handleFileTicket'))
  const end = src.findIndex((l, i) => i > start && l === '  }')
  const body = src.slice(start, end).join('\n')
  assert.ok(!/token: signed\.token/.test(body), '审计不得记录 token')
})

test('清理只删票据、不碰源文件（无 unlink / rmSync / rmdir）', () => {
  assert.ok(/cleanup\(/.test(raw))
  const storeStart = src.findIndex((l) => l.includes('class FileTicketStore'))
  const storeEnd = src.findIndex((l, i) => i > storeStart && l === '}')
  const body = src.slice(storeStart, storeEnd).join('\n')
  assert.ok(body.length > 0)
  for (const danger of ['unlinkSync', 'unlink(', 'rmSync', 'rmdirSync']) {
    assert.ok(!body.includes(danger), '票据库不得删文件：' + danger)
  }
  const dlStart = src.findIndex((l) => l.includes('const handleFileDownload'))
  const dlEnd = src.findIndex((l, i) => i > dlStart && l === '  }')
  const dlBody = src.slice(dlStart, dlEnd).join('\n')
  for (const danger of ['unlinkSync', 'unlink(', 'rmSync', 'rmdirSync']) {
    assert.ok(!dlBody.includes(danger), '下载/过期路径不得删文件：' + danger)
  }
})

test('下载必须声明 Accept-Ranges 与 RFC5987 disposition', () => {
  assert.ok(/'accept-ranges': 'bytes'/.test(raw))
  assert.ok(/filename\*=UTF-8''/.test(raw))
  assert.ok(/rfc5987Encode\(filename\)/.test(raw))
})

test('AUDIT_VERSION 与 package.json 一致', () => {
  const m = raw.match(/const AUDIT_VERSION = '([^']+)'/)
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(m[1], pkg.version)
})
