// v1.4.0 改坏验证（变异测试）：故意去掉关键防护，确认测试**必须变红**。
//
// 为什么单独留一个脚本：这几条是本功能的**硬边界**（脱敏 / 大小 / 限频 / 文件名唯一性）。
// 只要有一条可以通过，就说明对应的测试是假绿 —— 而假绿比没有测试更危险。
// 用法：node test/_mutation-check.mjs
//   （备份 → 改坏 → 跑测试 → 恢复，全程只在内存与临时备份间来去，不改仓库内容）
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'


// ⚠️ **本文件会临时改写 lib/index.js**，因此绝不能与其它测试并行跑（会互相干扰，
//    表现为"变异没被捕获"的假失败）。`node --test test/*.mjs` 会把本文件当测试加载，
//    这里显式跳过 —— 改坏验证必须**单独**执行：
//      node test/_mutation-check.mjs
//    若上次被中断而留下 .mutbak，本脚本开头会先自动恢复，避免仓库停在"被改坏"状态。
const invokedDirectly = !process.env.NODE_TEST_CONTEXT
if (!invokedDirectly) {
  console.log('[skip] _mutation-check 会改写 lib/index.js，必须单独运行：node test/_mutation-check.mjs')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const indexFile = join(root, 'lib', 'index.js')
const backup = join(root, 'lib', 'index.js.mutbak')

const TESTS = ['test/_e2e-client-log.mjs', 'test/client-log-static.mjs', 'test/client-log-naming.mjs']

const MUTATIONS = [
  {
    name: '去掉脱敏（msg/ua/extra 原样落盘）',
    apply (src) {
      let s = src.replace("msg: typeof item.msg === 'string' ? sanitizeClientLogString(item.msg, 2000) : null,",
                          "msg: typeof item.msg === 'string' ? item.msg : null,")
      s = s.replace("ua: sanitizeClientLogString(raw.ua, 400),", "ua: typeof raw.ua === 'string' ? raw.ua : '',")
      s = s.replace('if (item.extra !== undefined) out.extra = redactClientLogValue(item.extra, 0)',
                    'if (item.extra !== undefined) out.extra = item.extra')
      return s
    },
  },
  {
    name: '去掉大小限制（上限放大到 64MB）',
    apply (src) {
      return src.replace('rawText = await readBody(req, CLIENT_LOG_MAX_BODY_BYTES)', 'rawText = await readBody(req, 64 * 1024 * 1024)')
    },
  },
  {
    // v1.4.1 核心回归的"改坏验证"：把随机后缀换成固定串，
    // 等价于回到"时间戳是唯一区分量"—— 同一毫秒内并发立刻撞名、互相覆盖。
    // 期望：client-log-naming.mjs 的并发用例 + 冻结时钟用例双双变红。
    name: '去掉文件名随机后缀（退回时间戳唯一）',
    apply (src) {
      return src.replace("  const rand = randomBytes(8).toString('hex')\n  return stamp + '-' + rand + '.json'",
                         "  const rand = 'deadbeefdeadbeef'\n  return stamp + '-' + rand + '.json'")
    },
  },
  {
    name: '去掉限频（永不拒绝）',
    apply (src) {
      return src.replace(
        '  if (rec.count >= CLIENT_LOG_RATE_LIMIT) {\n    return { allowed: false, used: rec.count, resetAt: rec.resetAt }\n  }',
        '  // 限流被移除（变异测试）')
    },
  },
]

// 上次被中断时留下的备份：先恢复，保证仓库不停在「被改坏」状态
if (existsSync(backup)) {
  copyFileSync(backup, indexFile)
  unlinkSync(backup)
  console.log('[restore] 发现残留 .mutbak，已先恢复 lib/index.js')
}
const original = readFileSync(indexFile, 'utf8')
copyFileSync(indexFile, backup)
let allDetected = true
console.log('== 改坏验证（每个变异都必须让测试变红）==')
for (const m of MUTATIONS) {
  const mutated = m.apply(original)
  if (mutated === original) {
    console.log('  ✖ ' + m.name + ' —— 变异没生效（替换目标没命中），本项不算验证')
    allDetected = false
    continue
  }
  writeFileSync(indexFile, mutated, 'utf8')
  let failed = false
  let firstFail = ''
  try {
    execFileSync('node', ['--test', ...TESTS], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    failed = true
    const out = (e.stdout || '') + (e.stderr || '')
    const hit = out.split('\n').find((l) => l.startsWith('✖') && !l.includes('failing tests'))
    firstFail = hit ? hit.trim() : '(见完整输出)'
  } finally {
    writeFileSync(indexFile, original, 'utf8')
  }
  console.log((failed ? '  ✔ 已捕获: ' : '  ✖ 未捕获（测试有洞！）: ') + m.name)
  if (failed && firstFail) console.log('      首条失败 → ' + firstFail)
  if (!failed) allDetected = false
}
try { if (existsSync(backup)) unlinkSync(backup) } catch (e) {}
console.log('')
console.log(allDetected ? '结果: ' + MUTATIONS.length + ' 个变异全部被测试捕获（无假绿）' : '结果: 存在未被捕获的变异 —— 测试有洞，必须补')
process.exit(allDetected ? 0 : 1)
