// v0.8.0 端到端自测（一次性）：桩 ctx + 真实 HTTP，不触碰 3080 上的 dsh-web。
// 运行：node test/_e2e-mobile-login.mjs
// 断言覆盖：白名单分流（apiToken 缺失仍可达）、400/401/503/429、成功体结构、
//           会话落库、GET 同名路径不被放行、日志不含密码。
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { createHmac } from 'node:crypto'

// 与 lib/index.js 的 verifySignedSessionId 同一算法（该函数未对外导出，故此处复刻）。
// 之所以能复刻：格式固定为 <sid>.<hmac_sha256_hex>，secret 为脚本自造。
function verifySignedSessionId (signed, secret) {
  if (typeof signed !== 'string') return undefined
  const dot = signed.lastIndexOf('.')
  if (dot === -1) return undefined
  const sid = signed.slice(0, dot)
  const hmac = signed.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(sid).digest('hex')
  if (hmac.length !== expected.length) return undefined
  return hmac === expected ? sid : undefined
}

process.env.DSH_HOME = '/tmp/postapi-e2e-dshhome-' + Date.now()

const { UsersStore } = await import('../lib/users-store.js')
// 造测试账号：密码走环境变量，缺省用一次性随机值（不写任何明文到仓库）
const TEST_USER = 'e2e_user_' + Date.now().toString(36)
const TEST_PASS = process.env.E2E_TEST_PASSWORD || ('P' + Math.random().toString(36).slice(2) + '!' + Date.now())
const usersStore = new UsersStore()
usersStore.create({ username: TEST_USER, password: TEST_PASS, role: 'user' })

// ---- 桩 ctx ----
const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  settings: { get: () => undefined },
  effect (fn) { fn() },
  provide () {},
  on () { return () => {} },
  agents: {},
  webServer: {
    tapIndex: () => () => {},
    register ({ kind, path, handler }) { routes.push({ kind, path, handler }); return () => {} },
  },
}
// 注意：apiToken 故意留空 —— 验证 /mobile-login 在「机器通道整体 fail-fast」之前被分流
const E2E_SECRET = 'e2e-secret-' + Date.now()   // 仅本进程内存，不落盘、不读生产
apply(ctx, { sessionSecret: E2E_SECRET, apiToken: '', accessLogDir: process.env.DSH_HOME + '/audit' })

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  for (const r of routes) {
    if (r.kind === 'exact' && p === r.path) return r.handler(req, res)
    if (r.kind === 'prefix' && req.url.startsWith(r.path)) return r.handler(req, res)
    if (r.kind === 'exact' && req.url === r.path) return r.handler(req, res)
  }
  res.writeHead(404).end('no route')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = 'http://127.0.0.1:' + PORT

function req (method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request(BASE + path, {
      method,
      headers: {
        'user-agent': 'DSH-PostAPI-Android/0.8 (test)',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }))
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

let pass = 0, fail = 0
function check (name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name) }
  else { fail++; console.log('  ✖ ' + name + (detail ? '  → ' + detail : '')) }
}

console.log('== A. 分流与字段校验 ==')
{
  const r = await req('GET', '/api/dsh/v1/mobile-login')
  // ⚠️ 审查 T5 修复：原断言是 `503 || 401 || 405`，等于「不是 200 就算过」，没意义。
  // 本测试桩 ctx 的 apiToken 为空 → GET 落到机器通道 fail-fast，**确定是 503**。
  check('GET /mobile-login 不放行（非 POST 落到机器通道 fail-fast = 503）', r.status === 503,
    'status=' + r.status + ' body=' + r.body)
}
{
  const r = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER })
  check('缺 password → 400', r.status === 400 && JSON.parse(r.body).error === 'Missing required string field: password', r.body)
}
{
  const r = await req('POST', '/api/dsh/v1/mobile-login', { password: TEST_PASS })
  check('缺 username → 400', r.status === 400 && JSON.parse(r.body).error === 'Missing required string field: username', r.body)
}
{
  // 注意：apiToken 为空时，其它机器方法仍应 503（证明只放行 /mobile-login）
  const r = await req('POST', '/api/dsh/v1/task', { prompt: 'x' })
  check('同前缀其它方法仍 fail-closed（503）', r.status === 503, 'status=' + r.status)
}
{
  const r = await req('POST', '/api/dsh/v1/health', {})
  // 同上：POST /health 不是 GET 白名单 → 同样落到 fail-fast 503（确定值）。
  check('POST /health 落到 fail-fast = 503', r.status === 503, 'status=' + r.status)
}

console.log('== B. 凭据失败统一 401（不区分原因） ==')
{
  const r1 = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER, password: 'wrong-password' })
  const r2 = await req('POST', '/api/dsh/v1/mobile-login', { username: 'no_such_user_xyz', password: 'whatever' })
  check('密码错 → 401 Invalid credentials', r1.status === 401 && JSON.parse(r1.body).error === 'Invalid credentials', r1.body)
  check('用户不存在 → 401 同一响应（防枚举）', r2.status === 401 && r2.body === r1.body, r2.body)
}

console.log('== C. 限流（复用 stepupFails，5 次失败锁 10 分钟） ==')
{
  // B 段已在本机 IP 上失败 2 次，再失败 3 次即达 5 次阈值（阈值语义：第 5 次触发锁定）
  let last
  for (let i = 0; i < 3; i++) {
    last = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER, password: 'wrong-' + i })
  }
  check('第 5 次失败仍返回 401', last.status === 401, last.body)
  const r = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER, password: TEST_PASS })
  check('锁定期内即使密码正确 → 429', r.status === 429 && JSON.parse(r.body).error === 'too many attempts, try later', r.status + ' ' + r.body)
  const r2 = await req('POST', '/api/dsh/v1/mobile-login', { username: 'no_such_user_xyz', password: 'x' })
  check('锁定期内连不存在的用户也是 429（不泄露账号是否存在）', r2.status === 429, r2.status + ' ' + r2.body)
}

console.log('== D. 非法 host/scheme（防注入到 launchUrl） ==')
{
  // 换个 IP 维度绕开上一步的锁定：改用另一种 XFF 末跳，模拟另一台客户端。
  // 说明：这是测试手法（stepupFails 以 bindIpOf 为键），生产里同 IP 仍会被锁。
  const H = { 'x-forwarded-for': '203.0.113.9' }
  for (const bad of ['evil.com/../x', 'http://evil.com', 'user@evil.com', 'a b', '']) {
    const r = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER, password: TEST_PASS, host: bad }, H)
    if (bad === '') continue // 空 host 走回退链，不算非法
    check('非法 host 被拒: ' + JSON.stringify(bad), r.status === 400 && JSON.parse(r.body).error === 'Invalid field: host', r.status + ' ' + r.body)
  }
  const r = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER, password: TEST_PASS, scheme: 'file' }, H)
  check('非法 scheme 被拒', r.status === 400 && JSON.parse(r.body).error === 'Invalid field: scheme', r.status + ' ' + r.body)
}

console.log('== E. 成功路径（另一 IP 维度） ==')
let okBody
{
  const H = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }
  const r = await req('POST', '/api/dsh/v1/mobile-login', { username: TEST_USER, password: TEST_PASS, host: 'dsh.example.com:53080' }, H)
  okBody = r.status === 200 ? JSON.parse(r.body) : null
  check('200 且 ok=true', r.status === 200 && okBody?.ok === true, r.status + ' ' + r.body)
  if (okBody) {
    check('username/role 正确', okBody.username === TEST_USER && okBody.role === 'user', JSON.stringify(okBody))
    check('launchUrl = scheme://host/?token=xxx', /^https:\/\/dsh\.example\.com:53080\/\?token=[A-Za-z0-9_-]+$/.test(okBody.launchUrl), okBody.launchUrl)
    check('sessionCookie 名字/值格式正确', okBody.sessionCookie?.name === 'dsh_postapi_session' && /^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(okBody.sessionCookie?.value), JSON.stringify(okBody.sessionCookie))
    check('maxAgeSeconds 为正整数', Number.isInteger(okBody.sessionCookie.maxAgeSeconds) && okBody.sessionCookie.maxAgeSeconds > 0, String(okBody.sessionCookie?.maxAgeSeconds))
    check('expiresAt 在未来', okBody.expiresAt > Date.now(), String(okBody.expiresAt))
    check('响应体不含密码', !r.body.includes(TEST_PASS), 'leak!')
  }
}

console.log('== F. 会话确实已落库且与 cookie 值对应（从 cookie 值反查 sid） ==')
{
  const { SessionsStore } = await import('../lib/users-store.js')
  // 用**本脚本自己创建的 ctx secret** 验签，不读生产凭据
  const sid = verifySignedSessionId(okBody?.sessionCookie?.value, E2E_SECRET)
  check('cookie 值可被同一 secret 验签出 sid', typeof sid === 'string' && sid.length > 0, 'sid=' + sid)
  const s = sid ? new SessionsStore().get(sid) : undefined
  check('sessions.json 中存在该 sid', !!s, 'sid=' + sid)
  if (s && okBody) {
    check('会话 username/role 正确', s.username === TEST_USER && s.role === 'user', JSON.stringify(s))
    check('已绑定 ipPrefix', typeof s.bindIpPrefix === 'string' && s.bindIpPrefix.length > 0, JSON.stringify(s.bindIpPrefix))
    check('expiresAt 与响应一致', Math.abs(s.expiresAt - okBody.expiresAt) < 5000, s.expiresAt + ' vs ' + okBody.expiresAt)
  }
  // 反例：换一个 secret 必须验不过（证明签名真的绑定了 secret）
  check('错误 secret 验不出 sid', verifySignedSessionId(okBody?.sessionCookie?.value, 'other-secret') === undefined)
}
console.log('== G. 审计日志 ==')
{
  const auditDir = process.env.DSH_HOME + '/audit'
  const file = join(auditDir, 'access-log.jsonl')
  const text = readFileSync(file, 'utf8')
  for (const ev of ['mobile-login-failed', 'mobile-login-throttled', 'mobile-login-ok']) {
    check('记录事件 ' + ev, text.includes('"event":"' + ev + '"'))
  }
  check('日志不含密码明文', !text.includes(TEST_PASS))
  check('日志不含 sessionCookie 值', okBody ? !text.includes(okBody.sessionCookie.value.split('.')[1]) : true)
}

server.close()
console.log('\n结果: pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
