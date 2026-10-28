// v0.10.0 交付物卡片「下载」按钮 —— actionUrl 解析纯函数单测（不启动服务、不碰 DOM）
//
// 被测代码 = lib/client.js 里的真实实现（经 test/client-bundle-loader.mjs 求值），
// 不是复制品 —— 见该 loader 文件头的方案取舍说明。
import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadButtonHelpers } from './client-bundle-loader.mjs'

const { parsePresentedActionUrl, downloadErrorMessage } = downloadButtonHelpers

const ORIGIN = 'http://localhost:3080'

test('① 正常形态 → { sessionId, seq, index } 正确', () => {
  assert.deepEqual(
    parsePresentedActionUrl('present/open?sessionId=abc123&seq=7&index=0', ORIGIN),
    { sessionId: 'abc123', seq: 7, index: 0 },
  )
  // 官方 presentedFileUrl() 用 URLSearchParams 拼，参数顺序固定为 sessionId/seq/index
  assert.deepEqual(
    parsePresentedActionUrl('present/open?sessionId=sess-有中文&seq=12&index=3', ORIGIN),
    { sessionId: 'sess-有中文', seq: 12, index: 3 },
  )
  // 带前导斜杠的绝对路径形态也应接受（URL 规范化后 pathname 一致）
  assert.deepEqual(
    parsePresentedActionUrl('/present/open?sessionId=x&seq=0&index=0', ORIGIN),
    { sessionId: 'x', seq: 0, index: 0 },
  )
  // 同名 sessionId 含特殊字符（URLSearchParams 会编码，get 时解码）
  assert.deepEqual(
    parsePresentedActionUrl('present/open?sessionId=a%2Fb&seq=1&index=2', ORIGIN),
    { sessionId: 'a/b', seq: 1, index: 2 },
  )
})

test('② 解析失败 → 返回 null 且不抛（缺参数 / 非法 seq / 空串 等）', () => {
  const bad = [
    '',                                  // 空串
    'present/open',                      // 无查询串
    'present/open?sessionId=abc',        // 缺 seq / index
    'present/open?seq=1&index=0',        // 缺 sessionId
    'present/open?sessionId=&seq=1&index=0', // sessionId 空
    'present/open?sessionId=a&seq=&index=0', // seq 空
    'present/open?sessionId=a&seq=1.5&index=0', // 非整数
    'present/open?sessionId=a&seq=-1&index=0',  // 负数
    'present/open?sessionId=a&seq=1&index=-2',  // 负数
    'present/open?sessionId=a&seq=1e3&index=0', // 科学计数
    'present/open?sessionId=a&seq=0x10&index=0',// 十六进制
    'present/open?sessionId=a&seq=%201&index=0',// 前导空格
    'present/open?sessionId=a&seq=1abc&index=0',// 尾随字符
    'present/open?sessionId=a&seq=+1&index=0',  // 带符号
    'present/open?sessionId=a&seq=99999999999999999999&index=0', // 超安全整数
    'some/other/path?sessionId=a&seq=1&index=0', // 路径不符（官方改了 URL 形态）
    'https://evil.example.com/present/open?sessionId=a&seq=1&index=0', // 跨来源
    'javascript:alert(1)',               // 非法协议
    'present/open?sessionId=a&seq=1&index=0%00', // 非法百分号编码 → URL 抛错
  ]
  for (const value of bad) {
    let result
    assert.doesNotThrow(() => { result = parsePresentedActionUrl(value, ORIGIN) }, JSON.stringify(value))
    assert.equal(result, null, '应返回 null: ' + JSON.stringify(value))
  }
})

test('②b 非字符串输入也一律 null（不抛）', () => {
  for (const value of [undefined, null, 0, false, {}, [], () => {}]) {
    let result
    assert.doesNotThrow(() => { result = parsePresentedActionUrl(value, ORIGIN) })
    assert.equal(result, null, String(typeof value))
  }
})

test('②c 无 origin 基准且无 location（纯 node 环境）→ 返回 null 而非抛错', () => {
  // 不传第二个参数，且测试环境里没有 location
  assert.equal(typeof globalThis.location, 'undefined', '前提：node 里没有 location')
  assert.equal(parsePresentedActionUrl('present/open?sessionId=a&seq=1&index=0'), null)
})

test('②d 解析是纯函数：重复调用结果稳定，不修改入参', () => {
  const url = 'present/open?sessionId=a&seq=1&index=2'
  const first = parsePresentedActionUrl(url, ORIGIN)
  const second = parsePresentedActionUrl(url, ORIGIN)
  assert.deepEqual(first, second)
  assert.notEqual(first, second, '每次返回新对象（调用方可以安全修改）')
  assert.equal(url, 'present/open?sessionId=a&seq=1&index=2', '入参未被修改')
})

test('③ 边界值：seq/index 为 0 与 MAX_SAFE_INTEGER 均可接受', () => {
  assert.deepEqual(
    parsePresentedActionUrl('present/open?sessionId=a&seq=0&index=0', ORIGIN),
    { sessionId: 'a', seq: 0, index: 0 },
  )
  const max = String(Number.MAX_SAFE_INTEGER)
  assert.deepEqual(
    parsePresentedActionUrl('present/open?sessionId=a&seq=' + max + '&index=' + max, ORIGIN),
    { sessionId: 'a', seq: Number.MAX_SAFE_INTEGER, index: Number.MAX_SAFE_INTEGER },
  )
})

test('④ 错误文案映射（401/403 → 请先登录；410 → 过期；503 → 不可用）', () => {
  assert.equal(downloadErrorMessage(401), '请先登录')
  assert.equal(downloadErrorMessage(403), '请先登录')
  assert.equal(downloadErrorMessage(410), '链接已过期，请重新打开')
  assert.equal(downloadErrorMessage(503), '下载服务不可用')
  assert.equal(downloadErrorMessage(413), '文件超出下载上限')
  // 未知状态码有兜底，绝不返回 undefined（否则按钮会显示空白）
  for (const status of [0, 400, 404, 418, 500, 502, undefined]) {
    const text = downloadErrorMessage(status)
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0, String(status))
  }
  assert.equal(downloadErrorMessage(500), '下载失败')
})
