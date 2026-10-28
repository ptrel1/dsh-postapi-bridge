/**
 * v0.12.4：静态断言的共享工具。
 *
 * 存在理由（审查 T3/T4）：此前多处静态断言用「lineNo + 固定行窗口」取代码块，
 * 而窗口往往开在错误的位置（例如从 `event:` 行开始而不是 `if` 行），
 * 导致只覆盖半个块 —— **改坏被测代码也不会 FAIL**，等于没断言。
 *
 * 这里统一提供基于**大括号配平**的取块，以及去注释工具。
 */

/**
 * 按大括号配平切出一个函数/块的代码体（从 startIndex 行开始，到配平收尾为止）。
 * 不能用「找第一个 '}' 行」—— 块里常有 if/else 嵌套，第一个 '}' 只是内层的。
 * @param {string[]} lines 源码行数组
 * @param {number} startIndex 起始行下标（0 基）
 * @returns {string}
 */
export function braceBlock (lines, startIndex) {
  let depth = 0
  let started = false
  const out = []
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    for (const ch of line) {
      if (ch === '{') { depth += 1; started = true } else if (ch === '}') depth -= 1
    }
    if (started && depth <= 0) break
  }
  return out.join('\n')
}

/**
 * 定位某个块起始行并取配平后的整块。找不到返回 null（调用方应断言非 null）。
 * 优先匹配 `pred` 的第一处出现。
 * @param {string[]} lines
 * @param {(line: string) => boolean} pred
 * @returns {string | null}
 */
export function blockOf (lines, pred) {
  const at = lines.findIndex(pred)
  if (at === -1) return null
  return braceBlock(lines, at)
}

/**
 * 去掉注释行，只留代码。
 * 断言「没有 location.href =」这类**行为约束**时必须基于代码，
 * 否则文档里解释「为什么不用 location.href」的那句注释会把自己判违规。
 * @param {string} text
 * @returns {string}
 */
export function codeOnly (text) {
  return text.split('\n')
    .filter((l) => {
      const t = l.trim()
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/** 行号（1 基）；未找到返回 -1。 */
export function lineNo (lines, pred) {
  const i = lines.findIndex(pred)
  return i === -1 ? -1 : i + 1
}
