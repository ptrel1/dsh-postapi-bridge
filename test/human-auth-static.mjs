// v0.12.1 静态断言：人类通道分流位置与语义
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const src = raw.split('\n')
const lineNo = (pred) => { const i = src.findIndex(pred); return i === -1 ? -1 : i + 1 }

const HUMAN = lineNo((l) => l.includes("const isHumanEndpoint = HUMAN_ENDPOINTS.includes(subPath)"))
const API_TOKEN = lineNo((l) => l.trim() === 'if (!apiToken) {' && l.startsWith('    if'))
const LOOPBACK = lineNo((l) => l.startsWith('    if (!isLoopback) {'))
const HEALTH = lineNo((l) => l.includes("const isHealth = req.method === 'GET'"))
const GUARD405 = lineNo((l) => l.trim().startsWith("if (req.method !== 'POST')"))

test('① 人类通道分流早于 if (!apiToken)', () => {
  assert.ok(HUMAN > 0 && API_TOKEN > 0)
  assert.ok(HUMAN < API_TOKEN, '分流(' + HUMAN + ') 必须早于 apiToken fail-fast(' + API_TOKEN + ')')
})

test('② 人类通道分流早于 if (!isLoopback)', () => {
  assert.ok(HUMAN < LOOPBACK, '分流(' + HUMAN + ') 必须早于 isLoopback(' + LOOPBACK + ')')
})

test('③ 分流行号 < health < 405 守卫（整体顺序正确）', () => {
  assert.ok(HUMAN < HEALTH, 'HUMAN(' + HUMAN + ') < HEALTH(' + HEALTH + ')')
  assert.ok(HUMAN < GUARD405, 'HUMAN(' + HUMAN + ') < 405(' + GUARD405 + ')')
})

test('④ /task 仍在机器通道分支内（未被误列入人类通道）', () => {
  const at = lineNo((l) => l.includes("if (subPath === '/task')"))
  assert.ok(at > 0, '/task 分支存在')
  assert.ok(at > LOOPBACK, '/task(' + at + ') 必须在机器通道判定(' + LOOPBACK + ') 之后')
  assert.ok(!/HUMAN_ENDPOINTS = \[[^\]]*'\/task'/.test(raw), '人类通道不得包含 /task')
})

test('⑤ 人类通道端点集合 = file-ticket / presented / file download', () => {
  const m = raw.match(/const HUMAN_ENDPOINTS = \[([^\]]*)\]/)
  assert.ok(m, 'HUMAN_ENDPOINTS 存在')
  assert.ok(m[1].includes("'/file-ticket'"), '须含 /file-ticket')
  assert.ok(m[1].includes("'/files'"), "须含 /files（v0.12.3 由 /presented 改名，避免宿主路由劫持）")
  assert.ok(raw.includes("const isFileDownload = req.method === 'GET' && subPath.startsWith('/file/')"),
    '/file/<token> 下载也须纳入人类通道')
  assert.ok(/const isHumanEndpoint = HUMAN_ENDPOINTS\.includes\(subPath\) \|\| isFileDownload/.test(raw))
})

test('⑥ handler 不重复做 findSessionVerified（避免二次指纹计数）', () => {
  // 约定：每个 handler 里 findSessionVerified 只允许出现**一次**，且形式必须是
  //   `verifiedSession || findSessionVerified(req)`
  // 出现两次 = 二次指纹比对，会让 mismatch 计数翻倍（3 次即吊销会话）。
  for (const name of ['handlePresentedList', 'handleFileTicket', 'handleFileDownload']) {
    const at = src.findIndex((l) => l.includes('const ' + name + ' ='))
    assert.ok(at >= 0, name + ' 存在')
    // 取到函数结束：找下一个同级缩进（两空格 + `}`）
    let end = at + 1
    for (let i = at + 1; i < src.length; i++) {
      if (src[i] === '  }') { end = i; break }
    }
    const body = src.slice(at, end).join('\n')
    const hits = body.split('findSessionVerified(req)').length - 1
    assert.equal(hits, 1, name + ' 内 findSessionVerified 应恰好出现 1 次，实际 ' + hits)
    assert.ok(/verifiedSession \|\| findSessionVerified\(req\)/.test(body),
      name + ' 必须先复用传入的 session，仅在缺省时自查')
  }
})
test('⑦ 三个 handler 都接收 verifiedSession 参数', () => {
  assert.ok(/const handlePresentedList = async \(req, res, sendJson, verifiedSession\)/.test(raw))
  assert.ok(/const handleFileTicket = async \(req, res, sendJson, body, verifiedSession\)/.test(raw))
  assert.ok(/const handleFileDownload = async \(req, res, token, verifiedSession\)/.test(raw))
})

test('⑧ 分流内自行解析 body（不得引用统一解析的 body，否则 TDZ）', () => {
  const body = src.slice(HUMAN - 1, HUMAN + 60).join('\n')
  assert.ok(/await readJson\(req, 4096\)/.test(body), '分流内须自行 readJson')
  assert.ok(!/handleFileTicket\(req, res, sendJson, body,/.test(body),
    '不得把外层的 body 传给 handleFileTicket（此时尚未声明）')
  assert.ok(/handleFileTicket\(req, res, sendJson, ticketBody,/.test(body), '须传 ticketBody')
})

test('⑨ /file/<token> 与 /dl/<token> 都不提供回环 token 兜底', () => {
  // v1.5.0：直链下载（/dl/<token>）同样绑真实 uid，用一个伪身份（回环 Bearer）去下载
  // 既无意义（票里 uid 必对不上）又扩大了鉴权面。故兜底条件同时排除两条下载路径。
  assert.ok(/!humanSession && !isFileDownload && !isDirectDownload && isLoopback && apiToken/.test(raw),
    '下载路径（/file 与 /dl）必须排除在 token 兜底之外')
  assert.ok(/const isDirectDownload = req\.method === 'GET' && subPath\.startsWith\('\/dl\/'\)/.test(raw),
    '/dl/ 必须被识别为独立的人类通道子路径')
})

test('⑩ 无凭据时记录 human-endpoint-denied 审计', () => {
  assert.ok(raw.includes("'human-endpoint-denied'"))
  const at = lineNo((l) => l.includes("event: 'human-endpoint-denied'"))
  const body = src.slice(at - 4, at + 8).join('\n')
  assert.ok(!/cookie/i.test(body), '审计不得记录 cookie')
})

test('⑪ 版本同步（不写死版本号）', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const m = raw.match(/const AUDIT_VERSION = '([^']+)'/)
  assert.equal(m[1], pkg.version)
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
})
