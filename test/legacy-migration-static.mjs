// v0.11.0 静态断言：迁移接线与失配日志拆分（纯文本检查）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { blockOf } from './_static-helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const storeRaw = readFileSync(join(here, '..', 'lib', 'users-store.js'), 'utf8')
const src = raw.split('\n')

test('9. 失配审计里确实出现 ipOk / uaOk 字段', () => {
  const at = src.findIndex((l) => l.includes("event: verdict.reason === 'legacy' ? 'session-legacy-reject'"))
  assert.ok(at > 0, '失配审计块存在')
  const block = src.slice(at, at + 30).join('\n')
  assert.ok(/ipOk: verdict\.ipOk/.test(block), '审计须记录 ipOk')
  assert.ok(/uaOk: verdict\.uaOk/.test(block), '审计须记录 uaOk')
  assert.ok(/uaClassExpected: verdict\.uaClassExpected/.test(block))
  assert.ok(/uaClassActual: verdict\.uaClassActual/.test(block))
})

test('10. migrateUaClass 存在（users-store）且被调用（index）', () => {
  // v0.12.4（审查 H1）：签名加了第 3 参 uaHash —— 迁移要顺带刷新 bindUaHash
  assert.ok(/migrateUaClass\(sessionId, uaClass, uaHash\)/.test(storeRaw), 'users-store 须定义 migrateUaClass(sessionId, uaClass, uaHash)')
  assert.ok(/s\.bindUaHash = next/.test(storeRaw), 'H1：迁移必须刷新 bindUaHash（保留熵）')
  assert.ok(/bindUaHashHistory/.test(storeRaw), 'H1：迁移必须维护哈希历史集合')
  assert.ok(/s\.bindUaClass = uaClass/.test(storeRaw), '须写入 bindUaClass')
  // ⚠️ 不能用 storeRaw.split('migrateUaClass')[1]：文件前部的注释里也提到该方法名，
  // 会切到错误片段（审查 T3 同类问题）。改用配平取块。
  const storeLines = storeRaw.split('\n')
  const fnBlock = blockOf(storeLines, (l) => l.includes('migrateUaClass(sessionId, uaClass, uaHash) {'))
  assert.ok(fnBlock, '必须能定位 migrateUaClass 方法体')
  assert.ok(/this\.persist\(\)/.test(fnBlock), '须落盘')
  assert.ok(/sessionsStore\.migrateUaClass\(/.test(raw), 'index.js 须调用它')
})

test('11. 既有字段 expectPrefix / expectUaHash 未被删除（append-only）', () => {
  assert.ok(/expectPrefix: session\.bindIpPrefix \|\| null/.test(raw))
  assert.ok(/expectUaHash: session\.bindUaHash \|\| null/.test(raw))
})

// ⚠️ v0.12.2 语义变更：旧断言要求「迁移条件必须含 ipOk」，那正是本次修正掉的行为。
//   v0.11.0～v0.12.1：迁移前提是 ipOk（IP 硬绑定）→ 线上移动网络用户永远救不了。
//   v0.12.2 起：迁移只要求 UA 类别可识别（非 other），不再要求 ipOk。
// ⚠️ v0.12.2 语义变更：旧断言要求「迁移条件必须含 ipOk」，那正是被修正掉的行为。
// ⚠️ v0.12.4：H1 重写后，'other' 判断形式变为独立的 `if (uaClassActual === 'other') return`。
test('【v0.12.2/4 语义变更】迁移回调只在类别可识别时触发（不要求 ipOk，但必须排除 other）', () => {
  const body = blockOf(src, (l) => l.includes('function verifyFingerprint'))
  assert.ok(body, '必须能取到 verifyFingerprint 块')
  assert.ok(/onLegacyMigrate\?\.\(session\.sessionId, uaClassActual, uaHashActual\)/.test(body), '回调存在（带 uaHash）')
  // 'other' 必须被排除（形式可能随实现变化，两种写法都接受）
  const otherGuard = /if \(uaClassActual === 'other'\) return/.test(body)
    || /if \(uaClassActual !== 'other'\)/.test(body)
  assert.ok(otherGuard, "迁移条件必须排除 'other'")
  // 不得再以 ipOk 作为迁移前提（v0.11.0 旧写法）
  assert.ok(!/if \(ipOk && uaClassActual !== 'other'\)/.test(body), '不得再以 ipOk 为前提')
  // deny 策略下先拒后不迁移（顺序）
  const denyIdx = body.indexOf('if (!ipOk && !allowDrift) return')
  const migrateIdx = body.indexOf('onLegacyMigrate?.(')
  assert.ok(denyIdx > 0 && migrateIdx > 0 && denyIdx < migrateIdx, 'deny 判定须早于迁移回调')
})
test('【v0.12.4 语义变更】老会话先做哈希比对（step1），再决定是否迁移', () => {
  // 变量从 legacyHashOk 重命名为统一的 uaHashOk（新老会话共用同一套哈希命中判定）。
  const body = blockOf(src, (l) => l.includes('function verifyFingerprint'))
  assert.ok(body, '必须能取到 verifyFingerprint 块')
  assert.ok(/const uaHashOk = hashCandidates\.includes\(uaHashActual\)/.test(body),
    '必须统一计算 uaHashOk（含历史集合）')
  const hashIdx = body.indexOf('const uaHashOk =')
  const migrateIdx = body.indexOf('onLegacyMigrate?.(')
  assert.ok(hashIdx > 0 && migrateIdx > 0 && hashIdx < migrateIdx, '哈希判定必须先于迁移回调')
})

test('uaDeviceClass：空 UA 归 other（与注释一致）', () => {
  const at = src.findIndex((l) => l.includes('function uaDeviceClass'))
  const body = src.slice(at, at + 16).join('\n')
  assert.ok(/s\.trim\(\)\.length === 0\) return 'other'/.test(body), '空 UA 必须归 other')
})

test('新增审计事件 session-ua-class-migrated', () => {
  assert.ok(raw.includes('session-ua-class-migrated'))
})

test('AUDIT_VERSION 与 package.json 一致', () => {
  const m = raw.match(/const AUDIT_VERSION = '([^']+)'/)
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(m[1], pkg.version)
})

test('未改动官方源码路径 / client.js（防误改）', () => {
  assert.ok(!raw.includes('/main/app/github/deepseek-harness/'), 'index.js 不得引用官方源码绝对路径')
})
