// v1.5.0 改坏验证（变异测试）：故意去掉关键防护/改写实现，确认测试**必须变红**。
//
// 为什么单独留一个脚本：这三条是本功能的硬边界 ——
//   ① 时效检查（用户原话要的就是「下载地址时效」）
//   ② uid 校验（地址是 bearer 式 URL，会进剪贴板/转发）
//   ③ 卡片必须是真实 <a href>（用户核心诉求「点击即下载」）
// 任何一条可以通过，就说明对应测试是假绿 —— 假绿比没测试更危险。
//
// 用法：node test/_dl-mutation-check.mjs
//   （备份 → 改坏 → 跑测试 → 恢复，全程只在内存与临时备份间来去，不改仓库内容）
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ⚠️ 本文件会临时改写 lib/index.js 与 lib/client.js，**绝不能与其它测试并行**。
//   node --test test/*.mjs 会把本文件当测试加载 → 显式跳过，必须单独执行：
//     node test/_dl-mutation-check.mjs
const invokedDirectly = !process.env.NODE_TEST_CONTEXT
if (!invokedDirectly) {
  console.log('[skip] _dl-mutation-check 会改写 lib/，必须单独运行：node test/_dl-mutation-check.mjs')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const INDEX = join(root, 'lib', 'index.js')
const CLIENT = join(root, 'lib', 'client.js')

const MUTATIONS = [
  {
    name: '① 去掉直链时效检查（过期不再 410）',
    file: INDEX,
    tests: ['test/dl-ticket.mjs'],
    apply (src) {
      return src.replace(
        '    const now = nowFn()\n    if (now >= exp) {',
        '    const now = nowFn()\n    if (false && now >= exp) {')
    },
  },
  {
    name: '② 去掉直链 uid 校验（地址转发给任何人可用）',
    file: INDEX,
    tests: ['test/dl-ticket.mjs'],
    apply (src) {
      // 注意：文件里有两处 `if (session.username !== uid) {`（/file 与 /dl 各一处）。
      // 必须只改 /dl 那处 —— 用带上下文锚点替换，避免误伤 /file/<token>（那会让变异
      // 变成「改了别处」，看起来被捕获、实际没验证到本功能）。
      const anchor = "    if (session.username !== uid) {\n      deny(403, 'uid-mismatch', { sid, seq, index, ticketUid: uid })"
      if (!src.includes(anchor)) throw new Error('变异目标未命中：/dl 的 uid 校验')
      return src.replace(anchor, "    if (false && session.username !== uid) {\n      deny(403, 'uid-mismatch', { sid, seq, index, ticketUid: uid })")
    },
  },
  {
    name: '③ 卡片改成 onClick + fetch（不再是真实链接）',
    file: CLIENT,
    tests: ['test/dl-card.mjs'],
    apply (src) {
      const old = "mine.map((f) => e('a', {";
      const neu = "mine.map((f) => e('div', {";
      if (!src.includes(old)) throw new Error('变异目标未命中：卡片 <a> 结构')
      let s = src.replace(old, neu)
      // 去掉 href/download/rel，换成 onClick + fetch（正是用户已经踩过的坑）
      s = s.replace('\t\t\t\t\thref: f.downloadUrl,', '\t\t\t\t\tonClick: () => { fetch(f.downloadUrl) },')
      s = s.replace('\t\t\t\t\tdownload: typeof f.name === \'string\' && f.name.length > 0 ? f.name : true,', '')
      s = s.replace('\t\t\t\t\trel: \'noopener\',', '')
      return s
    },
  },
  {
    name: '④ 卡片不再按 turn 过滤（同一批文件在每个 turn 重复出现）',
    file: CLIENT,
    tests: ['test/dl-card.mjs'],
    apply (src) {
      return src.replace(
        'return files.filter((f) => f && f.turn === turn && isUsableDownloadUrl(f.downloadUrl));',
        'return files.filter((f) => f && isUsableDownloadUrl(f.downloadUrl));')
    },
  },
  {
    name: '⑤ /files 不再下发 downloadUrl（卡片将永远不渲染）',
    file: INDEX,
    tests: ['test/dl-ticket.mjs'],
    apply (src) {
      return src.replace('        downloadUrl: dl.ok ? dl.url : null,', '        downloadUrl: null,')
    },
  },
]

// 上次被中断时留下的备份：先恢复，保证仓库不停在「被改坏」状态
const backups = [[INDEX, INDEX + '.mutbak'], [CLIENT, CLIENT + '.mutbak']]
for (const [target, bak] of backups) {
  if (existsSync(bak)) { copyFileSync(bak, target); unlinkSync(bak); console.log('[restore] 发现残留 .mutbak，已恢复 ' + target) }
}
const originals = new Map()
for (const [target, bak] of backups) { const s = readFileSync(target, 'utf8'); copyFileSync(target, bak); originals.set(target, s) }

let allDetected = true
console.log('== v1.5.0 改坏验证（每个变异都必须让测试变红）==')
for (const m of MUTATIONS) {
  const orig = originals.get(m.file)
  let mutated
  try {
    mutated = m.apply(orig)
  } catch (e) {
    console.log('  ✖ ' + m.name + ' —— 变异没生效：' + e.message)
    allDetected = false
    continue
  }
  if (mutated === orig) {
    console.log('  ✖ ' + m.name + ' —— 变异没生效（替换目标没命中），本项不算验证')
    allDetected = false
    continue
  }
  writeFileSync(m.file, mutated, 'utf8')
  let failed = false
  let firstFail = ''
  try {
    execFileSync('node', ['--test', ...m.tests], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    failed = true
    const out = (e.stdout || '') + (e.stderr || '')
    const hit = out.split('\n').find((l) => l.startsWith('✖') && !l.includes('failing tests'))
    firstFail = hit ? hit.trim() : '(见完整输出)'
  } finally {
    writeFileSync(m.file, orig, 'utf8')
  }
  console.log((failed ? '  ✔ 已捕获: ' : '  ✖ 未捕获（测试有洞！）: ') + m.name)
  if (failed && firstFail) console.log('      首条失败 → ' + firstFail)
  if (!failed) allDetected = false
}
for (const [, bak] of backups) { try { if (existsSync(bak)) unlinkSync(bak) } catch (e) {} }
console.log('')
console.log(allDetected ? '结果: ' + MUTATIONS.length + ' 个变异全部被测试捕获（无假绿）' : '结果: 存在未被捕获的变异 —— 测试有洞，必须补')
process.exit(allDetected ? 0 : 1)