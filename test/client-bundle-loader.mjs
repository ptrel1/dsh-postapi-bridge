/**
 * 在 Node 侧求值 `lib/client.js`（浏览器 bundle）的 factory，取出其中的纯函数。
 *
 * 为什么需要这个文件：
 *   `lib/client.js` 的形态是 `window.__ModuleLoader__.load({ id, factory })`，
 *   它**不是 ESM 模块**，Node 直接 `import()` 会因为没有 `window` 而抛 ReferenceError。
 *   而下载按钮的解析逻辑必须能被 `node --test` 直接单测（这是任务验收项）。
 *
 * 备选方案与被否掉的理由：
 *   ① 把解析函数复制一份到 lib/ 下单独文件 —— 两份实现必然漂移，**断言的是副本
 *      而不是线上代码**，测试就失去意义。✗
 *   ② 给 client.js 加 `export` 语句 —— 浏览器 bundle 走的是经典脚本语义
 *      （loader 只读 `__ModuleLoader__.load` 的注册），加 ESM 导出会让它变成
 *      module script，与宿主加载方式冲突。✗
 *   ③ 在 client.js 内部做 `typeof window === 'undefined'` 的环境分支 ——
 *      为了测试而污染线上产物。✗
 *   ④ **（本方案）** 在测试侧提供一个最小 shim：假的 `window.__ModuleLoader__.load`
 *      负责捕获 factory，假的 React/require 提供 factory 求值所需的依赖，
 *      其余全部走**真实源码**。✓ 测的就是线上那一份代码。
 *
 * 注意：这里求值的是整个 factory，包括 CSS 注入与 apply() 的定义 ——
 * apply() 只是被定义、不会被执行（我们不调用它），所以不会触碰任何浏览器 API。
 * document 为 undefined 时 CSS 注入块自己会跳过（client.js 里已有该守卫）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(here, '..', 'lib', 'client.js')

/** 最小 React 替身：factory 只在顶层取这几个成员，真正的渲染不会发生。 */
const reactStub = {
  useEffect: () => {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  createElement: (...args) => ({ type: 'element', args }),
}

/**
 * 求值 client.js 并返回其 module.exports。
 * @returns {{ exports: Record<string, unknown>, captured: unknown }}
 */
export function loadClientBundle () {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load (def) {
        captured = def
      },
    },
  }
  // 用 Function 构造器求值：等价于把 bundle 当经典脚本执行，但作用域里注入
  // window/document —— 且**不污染**本模块的顶层作用域。
  // document 故意不给（undefined）：模拟「CSS 注入守卫生效」的最差环境，
  // 顺带验证 bundle 在无 DOM 时也不会在注册阶段炸掉。
  const run = new Function('window', 'document', 'location', source)
  run(fakeWindow, undefined, undefined)

  if (captured === null) throw new Error('client.js 未调用 window.__ModuleLoader__.load')
  if (typeof captured.factory !== 'function') throw new Error('client.js 的 load() 未提供 factory')

  const requireShim = (id) => {
    if (id === 'react') return reactStub
    throw new Error('未预期的 require: ' + id)
  }
  const exports = captured.factory(requireShim)
  return { exports, captured }
}

/** 下载按钮的纯函数集合。 */
export const downloadButtonHelpers = loadClientBundle().exports.__downloadButtonHelpers

/** v1.1.0：turn 卡片的数据加载器与缓存控制。 */
export const turnCardHelpers = loadClientBundle().exports.__turnCardHelpers

/** v1.5.0：聊天流内直链下载卡片（组件 + 纯函数）。 */
export const dlCardHelpers = loadClientBundle().exports.__dlCardHelpers

/** v1.4.0：客户端日志采集器（纯逻辑，依赖可注入）。 */
export const clientLogHelpers = loadClientBundle().exports.__clientLogHelpers
