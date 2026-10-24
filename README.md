# dsh-postapi-bridge 🚪🔐

> **DeepSeek Harness (DSH) 双半侧统一网关与鉴权桥梁插件**
> 融合 **人类端多用户安全登录** + **机器端轻量 HTTP POST / RESTful API 调度网关**。
> ⭐ **主要目的之一**：让 DSH 支持**公网访问**——用账号密码自助换取官方动态凭证，替代"登录服务器抓 token"（见「🎯 核心目的之一」）。

> ⚠️ **文档时效说明（20260923 核对）**：本文部分章节写于 **DSH 0.1.2 时代**，
> 其中「需修改 DSH 源码加 `requireSession` 扩展点」的路径**已不适用于 0.1.5+**——
> 官方已在 `client/connection` 内**原生提供** `browserAuth.isAuthenticated()` 门禁，
> 无需再打源码补丁。**改动细节见下方「🔐 公网账号系统」章节的现状标注。**
> 阅读时以带 ✅/⚠️ 标注的现状说明为准。

---

## 📦 npm 发布状态

> ⚠️ **npm 上的版本已滞后**：registry 上最新为 **`0.1.0`**，而本仓库当前已是 **`0.6.6`**。
> **请勿以 npm 版本为准**——`0.1.0` 缺少 `sessionAuth` 服务接线，且缺少其后的全部安全加固
> （会话指纹绑定、step-up 提权、伪回环绕过修复、机器通道 fail-closed 等）。
> **以本仓库为准（当前 `0.6.7`）。**
>
> ✅ **推荐安装方式：从本仓库源码安装**
> ```bash
> dsh plugin --profile web add git+https://github.com/ptrel1/dsh-postapi-bridge.git
> ```
> 🔗 npm 页面（版本较旧，仅供参考）：[https://www.npmjs.com/package/dsh-postapi-bridge](https://www.npmjs.com/package/dsh-postapi-bridge)

---

## 版本记录 v0.9.0（交付物临时签名下载）

- **新增两个端点**：为「`present` 过的交付物」签发**有时效、绑用户**的下载地址。
  客户端（含安卓）用普通 `GET` 即可拉文件，不必再组合 Cookie/Bearer。

  | 接口 | 方法 | 鉴权 | 说明 |
  | :--- | :--- | :--- | :--- |
  | `/api/dsh/v1/file-ticket` | `POST` | 已登录（插件会话） | 为一条 present 记录签发临时下载票据 |
  | `/api/dsh/v1/file/<token>` | `GET` | 已登录 + 票据绑定本人 | 流式下载，支持 Range 续传 |

- **有效期规则（两段独立）**：

  ```
  签发 file-ticket  ──► 「待激活」，距 issuedAt < 48h 内有效
                         │
  第一次下载请求    ──► 激活：activatedAt = now，此后可用到 now + 5h
                         │
    激活后 5h 内     ──► 可任意下载（含 Range 续传、可重复请求，无次数限制）
    now >= activatedAt + 5h         ──► 410
    未激活 且 now >= issuedAt + 48h ──► 410
    过期后           ──► 重新调 file-ticket 拿新票（唯一续期方式）
  ```

  > ⚠️ **过期的是「票据」，源文件永远不删不改。**
  > 交付物是模型产出的工作区文件，生命周期属于用户/工作区；本插件只签发访问凭证，
  > 无权也不该在任何过期路径上删除别人目录里的文件。

- **签发请求**：`{ "sessionId": "...", "seq": 7, "index": 0 }`
  （`seq` = `deliverables/presented` 事件的 seq，`index` = 该事件 `files` 数组下标，
  与官方前端 `presentedFileUrl(sessionId, seq, index)` 同一套坐标）。
  - 200：
    ```json
    {
      "ok": true,
      "url": "/api/dsh/v1/file/<token>",
      "issuedAt": 1730000000000,
      "activateDeadline": 1730172800000,
      "expiresAt": 1730172800000,
      "activateWindowHours": 48,
      "sessionHours": 5,
      "filename": "报告.docx",
      "size": 12345
    }
    ```

    > ⚠️ **`expiresAt` 语义 = 待激活截止时刻，不是下载有效期。**
    > 真正的下载有效期从**首次下载**起算 `sessionHours`（默认 5h），签发时无法预知，
    > 因此不可能提前写进响应。`expiresAt` 仅为向后兼容保留的**歧义字段**，
    > 新客户端请读 `activateDeadline` + `sessionHours`，忽略 `expiresAt`（计划 0.10.x 移除）。

    > 🔒 **响应体不返回 `ticketId`。** 它是服务端状态库的键，属于内部实现细节；
    > 对外暴露会让攻击者能探测「某张票是否存在」，也会把内部键变成对外的兼容契约。
    > 客户端只需要 `url`。
  - 401 未登录；403 路径逃逸；404 present 记录不存在；413 超限（签发时就拒）
- **下载**：`GET` 该 url。
  - 200 文件流；401 未登录；403 签名无效/非本人/**票据记录与 token 不一致**；
    410 票据过期或不存在；404 文件不存在；413 超限
  - 必带 `Accept-Ranges: bytes`；`Content-Disposition: attachment; filename*=UTF-8''<RFC5987>`（中文名已编码）
  - `Range: bytes=0-9` → `206` + `Content-Range`；越界 → `416` + `Content-Range: bytes */<size>`
- **token**：`{ v, tid, sid, seq, index, uid }` 的 base64url + HMAC-SHA256，secret 与
  session cookie **同源**，校验用 `timingSafeEqual`。
  - **载荷不含 `exp`**：签发时还不知道激活时刻，写死 exp 与「首下起 5h」直接矛盾；
    时效一律查服务端状态。
  - 载荷保留 `sid/seq/index/uid` 是为了**验签后不查库就能做前置校验**，但**不作为最终
    授权依据**（最终以状态库 + 登录态为准）。
  - `tid`（16 hex 随机）是状态库的键，与 token 分离：日志里可以安全地记 `tid` 排查，
    但 `tid` 本身不能用于下载（仍需签名 token）。
- **路径安全**：文件路径与会话 cwd **双向 `realpath`** 后判归属，**不用字符串前缀**
  ——工作区内可能存在指向外部的符号链接（模型自己就能建），前缀判断会把
  `/cwd/link -> /etc/passwd` 误判为「在工作区内」。另校验必须是**普通文件**。
- **状态文件**：`$DSH_HOME/data/dsh-postapi-bridge/file-tickets.json`（与 access-log 同目录）
  ```json
  {
    "v": 1,
    "tickets": {
      "a1b2c3d4e5f60718": {
        "sid": "sess-abc", "seq": 7, "index": 0, "uid": "alice",
        "issuedAt": 1730000000000, "activatedAt": null
      }
    }
  }
  ```
  - `load()` 惰性读（mtime 变化时重读，支持多实例共享）
  - 落盘 `writeFileSync(tmp)` + `renameSync` 原子替换；**写失败只记日志，不抛错**
  - `cleanup(now)`：插件**启动时一次** + **每次签发时一次**（惰性，无需定时器）。
    只删过期票据记录，**绝不触碰源文件**。
- **并发激活**：Node 单线程 + 该段全程无 `await`，因此「判空 → 赋值 → 落盘」在进程内
  天然原子，保证**只允许一次激活、后到者沿用已存在的值**。这是对运行时模型的显式依赖，
  已在代码注释中标明：若将来改成异步落盘，必须重新引入互斥。
- **为什么「激活」发生在登录鉴权之前**（校验顺序第 5 步 < 第 7 步）：激活是**票据自身的**
  生命周期事件，与「谁在用」无关。若把激活挪到鉴权之后，未登录探测就能反复刷新 48h 计时
  —— 攻击者在第 47h59m 匿名探一下就能把等待期再续下去，票据永远不过期。
  现在「第一次被访问即激活」把票据生命周期**锁死在首次访问那一刻**，这是正确性保证：
  泄露出去的票被别人先激活，原主仍能在同一 5h 窗口内使用（窗口共享，不额外损失），
  但它绝不会因此获得额外的 48h 延期。
- **审计**：`file-ticket-issued`（tid/sid/seq/index/uid/filename/size）、
  `file-ticket-activated`（tid/uid/issuedAt/activatedAt/sessionDeadline）、
  `file-download`（落 `finish`/`close`，记 bytes/range/activatedAt）、
  `file-download-denied`（带 reason）。**全程不记 token 本体**；审计里的 `subPath` 对
  `/file/<token>` 脱敏为 `/file/<redacted>`。
- **依赖**：读取 present 事件走官方公开服务 `ctx.sessionQuery.readEvent`
  （与官方 `present-open` 路由同一通道，支持冷读持久化会话）。宿主未装配该服务时
  端点回 `503`（fail-closed）。

**配置项**（新增，均有默认值；非正数一律回退默认）：

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `downloadActivateWindowHours` | `48` | 票据「待激活」上限，自 `issuedAt` 起算 |
| `downloadSessionHours` | `5` | 首次下载后的可用窗口，自 `activatedAt` 起算 |
| `downloadMaxMB` | `200` | 单文件下载上限，超过则签发阶段即 413 |

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.9.0`。

---

## 版本记录 v1.5.0（交付物「直链下载」+ 聊天流内可点击卡片）

### 用户需求（原话）

> 这个在聊天框里发的是 dsh 自带的那个我打不开，你不能做一个卡片然后卡片点击就是直接的下载地址吗
> c 然后加上下载地址时效就是我想要的功能

**痛点**：DSH 官方交付物文件卡片在用户的手机 WebView 里**点了没反应**，用户拿不到文件。
**方案 C**：插件自己渲染一张卡片，卡片本身就是**直接的下载链接**（`<a href download>`），
点击即下载，**不经过任何 POST 签票**。

### ① 新端点 `GET <apiPrefix>/dl/<token>` —— 直链下载

```text
payload = base64url({ v: 2, sid, seq, index, uid, exp })
token   = payload + '.' + base64url(HMAC-SHA256(secret, payload))
```

与既有 `file-ticket`（**语义一个字节都没改**）的分工：

| | file-ticket（保留不动） | `dl/<token>`（本版新增） |
| :--- | :--- | :--- |
| 有效期 | 48h 待激活 + 首下起 5h 窗口 | **纯时间窗，签发即开始计时** |
| 激活 | 首次下载激活 | **不激活** |
| 次数 | 不限 | **不限** |
| 服务端状态 | 有（`file-tickets.json`） | **无**（`exp` 在 token 里） |
| 用途 | 复杂分享 | **卡片直链，点击即下** |

- 有效期配置项 **`dlTicketHours`**，默认 **48**。
- 鉴权：**需要会话 cookie**（人类通道，与 `/files` 一致）；**token 里的 `uid` 必须等于当前会话用户**。
  无 cookie → `401`；uid 不符 → `403`；签名错 → `403`；**过期 → `410`**（文案明确说明过期）；文件已删除 → `404`。
- 响应：文件流 + `Content-Disposition: attachment; filename*=UTF-8''…`（RFC5987）+ **支持 Range**（复用 `parseRangeHeader`）。

> **为什么 dl 票把 `exp` 写进 token，而 file-ticket 不写：**
> file-ticket 的窗口从「第一次下载」起算，签发时**无法预知**激活时刻，只能存服务端状态；
> dl 票的窗口从「签发」起算，`exp` 在签发时即确定 ⇒ **纯无状态**即可验签 + 判过期。
> 无状态是刻意的：`/files` 一次要给 N 个文件各发一张票，若每张都写状态库，
> 一次列表请求就写 N 次磁盘。

### ② `/files` 列表返回直链

每条 file 新增两个字段（`ticketUrl` 保留，兼容旧前端）：

```json
{
  "seq": 2365, "index": 0, "name": "DSH-PostAPI-v0.3.0.apk", "size": 722,
  "downloadUrl": "/api/dsh/v1/dl/eyJ2IjoyLCJzaWQiOiJzZXNzLTEiLCJzZXEiOjIzNjUsImluZGV4IjowLCJ1aWQiOiJhbGljZSIsImV4cCI6MTc5MjgzMTUzNzEwN30.FAKE_SIGNATURE_FOR_DOC",
  "downloadExpiresAt": 1792831537107,
  "ticketUrl": "/api/dsh/v1/file-ticket"
}
```

### ③ 前端：聊天流内可点击卡片

- 位置：`conversation.chat.turnTail`（与官方交付物卡片同一个 slot）；**只渲染属于当前 turn 的文件**（按 `turn` 字段过滤）。
- 数据来源：复用 `loadSessionFiles` 缓存，**不新增请求**。
- 形态：整张卡片是 `<a href={downloadUrl} download>`，点击 = 浏览器直接下载，**不发任何 JS 请求**。
- 样式 `dsa-dlc-*`（与抽屉的 `dsa-dl-*` 分开），只用 `--dsw-alias-*` 语义 token，暗色模式自动跟随。
- 文件名超长 `ellipsis` 截断；**不显示 description**（用户反馈过文字太长撑破）。
- `downloadUrl` 缺失或格式不对 → **静默不渲染该卡片**。
- 独立 DOM + 独立 try/catch：不影响官方卡片渲染。

#### 🔴 为什么卡片用 `<a href>` 而不是 `onClick + fetch`

这是用户的核心诉求，也是本次改动的唯一目的：

1. **用户卡住的正是那条链** ——「点击 → 前端发请求 → 再导航」。官方卡片在手机 WebView 里那一步没走通，
   用户点了没反应、拿不到文件。再用 `fetch` 换地址，等于**重演同一个坑**。
2. `<a href download>` 由**浏览器原生**处理：不依赖 JS 跑通、不依赖 `fetch` 成功、不依赖 WebView 的 XHR 实现。
   只要请求带上会话 cookie，浏览器自己就会发这个 GET 并落盘。
3. 原生下载走**系统下载管理器**：手机上有进度、可断点续传（后端支持 Range）、可转存/分享 ——
   这些是 `fetch` + `Blob` 给不了的。
4. 同源 cookie 会随浏览器发起的下载请求**天然携带**，不需要 `credentials: 'same-origin'` 之类 JS 手段。
5. 失败可见：`401/403/410` 时浏览器显示后端文案，而不是我们这一层的「点了没反应」。

⇒ 静态断言（`test/dl-card.mjs` ③b）钉住：卡片区域**不得**出现 `onClick` / `fetch` / `triggerBrowserDownload` / `location.href` / `window.open`。

### ④ 保留现有能力

- 抽屉（`conversation.session.header.actions`）继续保留 —— 它是会话级汇总视图。
- `file-ticket` 端点逻辑不动（`test/dl-ticket.mjs` B16 守着）。
- 官方 `deliverables.file.actions` 下载按钮保留。

### 🔴 顺带修的正经 bug：文件被删后返回 403 而不是 404

`resolveSafeFilePath` 里 `isRealpathInside` 对「路径不存在」（realpath `ENOENT`）与
「路径在 cwd 之外」都返回 `false`，而调用方把 `false` 一律翻成 `'escape'`（403）。后果实测：

- 下载已删除的交付物 → **403 Forbidden**（应 404）；
- `/files` 的 `skippedReasons` 记成 `path-escape`（实际只是文件没了）。

用户看到「没权限」，排查方向被彻底带偏。修法：**先 `lstat` 判存在**（不存在 → `missing` → 404），
再做 realpath 归属判定。安全性不变（符号链接的归属判定仍由 `isRealpathInside` 完成）。

### 测试

| 文件 | 覆盖 |
| :--- | :--- |
| `test/dl-ticket.mjs` | 纯函数 6 项 + 端到端 16 项：正常下载字节一致、Range(206)/后缀 Range、过期 410、边界两侧、签名篡改 403、uid 不符 403、无 cookie 401、文件删除 404、伪造坐标 404、不限次、`/file-ticket` 未变 |
| `test/dl-card.mjs` | turn 过滤、不重复、老数据不误挂、`downloadUrl` 缺失静默降级、`<a href>` 结构、**不得 onClick/fetch**、不显示 description、独立命名、ellipsis 三件套、暗色 token、复用缓存、挂载点与 try/catch |
| `test/_dl-mutation-check.mjs` | **改坏验证**（单独运行）：去时效 / 去 uid 校验 / 卡片改 onClick+fetch / 去 turn 过滤 / 不下发 downloadUrl —— 5 个变异全部必须变红 |

> ⚠️ 端到端用例的会话指纹必须是 **`uaClass: 'mobile'` + 真机 UA**。
> `verifyFingerprint` 对 `uaClass === 'other'`（node/curl 类 UA）一律拒绝；
> 早期用 `node-test` UA 的用例只是侥幸没走到指纹校验，一旦真走就会 403。

---
## 版本记录 v1.4.1（修：同一秒内多次上报互相覆盖 · 丢日志）

### Bug（用户实测）

同一 IP 在同一秒内连续两次 `POST /client-log`，返回**同一个文件名**，落盘只剩最后一次：

```text
第一次: {"ok":true,"stored":true,"file":"20261022-114349-12ca17b4.json","bytes":430}
第二次: {"ok":true,"stored":true,"file":"20261022-114349-12ca17b4.json","bytes":539}
```

### 根因

v1.4.0 的文件名是 `<到秒的时间戳>-<sha256(IP) 前 8 位>.json`。
**唯一区分量是 IP** —— 同一 IP 同一秒的多次上报必然同名，而 `rename` 会**覆盖**已存在文件，
于是 snapshot / perf / flush 同秒到达时**互相吞日志**（手机上正是高频上报）。

### 修法

- 文件名 → `<YYYYMMDD-HHMMSS-mmm>-<16位随机hex>.json`：时间戳精确到**毫秒** + 8 字节密码学随机，
  **同一毫秒内并发也不撞**（碰撞概率 ~2⁻⁶⁴）；**IP 彻底退出命名**。
- 时间戳改用**本地时间**（不再 `toISOString()` 的 UTC）：运维按本地时间找文件不会差一个时区。
- 写盘 tmp 文件名加 `pid + 随机` 后缀（旧实现恒为 `<target>.tmp`，并发写同一目标会互相截断）。
- `apply(ctx, config)` 支持可注入 `config.now`（仅供测试把"同一毫秒"做成确定性用例，生产恒为 `Date.now`）。

### 测试

- 新增 `test/client-log-naming.mjs`：同一毫秒取名 1000 次不重复；**时钟钉死**后并发 5 次上报 → 5 个不同文件且内容都在；
  真实时钟下并发 5 次 / 串行 10 次 → 各自落盘、无覆盖；目录无 `.tmp` 残留。
- `test/_mutation-check.mjs` 新增变异「去掉文件名随机后缀」——并发用例必须变红（防假绿）。

---

## 版本记录 v1.4.0（客户端日志自动上报 · 远程诊断手机端卡顿）

### 背景（为什么要做这个）

用户反馈：**在安卓 App 的 WebView 里输入，比用 Edge 浏览器明显卡**。
但手机上拉不到 Console 日志（没有 adb 环境）——**现场不可观测**，排查无从下手。

于是做成「自动上报」：前端把环境快照 / 长任务 / 掉帧 / 错误批量打到服务端落盘，
运维在电脑上直接读文件即可。

### 🔴 为什么这个端点**免鉴权**（本功能唯一的安全妥协）

用户手机上的 `/files` 返回 **401** —— WebView 里没有插件会话 cookie（登录态在 App 侧，
与浏览器登录是两条链路）。日志端点若要求 cookie 或 Bearer，用户就**永远传不上来**，
「远程诊断」这个唯一目的即落空。

因此 `/client-log` 与 `/mobile-login` **同级**：在**任何 token / cookie 校验之前**分流。
（`test/client-log-static.mjs` ① 用行号断言把位置钉死，防止后人挪动。）

安全性不靠凭据，靠下面**五条限额**组成的边界：

| # | 限制 | 作用 |
| :--- | :--- | :--- |
| ① | 单次请求体 **≤ 256 KB**（超 → 413） | 防单次大包打满内存/磁盘；`readBody` **边读边计数**，超限立刻断开 |
| ② | 每 IP **每小时 ≤ 20 次**（超 → 429） | 防刷；独立计数器，不与 `stepupFails` 混用（语义不同） |
| ③ | 目录总量 **≤ 50 MB** | 超限**自动删最旧文件** |
| ④ | 只保留最近 **50 个文件** | 同上（两条上限都触发删除） |
| ⑤ | 字段白名单 + `entries` **≤ 200** | 多余字段丢弃；超出**保留最新**（末尾），并记 `meta.receivedEntries` 让截断不静默 |

残余风险（已明确接受）：匿名者可写**脱敏后的**垃圾数据挤掉旧日志。
缓解：条数/体积上限决定「挤掉」需要持续大量请求，且每次都会留下审计记录（`client-log-received`）。

### 🔴 脱敏（最重要的一环，且**必须发生在写盘之前**）

日志来源是**页面里的一切文本** —— 包括 `console.error` 的实参，而 DSH 的错误信息里
经常夹着请求 URL、`Authorization` 头、后端回显的 token。这些一旦落盘并被人拉走，
就等于把会话凭据永久留档。

因此 `normalizeClientLogRecord()` 在**写盘之前**对每个字符串字段调用脱敏；
`test/client-log-static.mjs` ⑥ 断言 `normalize` 的行号 **早于** `writeClientLogFile`。
覆盖的模式见下节「脱敏规则」。

### 脱敏规则（具体实现）

| 规则 | 正则要点 | 命中示例 |
| :--- | :--- | :--- |
| A-1 `Authorization` 头 | `(\"?authorization\"?\s*[:=]\s*\"?)(?:(?:bearer\|basic\|token)\s+)?([A-Za-z0-9._~+/=\-]{8,})` | `Authorization: Bearer sk-live-DEADBEEF` → `<redacted>` |
| A-2 裸 `Bearer` / `Basic` | `((?:bearer\|basic)\s+)([A-Za-z0-9._~+/=\-]{8,})` | `Bearer abcdef123456` → `Bearer <redacted>` |
| B 敏感键值对 | 键名白名单逐个生成正则（见下），值支持 `"…"` / `'…'` / 反引号 / 裸值 | `token=abc123`、`dsh_postapi_session=xyz`、`password=hunter2`、`"apiKey":"sk-…"`、`cookie: …` |
| C 长 hex | `(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])` | sha256/HMAC/签名 → `<redacted>` |
| D 长 base64url | `(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+/=]{32,}={0,2}(?![A-Za-z0-9_\-+/=])` | 随机 token / JWT 段 → `<redacted>` |

**B 的键名白名单**（`CLIENT_LOG_SECRET_KEYS`）：
`dsh_postapi_session` · `dsh_stepup` · `dsh-auth-*` · `authorization` · `cookie` · `set-cookie`
· `token` · `access_token` · `refresh_token` · `id_token` · `password` · `passwd` · `pwd`
· `secret` · `sessionsecret` · `api_?key` · `apikey`

**执行顺序**：A → B → C → D。顺序有意义 —— 先处理「键值对」再处理「裸串」，
否则 value 会被拆成两半（残留片段）。

**另外两处防护**：
- `extra` 字段**递归脱敏**（对象/数组/嵌套都走 `redactClientLogValue`，深度上限 6 防环）；
- 截断顺序是「先脱敏 → 再截断 → **再脱敏**」（先截断可能把 32 位 token 截成 31 位而漏网；
  截断本身又可能切出新的「32 位 hex」形态）。

**误伤控制**：四条规则都要求「键名/协议前缀」或「长度 ≥ 32 且字符集符合」，
实测普通文本（UA、错误栈、中文）**零误伤**（见 `test/client-log.mjs` 的快照用例）。

### 存储

```
$DSH_HOME/data/dsh-postapi-bridge/client-logs/<YYYYMMDD-HHMMSS-mmm>-<16位随机hex>.json
例：20261022-194532-645-2dd03ae1e0eac39b.json
```

- 目录复用 `auditDataDir(config)`（与 `access-log.jsonl` 同根，**不进 git、不被 `sync.sh` 清理**）；
- 文件名**不参与任何身份标识**：时间戳（**本地时间**）精确到**毫秒** + `randomBytes(8)`（16 位 hex）。
  **不用 IP** —— 同一 IP 高频上报是常态，拿 IP 当区分量必然在"同一秒"上撞车（v1.4.1 修的正是这个）；
- 原子写盘：先写 `.tmp`（tmp 名含 pid + 随机，避免并发共用同一 tmp）再 `rename`；
- 清理时机：**写盘之后**再 prune（先保证最新一份在，即使进程在清理中途被杀）。

### 请求体（字段白名单，其余丢弃）

```jsonc
{
  "source": "web" | "app",
  "kind": "snapshot" | "perf" | "error" | "flush",
  "ua": "<user-agent>",
  "env": {
    "screen": [390, 844],
    "dpr": 3,
    "deviceMemory": 4,
    "hardwareConcurrency": 8,
    "supports": { "webgl": true, "compression": false }
  },
  "entries": [
    { "t": 1792661621796, "level": "warn", "kind": "longtask", "duration": 320, "msg": "..." }
  ]
}
```

**响应**：

| 状态 | 含义 |
| :--- | :--- |
| `200` | `{ ok:true, stored:true, file, bytes, entries, truncated, pruned }` |
| `400` | 非法 JSON |
| `405` | 非 POST（GET 同名路径走原 fail-closed 逻辑） |
| `413` | 超 256 KB |
| `429` | 该 IP 一小时内已上报 20 次 |
| `500` | 落盘失败（**不谎报 200**） |

### 审计

每个请求一条 `client-log-received`：`ip` / `ua` / `source` / `kind` / `bytes` / `storedBytes`
/ `entries`（条数）/ `receivedEntries` / `truncated` / `file` / `prunedFiles` / `usedInWindow`。

🔴 **不记日志内容本身**（内容已在文件里，且可能含用户文本）。
另有 `client-log-throttled`（429）与 `client-log-rejected`（413 / 400）两类拒绝记录。

### 前端自动采集（`lib/client.js`）

> 🔴 **开关说明**：配置项 `clientLogAutoReport`（默认 `true`）。
> **但前端拿不到 config** —— client entry 由宿主以 `{ name }` 创建，从不透传插件 config
> （同一已知边界见 `apiPrefix` 处的说明）。因此前端**固定开启**。
> 现场临时关闭的逃生阀：`localStorage.setItem('dsh-postapi-client-log', 'off')` 后刷新。

| 采集项 | 触发 | 说明 |
| :--- | :--- | :--- |
| `snapshot` | 页面加载后**立即一次** | `ua`（关键：能看出 WebView 内核版本）/ `screen` / `dpr` / `deviceMemory` / `hardwareConcurrency` / `supports{webgl,compression}` |
| `longtask` | `PerformanceObserver(['longtask'])` | 只记 **> 100 ms** |
| `fps` | `requestAnimationFrame` 采样 | **FPS < 30 持续 2 秒**才记一条（每满 2 秒记一次并清零，避免刷屏） |
| `fid` | `PerformanceObserver(['first-input'])` | 首次输入延迟 |
| `cls` | `PerformanceObserver(['layout-shift'])` | 单次布局偏移值 |
| `error` | `window.onerror` / `unhandledrejection` / `console.error` 包装 | **立即上报**（单条也发） |
| `flush` | 每 60 秒 或 `visibilitychange → hidden` | 只传**上次上报之后**的新条目；空则不发请求 |

**设计红线（每条对应一个坑）**：

1. **不污染 console**：`console.error` 包装后**用 `apply` 调原函数**、参数原样透传、返回值原样返回，
   自身任何异常都被吞掉（采集失败绝不能影响控制台输出）；卸载时恢复原函数。
2. **回调里只 push**：`PerformanceObserver` / rAF 回调只入队，脱敏与序列化留到上报时
   —— 长任务本身说明主线程紧张，回调里再做重活就是雪上加霜。
3. **页面不可见时暂停 rAF 采样**（`document.hidden`），重新可见恢复。
4. **失败静默、不重试**：`fetch(...).catch()` 一律吞掉，绝不弹提示、绝不安排重试（避免断网雪崩）。
5. **不阻塞页面**：`fetch` + `keepalive: true`，且不 `await`。
6. **不用 `unload`**（浏览器会丢弃其中的异步请求），改用 `visibilitychange → hidden`。
7. **只传增量**：每条 entry 带自增 `seq`，上报成功才把 `lastSentSeq` 推到已发送的最大值；
   失败则不动 → 下次 flush 重发同一批（不丢数据、不重复）。
8. **队列上限 500 条**（超出丢最旧的）：一次 flush 上限 200 条，500 足够覆盖几次失败的积压。

### 测试

| 文件 | 项数 | 覆盖 |
| :--- | :--- | :--- |
| `test/_e2e-client-log.mjs` | 56 | 免鉴权 200 / 文件创建 / 413 / 429 / **脱敏原文不落盘** / 截断保留最新 / 白名单 / 50 文件与 50MB 清理 / 非法输入不炸 |
| `test/client-log.mjs` | 20 | 环境快照字段 / 长任务阈值（真实 install 路径）/ FPS 持续 2 秒 / 隐藏暂停 / 增量不重复 / 失败静默不抛 / console.error 原行为 |
| `test/client-log-static.mjs` | 15 | 分流位置行号（早于 token/cookie 校验）/ 五条限额存在 / **脱敏早于写盘** / 审计不含内容 / prune 只删 .json |
| `test/_mutation-check.mjs` | 3 | 🔴 **改坏验证**：去掉脱敏 / 去掉大小限制 / 去掉限频 —— 每个都必须让测试变红 |

```bash
node --test test/*.mjs                  # 全量（316 项）
node test/_e2e-client-log.mjs           # 服务端端到端（打印逐条结果）
node test/_mutation-check.mjs           # 改坏验证（必须「全部被捕获」）
```

### 数据样例（脱敏后的真实形状，假数据）

```jsonc
{
  "v": 1,
  "receivedAt": "2026-10-22T10:29:30.123Z",
  "source": "app",
  "kind": "perf",
  "ua": "Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "env": {
    "screen": [390, 844], "dpr": 3, "deviceMemory": 4, "hardwareConcurrency": 8,
    "supports": { "webgl": true, "compression": false }
  },
  "entries": [
    { "t": 1792661621796, "level": "warn", "kind": "longtask", "duration": 320, "msg": "longtask 320ms" },
    { "t": 1792661623401, "level": "warn", "kind": "fps", "duration": 22, "msg": "fps 22 for 2013ms" },
    { "t": 1792661625100, "level": "info", "kind": "fid", "duration": 180, "msg": "first-input delay 180ms" },
    { "t": 1792661626900, "level": "info", "kind": "cls", "duration": 0.0421, "msg": "layout-shift 0.0421" },
    { "t": 1792661630200, "level": "error", "kind": "console.error",
      "msg": "Failed to load /api/dsh/v1/files?sessionId=abc&<redacted> 401" },
    { "t": 1792661630300, "level": "error", "kind": "error", "duration": null,
      "msg": "Cannot read properties of undefined (reading 'map') @ bundle.js:1204",
      "extra": { "source": "window.onerror" } }
  ],
  "meta": { "receivedEntries": 6, "keptEntries": 6, "truncated": false }
}
```

**注意**：`/apis/dsh/v1/files?sessionId=abc&<redacted>` 里的 `<redacted>` 就是脱敏结果 ——
原串是 `?token=xxx`，落盘后只剩 `<redacted>`。

### 🔴 实现时踩到的坑（记录下来免得后人重踩）

这也是一份 **Node 侧测试陷阱清单**（`test/_installer-harness.mjs` 文件头有完整版）：

1. **`new Function(src)` 求值出的函数，闭包绑定到全局作用域**；而 `globalThis.window = x`
   只写属性、**不产生全局变量绑定** → bundle 内部 `typeof window` 恒为 `undefined`。
   表现：安装器第一行 `if (!win ...) return function () {}` 直接早退，**看起来像"什么都没装"**。
   Chromium 不会这样（浏览器 window 既是全局对象属性又有 var 语义）。
   ⇒ 测试夹具统一用 `(0, eval)` 让被测代码落在真正的全局作用域。
2. **只重新求值「安装器」也没用**：它引用的模块级常量（阈值）属于原闭包 → `ReferenceError`
   → 被安装器自己的 `try/catch` 吞掉 → "装上了但什么都不采"，比①更难发现。
   ⇒ 安装器改为接受 `thresholds` 参数（浏览器不传 → 用模块常量），测试显式注入。
3. **替换回调的参数个数**：`s.replace(re, function (m, head) {...})` 里 `head` 是**第一个捕获组**；
   若正则的实际第一个组是整串（例如 `((?:bearer|basic)\s+)` 之外的写法），`head` 会拿到**匹配到的数字字符**
   —— 实测症状是脱敏结果变成 `0<redacted>`。写替换回调时**必须**数清捕获组。
4. **静态断言的「行距」会被无关代码干扰**：`test/download-button-static.mjs` 用
   「`credentials` 行与 `/file-ticket` 行距 < 8」判定，任何新增的 `credentials: 'same-origin'`
   都会抢占 `lineNo` 的**第一处命中**。⇒ 新代码里别写同样的字面量，或在注释里也别写。

---


## 版本记录 v1.3.0（App 在线更新支持 · 服务端）

### 设计取舍

用户排除的方案：npm 发布 / 会话 present / 独立文件服务器。
最终方案：**数据目录放文件 + 本插件只读分发**。

为什么放数据目录而不是插件目录：
- 插件目录在 npm 安装 / `sync.sh` 重部署时会被 `rm -rf` 再拷一份，APK 会丢；
- 数据目录天然不进 git、不被 sync 复制、`npm install` 也不碰；
- 与审计日志同根（`auditDataDir`），运维只需记一个位置。

### 目录约定

```
$DSH_HOME/data/dsh-postapi-bridge/app/
├── app-latest.apk          ← 最新 APK
└── app-version.json        ← { version, code, notes, publishedAt, size, sha256, filename }
```

本插件**只读**这个目录，不负责发布（运维手工放文件）。

### 两个端点（属人类通道，与 `/files` 同鉴权）

| 端点 | 说明 |
| :--- | :--- |
| `GET /api/dsh/v1/app-version` | 返回最新版本信息；未配置 → **503**（fail-closed） |
| `GET /api/dsh/v1/app-latest.apk` | 流式返回 APK，支持 Range |

**为什么 503 而不是 404**：404 会让客户端以为「地址错了」，而这里表达的是「服务端还没配置分发」。

**为什么不走 file-ticket**：这是公开分发，不需要 48h 待激活 / 5h 窗口那套时效。
但鉴权仍走人类通道（会话 cookie）—— 与 `/files` 一致，不放公网脚本。

### 🔴 安全设计（三条硬约束）

1. **路径固定**：文件名是编译期常量（`APP_APK_NAME` / `APP_VERSION_NAME`），
   不接受任何用户输入参与拼接；不列目录。
2. **realpath 归属校验**：解析出的真实路径必须仍在 `appDistDir` 内 —— 防止 app 目录被
   symlink 到别处时读到任意文件。用 `path.relative` 而非 `startsWith`
   （后者会把 `/a/app-evil` 误判成 `/a/app` 的子路径）。
3. **大小上限**：读之前先 `stat`，超过 `appApkMaxMB`（默认 200）直接 413。
   APK 用 `createReadStream` 流式返回，不整份读进内存。

审计事件：`app-version`（ok/deny）与 `app-download`（ok/deny），均不含敏感信息。

### 配置项

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `appApkMaxMB` | `200` | APK 大小上限（MB）；`0` 表示不限制（不建议） |

### 实现时踩到的坑（已由测试抓到）

`readFileSync` 在本文件是**别名导入**（`readFileSync as _readFileSync`）。
直接写 `readFileSync(...)` 会 `ReferenceError`，表现为运行时 `503 app version unreadable`
——而文件明明存在。已统一改用别名，并加静态断言 `⑰` 防止再犯。

### 测试

- `test/_e2e-app-dist.mjs`（33 项）：版本正常/缺失/JSON 非法/缺必填字段；
  APK 下载 Content-Type 与字节一致 / Range 206 / 后缀 Range / 不存在 404 / 超限 413；
  鉴权三种情形；**symlink 逃逸必须 403 且不泄漏外部内容**。
- 静态断言 `⑪`–`⑰`：路径固定、realpath 校验、复用 `parseRangeHeader`、
  503 fail-closed、大小上限、人类通道归属、`_readFileSync` 别名。

改坏验证：去掉 realpath 校验 / 缺失时返回空 200 / 去掉大小上限 / 改回裸 `readFileSync`
—— **四条全部 FAIL**。

### curl 示例（假数据演示）

```bash
# 1) 查版本（需登录 cookie）
curl -s -b "dsh_postapi_session=<cookie>" \
  http://127.0.0.1:3080/api/dsh/v1/app-version

# 正常响应
# {"ok":true,"version":"0.1.1","code":2,"notes":"修复状态栏遮挡",
#  "publishedAt":1792658737107,"size":6452454,"sha256":"f6acbc9...",
#  "filename":"DSH-PostAPI-v0.1.1.apk","url":"/api/dsh/v1/app-latest.apk","apkReady":true}

# 未配置时
# {"ok":false,"error":"app distribution not configured"}   HTTP 503

# 2) 下载 APK（支持断点续传）
curl -s -b "dsh_postapi_session=<cookie>" \
  -H "Range: bytes=0-1023" \
  http://127.0.0.1:3080/api/dsh/v1/app-latest.apk -o part.bin
# 206，Content-Range: bytes 0-1023/<size>
```

_- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `1.3.0`。_

---

## 版本记录 v1.2.0（旧 WebView 兼容 polyfill）

### 背景

安卓 App（WebView）里报错：

```
AbortSignal.any is not a function
```

发生在「选择工作区目录」时。**该调用来自 DSH 官方客户端，不是本插件代码**：

```
packages/api/gateway/src/client/index.ts:480      AbortSignal.any([...])
packages/api/gateway/src/client/remote-events.ts:129
packages/api/gateway/src/client/remote-stream.ts:108
packages/api/gateway/src/index.ts:491 / 1146
```

官方客户端依赖的现代 API（按出现次数）：

| API | 次数 | 最低 Chrome |
| :--- | ---: | :--- |
| `AbortSignal.any` | 271 | 116 |
| `AbortSignal.timeout` | 60 | 103 |
| `.at()` | 44 | 92 |
| `replaceAll()` | 14 | 85 |
| `Promise.withResolvers` | 8 | 119 |

### 方案：客户端注入 polyfill

不能改官方源码，因此在 `lib/client.js` 的 **factory 最先几行**先把这些 API 补上，
让官方代码跑到时能正常工作。

**为什么必须放在 factory 顶层**：必须早于任何 DSH 代码调用这些 API。
factory 是插件模块入口，官方 UI bundle 的加载在其后，这是可用的最早时机。
放到 `useEffect`/`apply` 里就太晚了。

**全部带守卫**：已存在则不覆盖（Node 26 / 新 Chrome 的原生实现更好）。

### 各 polyfill 的实现要点

#### `AbortSignal.any(signals)` —— 最容易写错的一个

| 易错点 | 处理 |
| :--- | :--- |
| 入参里**已有** aborted 的 signal | **同步**立刻返回已 aborted 的结果，不等事件 |
| 空数组 | 永不 abort（不是立刻 abort），且不注册任何监听 |
| 重复触发 | 监听用 `{ once: true }` |
| 监听器泄漏 | 任一触发后**移除其余全部**监听器 |
| reason 透传 | 优先取入参 `signal.reason`；老环境无 `reason` 属性时退回 `AbortError` |
| 非可迭代输入 | 宽松按空处理（标准抛 TypeError，这里容错更安全） |

#### `AbortSignal.timeout(ms)`

- 超时后 abort，reason 为 `TimeoutError`（DOMException）；
- 非有限值/负数按 0 处理；
- 标准未提供取消接口，故不做清理。

#### `Promise.withResolvers()`

纯语法糖：`resolve`/`reject` 必须绑定到同一个 promise。

#### `Array.prototype.at()`

- 负索引从尾部数；越界返回 `undefined`；
- 索引用 `Math.trunc` 截断（小数 `1.9 → 1`），**不能用 `Math.floor`**（负数的 -0.5 会错成 -1）。

#### `String.prototype.replaceAll()`

- 字符串参数：替换**全部**（`split/join`，函数式替换则逐次 `indexOf`）；
- 正则参数：**必须带 `g`**，否则与标准一样抛 `TypeError`（不掩盖调用方 bug）；
- 空字符串的搜索值：按标准在每个字符间插入。

### 日志

补了才打，格式固定，F12 一眼可见：

```
[dsh-postapi-download] polyfill: AbortSignal.any
[dsh-postapi-download] polyfill: Promise.withResolvers
```

也可在控制台查 `window.__postapiPolyfilled`（本次补了哪些）。

> ⚠️ 这两条日志**刻意不走 dlLog**：polyfill 在 factory 最前面执行（早于 dlLog 定义），
> 且必须**无条件可见** —— 排查旧 WebView 兼容问题时，不应因本地把诊断开关设成 off 就看不到。
> `diagnostic-log-static` 里为此开了明确例外并写明理由。

### 测试（`test/polyfill.mjs`，14 项）

**关键难点**：Node 26 已原生支持全部这些 API，直接 import 会让守卫把 polyfill 全跳过，
等于什么都没测。做法是**每条用例先删掉原生实现**再重新求值 bundle，逼 polyfill 真安装。

覆盖：单 signal abort / 多 signal 第二个 abort / 空数组 / 已 aborted 入参 / reason 透传 /
监听器清理 / 不覆盖原生 / timeout 超时与未超时 / withResolvers 三件套 / `.at()` 正负索引与越界 /
`replaceAll` 字符串与正则（含不带 g 应抛错）/ 守卫与日志格式。

### 防回归（⑩ 系列）

```
⑩  polyfill 覆盖 5 个 API，且在 factory 顶层（早于 require(react)）
⑩b 每个 polyfill 都有「已存在则不覆盖」的守卫
⑩c 不得在 Node 环境炸（typeof 守卫 + try/catch 包裹）
⑩d AbortSignal.any 处理了已 aborted 入参（不能只 addEventListener）
```

_版本：`package.json` 与 `AUDIT_VERSION` 同步为 `1.2.0`。_

---

## 版本记录 v1.1.1（修复：抽屉遮罩用错 CSS 变量，打开后整页变白）

### 用户反馈

> 交付物文件抽屉打开后为什么背景变成白色了，不是透明

### 根因

遮罩用了 `--dsw-alias-bg-overlay`：

```css
.dsa-dl-mask { background: var(--dsw-alias-bg-overlay, rgba(0,0,0,.32)); }  /* ✗ */
```

而 `--dsw-alias-bg-overlay` 的官方语义是**「弹层/浮层自身的背景色」**——
不透明表面色（`design-platform.css:180` → `--dsw-static-neutral-bluish-150`，浅色主题下接近白色）。
拿它当遮罩 ⇒ 遮罩层是不透明白色 ⇒ 整个页面被盖住。

### 修法

| 元素 | 变量 | 浅色 | 深色 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `.dsa-dl-mask`（遮罩） | `--dsw-alias-bg-mask-1` | `rgba(0,0,0,.24)` | `rgba(0,0,0,.5)` | **半透明黑** + `backdrop-filter: blur(2px)` |
| `.dsa-dl-drawer`（抽屉） | `--dsw-alias-bg-layer-1` | 近白 | 近黑 | **不透明**层表面色 |

两个变量的定义见官方 `dsh-client-ui-theme/src/styles/design-platform.css:170/173`（浅色）与 `:270/273`（深色）。

**深色模式确认**：`bg-mask-1` 深浅色都是黑色半透明（0.24 / 0.5），不会出现纯白或纯黑。
兜底 `rgba(0,0,0,.24)` 在深色主题下若变量缺失会略淡，但仍是半透明黑，可接受。

### 防回归（⑨ 系列）

```
⑨  遮罩必须用 bg-mask-*（半透明），不得用 bg-overlay；兜底 alpha 必须在 (0,1) 开区间
⑨b 抽屉背景必须不透明（不得 transparent/none），且应使用 bg-layer-1
⑨c 遮罩与抽屉不得共用同一个背景变量（各司其职）
```

改坏验证：遮罩改回 `bg-overlay` / 抽屉设为 `transparent` / 兜底 alpha 改成 `1` /
两者共用变量 —— **四条全部 FAIL**。

_版本：`package.json` 与 `AUDIT_VERSION` 同步为 `1.1.1`。_

---

## 版本记录 v1.1.0（交付物入口改为「紧凑按钮 + 右侧抽屉」）

> 纯前端交互形态变更，**后端接口完全未动**。

### 形态演进（三轮，最终定稿）

| 版本 | 形态 | 问题 |
| :--- | :--- | :--- |
| v0.12.0 | 会话顶部**平铺面板** | 文件多/描述长时撑破聊天区 |
| v1.1.0 中途 | 聊天流内 turn 尾平铺卡片 | 同样占空间，且会话级清单会逐 turn 重复 |
| **v1.1.0 最终** | **紧凑按钮 + 右侧抽屉** | — |

用户原话驱动：
> 但是文字太长了，超出屏幕了，上面应该放按钮而不是一个框
> 应该一个按钮可以打开一个面板？

### 最终交互

```
会话顶部：[📎 交付物文件 (3)]        ← 紧凑按钮，N=0 时完全不渲染
              ↓ 点击
         ┌─────────────────────────────────┐
         │ 交付物文件 (3)              [✕] │
         ├─────────────────────────────────┤
         │ test-download.txt      909 B  [下载] │
         │ download-test-2026.md  722 B  [下载] │
         │ DSH-PostAPI.apk        6.1 MB [下载] │
         └─────────────────────────────────┘
```

- 挂载 `conversation.session.header.actions`（会话级信息放会话级位置）。
- 抽屉：**遮罩点击关闭 + ESC 关闭 + 关闭按钮**三件套；列表内部滚动，抽屉不超视口。
- 每行：文件名（ellipsis 截断）+ 大小 + 下载按钮；**description 只放 `title`**（hover 看全文），
  不进正文 —— 这是「文字太长超出屏幕」的根源。

### 🔴 为什么是抽屉而不是居中浮层

DSH 本身以**右侧 sidebar** 为组织骨架，抽屉从右侧滑出与之一致，且**不遮挡正文**；
居中浮层会盖住聊天内容，还要额外处理居中与尺寸自适应，收益为零。

### 🔴 修复：新文件不刷新页面看不到（用户实测）

**现象**：磁盘 3 个 present 事件，界面只显示 2 个，刷新后才看到第 3 个。

**根因**：组件只在挂载时取一次数，新事件到达后**不会再拉**。

**修法（三层）**：

1. **TTL 从 8s 缩到 3s** —— 被动兜底，用户可感知延迟上限；
2. **组件轮询** —— 抽屉未开 4s / 打开 2s，卸载即清 timer；
3. **`invalidateFilesCache(sessionId)` 主动失效** —— 拿到「有新事件」信号时立刻打掉缓存重拉。

**为什么不会打爆后端**：
- 每次轮询都先走 `loadSessionFiles`，**命中缓存不联网**；
- 多个组件共享同一 `sessionId` 缓存条目，不会 N 倍放大；
- 无 `sessionId` 不起轮询；组件卸载清理 timer。

实测效果：`2 → 新增 1 → 3`，最迟 4 秒内自动出现，无需刷新。

### 缓存机制

```js
filesCache: Map<"<apiPrefix>|<sessionId>", { at, promise }>
FILES_CACHE_TTL_MS = 3000
```

- 并发调用共享同一个 in-flight Promise（不会重复发）；
- **失败不缓存**（网络抖动/401 后下次渲染会重试，不会整会话永久空白）；
- 返回 `maxTurn` 供上层判断「有没有新事件」。

### 关于官方卡片为何不渲染（结论：不确定）

已查明的事实：
- `@deepseek-ai/dsh-client-ui-deliverables` **确实安装**在 `~/.dsh/profiles/node_modules/`；
- 它是 `@deepseek-ai/dsh-web-app` 的依赖，而 `dsh-web-app` 在 profile bundles 列表里；
- 其源码 `src/client/index.ts` / `Deliverables.tsx` 确实注册了 `conversation.chat.turnTail`。

**但「为什么浏览器里零个 `[data-presented-file]` 节点」，我没有把握给出结论。**
可能原因（未验证）：客户端 bundle 是否真的打包了该模块、是否被 profile 的精简配置裁掉、
或 `deliverablesDefinition` 未注册。**不编结论。**

我方 `slots.inject` 用的是自有 id（`dsh-postapi-bridge/files`）与独立 slot，
与官方 id（`@deepseek-ai/dsh-client-ui-deliverables`）不同，**不会覆盖官方注册**。

---

## 版本记录 v1.0.3（🔴 `listEvents` 不返回 `data` —— `files: []` 的根因）

> v1.0.2 让接口活了（200），但 `files` 恒为空。本版修掉最后一块。

### 铁证（官方类型定义）

`packages/session-query/session-query/src/types.ts:59`：

```ts
export interface SessionEventRecord {
  sessionId: SessionId
  seq: SessionSeq
  type: SessionEventType
  time: number
  surface: SessionEventSurface
}          // ← 没有 data 字段
```

官方注释（`session-query/src/index.ts:265`）：
> List **lightweight** raw-log event records for one logical session.

### 根因

```js
// 旧实现：从 listEvents 的记录里读 data
for (const r of records) {
  if (r.type !== 'deliverables/presented') continue
  const data = r.data                                  // ← 永远 undefined
  if (!data || !Array.isArray(data.files)) continue    // ← 永远 continue
}
```

⇒ `events` 恒为空 → 走「无交付物」分支 → **200 + `files: []`**。

### 修法：两段式（listEvents 取 seq → readEvent 取 data）

```
① sq.listEvents(sessionId)              → [{sessionId, seq, type, time, surface}]  无 data
② pickPresentedEvents(records)          → [{seq, type, time}]  只看 type/seq，按 seq 倒序
③ 对每个 seq: readPresentedEvent(...)   → 完整事件（window.target 带 data.files）
④ flattenPresentedFiles(hydrated)       → 候选条目
```

新增共用小函数 `readPresentedEvent(sessionId, seq)`，**清单端点与下载端点共用**，
保证两边对「事件长什么样」的理解一致（下载端点的 `readPresentedFile` 本就走这条路，一直是对的）。

**单条 readEvent 失败只跳过该条**（`skippedReasons['event-unreadable']++`），不整批失败 ——
与「单文件不合格只跳过」同一原则。并行发起 `Promise.all` 减少往返。

### 顺手的一处优化

原先为了取会话 `cwd` 会**额外多发一次** `readEvent` 探针。现在既然要逐个 readEvent 取 data，
`cwd` 直接从第一个成功的事件里取，少一次往返。

### 🔴 为什么测试没抓到（同一个教训的第二次）

**测试桩的 `listEvents` 返回了带 `data` 的完整事件 —— 与真实 API 不符。**
所以测试绿、线上空。

本版已把**所有桩**的 `listEvents` 改成只返回轻量记录（无 `data`），`readEvent` 返回完整事件。
改完后 e2e 依然全绿 ⇒ 证明代码确实走了 readEvent 路径，而不是碰巧从桩的 data 里读到。

### 防回归（G5–G8）

```
G5. pickPresentedEvents 的实现里不得出现 .data（它只该看 seq/type）
G6. handlePresentedList 必须逐个 readPresentedEvent，且不得把 records 直接喂给 flatten
G7. readPresentedEvent 存在、从 window.target 取完整事件、校验 data.files、有 event-unreadable 兜底
G8. 单条读取失败只跳过不整批失败（unreadable.count++ / continue / bump）
```

### 语义变更（已在测试名标注）

| 函数 | 旧语义 | 新语义 |
| :--- | :--- | :--- |
| `pickPresentedEvents` | 保留 `data.files` 合法的记录 | **只保留 `type` + 整数 `seq` 的记录**，无 `seq` 一律丢（无法 readEvent）|
| `flattenPresentedFiles` | 输入任意 | 输入必须是 **readEvent 拿到的完整事件**（含 data.files）|

_版本：`package.json` 与 `AUDIT_VERSION` 同步为 `1.0.3`。_

---

## 版本记录 v1.0.2（🔴 真正根因：`ctx.sessionQuery` 读取方式错误）

> **全天所有「400/500 空响应」的真正原因在这里。** 之前关于参数名、路径名、网关拦截的推测**全是误判**。

### 铁证（线上真实异常）

```
GET /api/dsh/v1/files?sessionId=<真实会话>
→ 500 {"ok":false,"error":"files list failed: cannot get property \"sessionQuery\" without inject"}
```

### 根因

```js
export const inject = ['webServer', 'agents', 'sessions']   // ← 不含 sessionQuery
```

cordis 规定：**访问未在 `inject` 里声明的服务属性会直接 throw**。所以这行"防御代码"**本身就会抛**：

```js
if (!ctx.sessionQuery || typeof ctx.sessionQuery.listEvents !== 'function') {  // ← throw 在这一行
  sendJson(res, 503, ...)
}
```

`!ctx.sessionQuery` 的**读取动作**就已经抛了，根本走不到判断。
**`/files`、`/file-ticket`、`/file/<token>` 三个端点的全部 sessionQuery 访问都有此问题。**

### 修法：`ctx.get('sessionQuery')`

cordis 官方提供安全探测（`vendor/cordis/lib/index.js:763`）：

```js
/**
 * Read a service from the store **without the inject requirement**.
 * @returns the service value, or `undefined` when not (yet) provided.
 */
get(name, strict = true) { ... }
```

新增 `sessionQueryOf(ctx)` 辅助函数，**所有**取用点改为经由它：

```js
function sessionQueryOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
  } catch { return undefined }
}
```

**不改 `inject`**（否则精简 profile 里整个插件不加载）。服务不存在时返回 `undefined`，
现有的 `if (!sq || typeof sq.listEvents !== 'function')` 判断即可正常工作。

### 为什么每次现取、不在 `apply()` 里缓存

`ctx.get(name)` 默认 strict 模式，**只返回「已激活」的服务**。若 `sessionQuery` 的激活时机
晚于本插件（cordis 里服务就绪顺序不保证），`apply` 时取到的会是 `undefined`，缓存下来就
**永久失效** —— 插件表面上"加载成功"，但所有下载端点永远 503。

现取能自然跟随服务上线；`ctx.get()` 本身极轻（一次属性查找），无性能顾虑。

### 为什么全套测试都没抓到（关键教训）

**测试桩的 ctx 是手工对象，`ctx.sessionQuery` 天然可读。** 生产环境的 cordis ctx 才会 throw。

新增 `test/inject-guard.mjs`（9 项）：桩 ctx 用 `Proxy` **模拟 cordis 语义** ——
读未 inject 的属性直接 throw `cannot get property "x" without inject`，
再验证三个端点在「sessionQuery 不存在」时返回 **503**（而非抛异常/500）。

### 防回归（G 系列静态断言）

```
G1. index.js 非注释代码中不得出现 ctx.sessionQuery（会 throw without inject）
G2. 所有 sessionQuery 取用都经由 sessionQueryOf(ctx)
G3. sessionQueryOf 有 try/catch 兜底（桩 ctx 实现差异也不冒泡成 500）
G4. inject 声明里**不**包含 sessionQuery（否则精简 profile 里整个插件不加载）
```

验收：`grep -c 'ctx.sessionQuery' lib/index.js` → **0**

### 更正：此前的误判

| 版本 | 当时的结论 | 实际 |
| :--- | :--- | :--- |
| v0.12.3 | `/presented` 与宿主 `present.open` **路径**冲突 | ❌ 路径无关；`/files` 改名无害但非根因 |
| v1.0.0 | `sessionId` **参数名**被网关保留 | ❌ 反了（被保留的是 `sid`）|
| v1.0.1 | 改回 `sessionId` | ✅ 参数名确实该用 `sessionId`，但**不是根因** |
| **v1.0.2** | — | ✅ **根因：`ctx.sessionQuery` 直接读属性会 throw** |

_版本：`package.json` 与 `AUDIT_VERSION` 同步为 `1.0.2`。_

---

## 版本记录 v1.0.1（更正 v1.0.0 的参数名错误：`sid` → `sessionId`）

> ⚠️ **v1.0.0 的破坏性变更是错的，本版改回来。**

### 错在哪

v1.0.0 声称「宿主网关拦截 `sessionId` query 参数」，于是把参数改成了 `sid`。
**恰恰相反 —— 被宿主保留的是 `sid`，不是 `sessionId`。**

### 实测判据（20261022，v1.0.0 线上，同一路径只换参数名，值均为真实会话 ID）

```
无参数               → 400 size=56  Missing required query param: sid   ✅ 进了 handler
?sid=<真实ID>        → 400 size=0                                        ❌ 没进 handler
?sessionId=<真实ID>  → 400 size=56  Missing required query param: sid   ✅ 进了 handler
?session=<真实ID>    → 400 size=56                                       ✅
?session_id=<真实ID> → 400 size=56                                       ✅
?id=<真实ID>         → 400 size=56                                       ✅
?q=<真实ID>          → 400 size=56                                       ✅
```

**决定性判据**：在 handler 入口加临时诊断日志，`?sid=` 时**零输出**（请求根本没进来），
其它参数名都有输出。⇒ `sid` 是宿主网关的**保留参数名**（网关拿它做自己的会话解析，
值不认识就直接返回空白 400），`sessionId` 不是保留名。

### 为什么 v1.0.0 会判反

当时看到 `?sessionId=x → 400 size=0` 就下了结论，但**那是 v0.12.x 时代的数据**：
那时 handler 用的正是 `sessionId`，请求**进了** handler，是内部 `listEvents` 抛异常导致空响应。
把「两个时期、两种原因」的现象混在了一起。

本版已一并查清：**handler 内部能完整跑完，不会抛异常**（见 `test/files-handler.mjs`）。

### 改动

| 项 | v1.0.0（错） | v1.0.1（正确） |
| :--- | :--- | :--- |
| query 参数 | `?sid=<id>` | **`?sessionId=<id>`** |
| 错误文案 | `Missing required query param: sid` | `... sessionId` |
| 前端 | `/files?sid=` | `/files?sessionId=` |
| body 字段 | `sessionId` | `sessionId`（不变，现在与 query 一致） |

### 新增测试：直接驱动 handler（`test/files-handler.mjs`，6 项）

回答「handler 到底能不能跑完」这个问题 —— 用桩 ctx + 真实形状记录 + 真实 HTTP：

```
✔ A. 缺 sessionId → 400 且 body 有明确文案（不是空响应）
✔ B. ?sid= 不被接受（证明参数名就是 sessionId）
✔ C. ?sessionId= → handler 完整跑完，返回 200 且带文件列表（核心）
✔ D. handler 没有抛异常（否则 catch 会返回 500）
```

**结论：`/files?sessionId=<真实会话>` 返回 200 + `ok:true` + 非空 `files` 数组，handler 不抛异常。**

### 防回归（⑧ 系列已反转）

```
⑧  必须用 queryOf(req, 'sessionId')，不得用保留名 'sid'
⑧b client.js 调 /files 必须用 sessionId 参数
⑧c 错误文案指向 sessionId（而非 sid）
⑧d body 字段也用 sessionId
```

改坏验证：把参数名换回 `sid` / 文案换回 `sid` / 前端换回 `sid`，三条断言**全部 FAIL**。

_版本：`package.json` 与 `AUDIT_VERSION` 同步为 `1.0.1`。_

---

## 版本记录 v1.0.0（🎉 首个正式版：公网文件下载 + 安卓登录 + 安全模型定型）

> 一句话：**DSH 的登录/网关插件正式进入 1.0** —— 公网可用的文件下载、安卓客户端 JSON 登录、
> 以及一套经过线上故障打磨的安全模型。

### 🔴 v1.0.0 的破坏性变更：query 参数 `sessionId` → `sid`

> ⛔ **本节已被 v1.0.1 更正：方向搞反了。被宿主保留的是 `sid`，不是 `sessionId`。**
> 参数已改回 `sessionId`，见上方 v1.0.1 章节。以下内容仅作历史记录。

**这是本次升 Major 的唯一原因。**

宿主的 API 网关会拦截**任何带 `sessionId` query 参数**的 `/api/*` 请求，直接返回**空白 400**
（无 body、无 content-type），请求根本到不了本插件的 handler。实测对照（同一条路径，只改参数名）：

```
GET /api/dsh/v1/files?a=1                       → 400, size=62  {"ok":false,"error":"Missing required query param: …"}  ✅ 到我们的 handler
GET /api/dsh/v1/files?q=1&w=2                   → 400, size=62  ✅
GET /api/dsh/v1/files?session=x                 → 400, size=62  ✅
GET /api/dsh/v1/files?session_id=x              → 400, size=62  ✅
GET /api/dsh/v1/files?id=x                      → 400, size=62  ✅
GET /api/dsh/v1/files?sessionId=x               → 400, size=0   ❌ 被宿主吃掉
GET /api/dsh/v1/files?sessionId=abc&sessionId=def → 400, size=0  ❌
```

**只有 `sessionId` 这个名字被拦。** 这是**参数名**层面的拦截，与路径无关。

| 项 | v0.12.x | v1.0.0 |
| :--- | :--- | :--- |
| 清单接口 query | `GET /files?sessionId=<sid>` | **`GET /files?sid=<sid>`** |
| 错误文案 | `Missing required query param: sessionId` | `... sid` |
| `POST /file-ticket` 的 **body** 字段 | `{ sessionId, seq, index }` | **保持不变**（body 不是 query，不受影响） |

> ⚠️ **v0.12.3 的更正**：当时把 `/presented` 改名 `/files`，以为是**路径**与宿主 `present.open` 冲突，
> 那是**误判**——真正原因是 `sessionId` **参数名**。`/files` 这个名字本身没问题，予以保留。

### 从 0.8.0 到 1.0.0 的能力汇总

#### ① 公网文件下载（v0.9.0 起，v0.12.0 落地前端）

| 接口 | 方法 | 鉴权 | 说明 |
| :--- | :--- | :--- | :--- |
| `/api/dsh/v1/files` | `GET` | 已登录（会话 cookie） | 列出会话内交付物元数据（查询参数 **`sid`**） |
| `/api/dsh/v1/file-ticket` | `POST` | 已登录（会话 cookie） | 为一条 present 记录签发票据（body 用 `sessionId`） |
| `/api/dsh/v1/file/<token>` | `GET` | 已登录 + 票据绑本人 | 流式下载，支持 Range 续传 |
| `/api/dsh/v1/dl/<token>` | `GET` | 已登录 + 票据绑本人（v1.5.0） | **直链下载**：纯时间窗（签发即起算，默认 48h）、不激活、不限次、支持 Range。卡片 `<a href>` 直接指向它 |

- **有效期**：签发票据后 48h 内「待激活」；**首次下载**即激活，此后 **5h 内不限次数**（含 Range 续传）；
  过期需重新签发。**过期的是票据，源文件永远不删不改。**
- **直链时效（v1.5.0 `/dl/<token>`）**：**签发即起算 48h**（`dlTicketHours`），不激活、不限次；
  过期 `410`，重开聊天界面即拿到新直链。**同样，过期的是链接，源文件永远不删不改。**
- **路径安全**：文件路径与会话 cwd **双向 `realpath`** 后判归属（不用字符串前缀，防符号链接逃逸）。
- **前端**：`PresentedFilesPanel` 自渲染文件列表 + 下载按钮（不依赖官方 `deliverables` 卡片——
  该卡片在部分环境不渲染）。日志前缀 `[dsh-postapi-download]`，可 `localStorage` 关闭。

#### ② 安卓客户端 JSON 登录（v0.8.0 起）

| 接口 | 方法 | 鉴权 | 说明 |
| :--- | :--- | :--- | :--- |
| `/api/dsh/v1/mobile-login` | `POST` | 免密（账号密码，按 IP 限流） | 返回 `launchUrl` + 会话 cookie |
| `/api/dsh/v1/client-log` | `POST` | **免鉴权**（五条限额 + 写盘前脱敏） | 客户端日志自动上报（v1.4.0）：环境快照 / 长任务 / 掉帧 / 错误 |

- 返回 `launchUrl = <scheme>://<host>/?token=<启动令牌>`，客户端持有 cookie 后 WebView 直接加载即可完成
  官方 `GET /?token=` 铸 cookie。
- 失败统一 `401 Invalid credentials`（账号不存在/密码错/被禁用**不区分**，防用户名枚举）。
- 按 IP 限流（5 次失败锁 10 分钟，与 step-up 共用计数）。

#### ③ 安全模型（v0.11.0 → v0.12.4 定型）

**指纹判定最终形态：**

```
UA 类别不匹配                              → 拒绝（mismatch，计 3 次吊销）
UA 类别匹配 + 哈希命中(当前或历史 N=3) + IP 匹配 → match（最强）
UA 类别匹配 + 哈希命中 + IP 漂移             → ip-drift（放行 + 审计）
UA 类别匹配 + 哈希未命中                     → ua-hash-drift（放行 + 审计，正常升级路径）
UA 类别为 'other'（bot/curl/空 UA）          → 拒绝
完全无指纹的老会话                          → 拒绝（legacy）
```

**为什么 IP 不再是硬门**（v0.12.2 方案 A）：移动网络换基站（`60.12` → `36.28` → `36.23`）
导致 IP 段天天变，硬绑定会永久误杀正常用户。IP 降级为软证据，只决定 `reason` 并留审计痕迹。

**为什么迁移不再降级指纹**（v0.12.4 修 H1）：老会话迁移原先只写 `bindUaClass`，
而新分支只比类别、永不读哈希 ⇒ 一次迁移把熵从 ≈2^57 永久降到 ≈2^2。现在迁移 = **刷新锁**
（同时刷新 `bindUaHash` 并把旧哈希推进 `bindUaHashHistory`），match 仍要求哈希命中。

**伪回环例外**：`socket` 回环但 `Host` 非回环（frp 直连）→ 强制 deny 语义，
否则任何拿到 cookie 的人都能借 frp 通道从任意位置通过。

#### ④ 已知取舍与边界

**cookie 被盗时，以下情况仍能挡住：**

1. **换设备类型** —— 桌面 cookie 拿到手机上（或反之）→ UA 类别不匹配 → 拒绝。
2. **脚本化盗用** —— `curl`/`python`/`bot`/空 UA 归 `other` → 拒绝。
3. **frp 直连等伪回环通道** —— 强制 deny 语义，IP 必须真匹配。
4. **高危操作** —— `stepupPaths` 内所有方法仍需当日密码铸出的 `dsh_stepup` cookie，
   与指纹**完全独立**。盗 cookie 无密码铸不出币。
5. **会话过期/吊销** —— HMAC 签名、24h 过期、滚动续期、用户禁用即清、连续 3 次**真实 UA 类**
   失配吊销，全部有效。
6. **审计留痕** —— `session-ip-drift` / `ua-hash-drift` 记录期望网段、实际 IP、UA 类别/哈希命中情况，
   同一 sessionId 短期大量漂移可人工介入。

**以下情况挡不住（如实说明）：**

- 拿到 cookie 且能伪造**同类型设备** UA 的盗用者，可在任意 IP 使用。
  这等价于「cookie 即凭据」，与业界主流会话模型一致。
- 想恢复「IP 不匹配即拒」的旧行为：配置 `ipDriftPolicy: 'deny'`（但移动用户体验会退化）。

#### ⑤ 配置项全览

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `downloadActivateWindowHours` | `48` | 票据「待激活」上限（自 `issuedAt` 起算） |
| `downloadSessionHours` | `5` | 首次下载后的可用窗口 |
| `downloadMaxMB` | `200` | 单文件下载上限（签发阶段即拒） |
| `ipDriftPolicy` | `allow` | `allow`=IP 漂移放行（默认）/ `deny`=旧行为 |
| `ipPrefixBits` | `16` | IP 指纹前缀位数 |
| `fingerprintWhitelist` | `[]` | CIDR 白名单（命中跳过指纹比对） |
| `machineLocalAllow` | `[]` | 回环可免 token 的机器通道子路径 |

### ⚠️ 已知事项

- **前端仍会强改 `connection.isLoopback`**（v0.10.0 兼容补丁）。风险取决于宿主实现，暂未处理。
- 人类通道端点（`/files`、`/file-ticket`、`/file/<token>`）**不做会话归属校验**：
  能登录的人可以为**自己能读到的任意会话**签发票据。见 v0.12.4 M6 说明。

_版本：`package.json` 与 `AUDIT_VERSION` 同步为 `1.0.0`。_

---

## 版本记录 v0.12.4（安全修复：迁移不再降级指纹强度 + deny 不再误吊销）

> 独立审查报告 6 项问题中的 H1/H2/M1/M6/T3/T4/T5 已全部处理。

### 🔴 H1：老会话迁移造成**永久**安全降级（最严重）

**问题**：v0.11.0～v0.12.3 的迁移只写 `bindUaClass`，而 `verifyFingerprint` 的新分支
**只比 `bindUaClass`、永远不再读 `bindUaHash`**。
⇒ 一次迁移就把「UA 逐字节哈希（≈2^57 熵）」**永久**换成「设备类别三选一（≈2^2 熵）」，不可逆。
攻击者拿老会话 cookie + 任意同类设备 UA，**一次请求**即可完成降级，此后长期有效。

**修法（哈希历史集合 N=3 + 迁移时刷新）**：

```
match 判据（v0.12.4）：
  UA 类别命中  且  哈希命中(当前 bindUaHash 或 bindUaHashHistory 中任一)  → match
  UA 类别命中  且  哈希未命中                                          → ua-hash-drift（放行 + 留痕）
  UA 类别不命中                                                        → mismatch（拒绝，计数）
```

迁移 = **把锁刷新到当前版本**，不是换成弱锁：
- `bindUaClass` 写当前类别；
- `bindUaHash` 刷成当前 UA 哈希；
- 旧哈希推进 `bindUaHashHistory`（最近 3 个，去重、新在前）。

**为什么用历史集合而不是「哈希必须严格等于当前值」**：后者会让 Edge 每次升级都掉到宽松路径，
迁移的总价值只剩"让哈希跟上一次"。历史集合让**刚升级过的正常用户仍命中历史 → 保持 match**，
既保留熵，又容忍版本漂移。N=3 的取舍：够容纳两轮连续升级，又不会让被盗 cookie 的可用窗口过长。

⚠️ **必然代价（如实说明）**：攻击者伪造**同类型设备**且哈希不在历史里的 UA，仍会走
`ua-hash-drift` 被放行。这条路径无法靠指纹区分「正常升级」与「同类型 UA 盗用」——
只能靠 `ua-hash-drift` 审计告警 + step-up 兜底。若某部署要更严，用 `ipDriftPolicy: deny`
会把 `ua-hash-drift` 一并按拒绝处理（但那种部署下的移动用户体验会退化回 v0.12.1 之前）。

### 🔴 H2：deny 策略下正常用户被吊销

**问题**：`ipDriftPolicy: 'deny'` 时返回 `reason: 'mismatch'`，被上层当真实失配 →
`recordMismatch` → **3 次吊销**。移动用户配了 deny 后当天就被踢。

**修法**：deny 场景改用**独立 reason `'ip-denied'`**，上层对该 reason **不计数、不吊销**，
只记审计（事件 `session-fingerprint-denied`）。真正的 UA 类失配仍返回 `mismatch` 并正常计数。

### 🟡 M1：README 里的过期安全断言

v0.11.0 章节的「IP 是硬前提」「不存在持续性放宽」两段已标注 **已被 v0.12.2 / v0.12.4 取代**，
并改写为当前实际行为（见本文档 v0.11.0 章节的删除线与注释）。

### 🟡 M6：`isRealpathInside(cwd, cwd)` 是空操作（假防护）

`isRealpathInside(p, p)` 恒为 true，只等价于「cwd 存在」。但注释写「只允许为自己拥有/参与的
会话签发」——**注释在骗人**。**已删除该假校验并如实注释**：

> 当前实际的安全前提：① 必须已登录；② 宿主 `sessionQuery` 自己的会话可见性/隔离
> （本插件不重复实现，也不假设其强度）；③ 文件路径必须落在该会话 cwd 之内。
> 即：**能登录的人可以为自己能读到的任意会话签发票据**。

留一个看起来在防护、实际没有的检查，比没有检查更危险（后人会信任它）。

### 🟢 T3/T4：修掉「永远为真」的静态断言

- **T3**（`ip-drift-static.mjs`）：原取块从 `event:` 行开始而非 `if` 行，只覆盖半个审计对象。
  改用**大括号配平**取块（`test/_static-helpers.mjs` 的 `blockOf`）。
- **T4**（`presented-list-static.mjs:140`）：原断言在整个文件里搜样式字面量，删掉样式也通过。
  改为「定位 `.dsa-pf-panel` 规则块 + 断言规则体内用语义 token + 面板样式区不得有裸 hex」。
- **新增 `test/_static-helpers.mjs`**：统一提供 `braceBlock` / `blockOf` / `codeOnly` / `lineNo`，
  避免各测试各自实现、各有偏差。

**这两项已按纪律验证「改坏代码会 FAIL」**（见提交说明的两次输出）。

### 🟢 T5：软断言改成确定值

`_e2e-mobile-login.mjs` 原用 `status === 503 || 401 || 405`（= 不是 200 就算过）。
该测试桩 `apiToken` 为空，确定应为 **503**，已改。

### 其他

- 清理 `human-auth-static.mjs` 里指向不存在符号的 `bounds` 常量。
- **IP 口径统一**：`getClientIp`（XFF **首跳**，客户端可伪造）已删除，全站统一用 `bindIpOf`
  （**末跳** = 离我们最近的受信代理所见地址）。
- `package.json` 新增 `"test": "node --test test/"`。

### ⚠️ 已知事项（未处理）

**前端仍会强改 `connection.isLoopback`**（v0.10.0 的兼容补丁）。其风险取决于宿主实现，
本轮未动，等确认宿主行为后单独处理。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.12.4`。

---

## 版本记录 v0.12.3（路径改名：`/presented` → `/files`）

> 一句话：交付物清单接口改名，**避开与宿主 `present.open` 路由的路径冲突**。

### 改名原因（实测证据）

v0.12.2 上线后用同一套参数（`?sessionId=...`）批量探测候选路径，行为分成两类：

```
GET  /api/dsh/v1/presented            → 400, size=0                      ❌ 被宿主吃掉
GET  /api/dsh/v1/presented?...&seq=1&index=0 → 400, size=0               ❌ 同样
POST /api/dsh/v1/presented            → 405 {"ok":false,"error":"Method Not Allowed, use GET"}  ✅ 我们的代码在响应
GET  /api/dsh/v1/health               → 200 size=205                     ✅
GET  /api/dsh/v1/present-list         → 405 size=51                      ✅ 到我们这里
GET  /api/dsh/v1/deliverables         → 405 size=51                      ✅
GET  /api/dsh/v1/present              → 405 size=51                      ✅
GET  /api/dsh/v1/presented-list       → 405 size=51                      ✅
```

只有 `/presented` 这个**精确路径**在 GET 时被拦下——连不存在的 `sessionId` 也返回 400，
说明请求根本没进本插件的 handler。宿主 `present-open.ts` 的 `handlePresentOpen` 对 GET 会校验
`sessionId + seq + index`，缺参数直接 `new Response('Invalid Presented file coordinates.', { status: 400 })`，
与观察到的裸 400 完全吻合。

### 改动

| 项 | 旧 | 新 |
| :--- | :--- | :--- |
| 清单接口 | `GET /api/dsh/v1/presented` | **`GET /api/dsh/v1/files`** |
| 审计事件 | `presented-list` | **`files-list`** |
| 错误文案 | `presented list disabled: ...` | `files list disabled: ...` |

- **不做 `/presented` 别名**：该路径已被宿主劫持，别名永远不会被调用，只是噪音。
- handler 函数名 `handlePresentedList` 保留（内部命名，不影响对外契约）。
- **失败日志新增请求 URL 输出**：`panel skip: http status=<n> url=<url>` ——
  端点被劫持/路径打错这类问题只能靠「打到了哪个路径」定位，本次改名正是靠它确认的。
- 新增 4 条防回归静态断言（`⑦/⑦b/⑦c/⑦d`），禁止再把 `/presented` 当路由使用。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.12.3`。

---

## 版本记录 v0.12.2（安全模型变更：IP 指纹从硬绑定降级为软证据）

> ⚠️ **这是刻意的安全模型变更，不是 bug 修复。请完整阅读「安全影响」一节再决定是否采用。**

### 现场

线上用户 cookie 绑定的会话：
```
ipPrefix: "60.12"      ← 签发时的网段
uaClass:  None         ← 老格式（只有 uaHash）
uaHash:   "a4bb48293c"
```
用户实际出口已变成 `36.28.x` → `36.23.x`（移动网络换基站）。
`ipOk = false` ⇒ `verifyFingerprint` 返回 mismatch ⇒ 面板/下载全 401。
v0.11.0 的惰性迁移救不了它，因为**迁移前提也是 `ipOk`**。

### 新规则（方案 A）

```
① UA 类别不匹配           → 拒绝（mismatch）
② UA 类别匹配 + IP 匹配   → 通过（match）
③ UA 类别匹配 + IP 不匹配 → 通过（ip-drift），但记审计、不计 mismatch、不吊销
④ UA 类别为 'other'       → 拒绝（bot/curl/空 UA 永远拒）
⑤ 老会话：先比原 UA 字节；字节漂移且类别可识别 → 迁移 + 按 ③ 放行（**不再要求 ipOk**）
⑥ 完全无指纹               → 拒绝（legacy）
```

**IP 不再是硬前提**，只决定 `reason` 是 `match` 还是 `ip-drift`（后者留痕）。
**UA 设备类别成为唯一硬门**：mobile/desktop/tablet 互不通用，`other` 一律拒。

### 🔴 安全影响（必读）

| | 变更前 | 变更后 |
| :--- | :--- | :--- |
| cookie 被盗 + 异地使用 | ❌ 被拦（IP 不符） | ✅ **可用**（同类型设备即可，记 `session-ip-drift` 审计） |
| cookie 被盗 + 换设备类型 | ❌ 被拦 | ❌ 仍被拦（UA 类别硬门） |
| cookie 被盗 + 脚本(curl/bot) | ❌ 被拦 | ❌ 仍被拦（`other` 一律拒） |
| 正常用户移动网络换基站 | ❌ **天天误杀**（本次要解决的问题） | ✅ 放行并留痕 |
| 高危操作（配置面/导出等） | 需 step-up 输密码 | ****仍**需 step-up 输密码**（独立门槛，未削弱） |

**仍然挡得住的情况**（cookie 泄露后）：

1. **换设备类型的盗用** —— 桌面 cookie 拿到手机上用、或反过来，UA 类别不匹配 → 拒。
2. **脚本化盗用** —— `curl`/`python`/`bot`/空 UA 全部归 `other` → 拒。
3. **高危操作** —— `stepupPaths` 内的所有方法仍要求当日密码铸出的 `dsh_stepup` cookie，
   与指纹**完全独立**，不受本次变更影响。被盗 cookie 无密码无法铸币。
4. **会话本身的有效期与吊销** —— HMAC 签名、24h 过期、滚动续期、用户禁用即清会话均不变；
   连续 3 次**真实 UA 类**失配仍会吊销会话。
5. **审计留痕** —— 每次 IP 漂移都记 `session-ip-drift`（含期望网段、实际 IP、UA 类别）。
   同一 sessionId 短期内大量漂移可人工介入排查。

### ⚠️ 伪回环例外（frp 直连场景仍硬拒）

`socket` 是回环地址、但 `Host` 不是回环（典型：公网 53xxx 端口经 frp 转发到 `127.0.0.1:3080`）
的请求**不是**本机用户，**不适用 ip-drift 放宽**：
- 这类请求的 IP 必然「不匹配」，若按 ip-drift 处理，等于任何拿到 cookie 的人都能借 frp 通道通过；
- 故伪回环一律按 `deny` 语义处理（IP 必须真匹配），且不触发老会话迁移。

这是 `isStrictLoopback`（socket + Host 双回环）的补充，不是替代。

**不再挡得住的情况**：拿到 cookie 的盗用者，只要伪造出**同类型设备**的 UA，就能在任意 IP 使用。
这等价于「cookie 即凭据」——与业界主流（Bearer token / 会话 cookie）模型一致。

### 想恢复旧行为

配置 `ipDriftPolicy: 'deny'` 即可回到「IP 不匹配即拒」（无需改代码）。
默认值必须是 `allow` —— 那正是本次变更的目的。

```yaml
# 某台机器想收紧时：
ipDriftPolicy: deny
```

### 实现要点

- `verifyFingerprint` 新增第 6 参 `ipDriftPolicy`；返回值新增 `reason: 'ip-drift'` /
  `'legacy-migrated-ip-drift'`（后者表示「老会话迁移 + IP 漂移」，日志一眼可辨）。
- `findSessionVerified` 对 ip-drift 写 `session-ip-drift` 审计，**不走 `recordMismatch`**
  （`verdict.ok === true` 结构上就到不了吊销路径）。
- **deny 策略下拒绝时不做迁移**：先判是否允许放行，再决定要不要迁移 — 否则"拒绝的同时改写了
  用户状态"，`deny` 就不等于旧行为了。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.12.2`。

---

## 版本记录 v0.12.1（修复：人类通道端点被机器通道鉴权挡住 → 401）

> 一句话：**`/presented`、`/file-ticket`、`/file/<token>` 改认会话 cookie，不再要求 machine token。**

### 线上症状

浏览器 Console：
```
[info]    panel slot: conversation.session.header.actions     ✅ 注册成功
[info]    panel mounted sessionId=session-f87db760-...        ✅ 组件挂载
[warning] panel skip: http status=401
[warning] panel skip body={"ok":false,"error":"Unauthorized: local task requires machineLocalAllow entry or Bearer token"}
```

### 根因（设计错误，非 bug）

这三个端点原先都注册在 `handleApiBridge` 里，**沿用了机器通道判定**：
- 非回环 → 要求 `Authorization: Bearer <apiToken>`
- 回环但不在 `machineLocalAllow` 白名单 → 同样要求 Bearer

但它们是给**已登录的人类用户**用的：浏览器同源 `fetch` 带的是会话 cookie
（`dsh_postapi_session`），**从不带 Bearer** ⇒ 必然 401。

### 修法：人类通道分流

在 `handleApiBridge` 的 `if (!apiToken)` fail-fast 与 `if (!isLoopback)` 判定**之前**，
把三条路径分流为「人类通道」：

| 端点 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/file-ticket` | `POST` | 签发票据 |
| `/presented` | `GET` | 交付物清单 |
| `/file/<token>` | `GET` | 下载（票据验签 + 绑定 uid + 会话 cookie 三层，与 machine token 无关） |

鉴权来源（浏览器路径优先）：
1. **有效会话 cookie** —— `findSessionVerified`（签名 + 指纹 + 用户启用 + 滚动续期）
2. **回环 + 正确 Bearer apiToken** —— 仅严格回环可用，方便本地 curl/脚本调试
   - 非回环即使带 token 也**不放行**（避免把人类端点的鉴权面扩到公网脚本；脚本请用 `/task`）
   - `/file/<token>` **不提供**此兜底（票据绑真实 uid，伪身份无意义且扩大鉴权面）
3. 两条都不满足 → `401`（fail-closed），并记 `human-endpoint-denied` 审计

**`/task`、`/health` 的机器通道语义完全不变**（`/health` 仍免鉴权）。

### 两个实现细节（都源于实测踩坑）

1. **handler 不再自己 `findSessionVerified`**：改为接收分流传入的 `session`。
   若让 handler 再查一次，`findSessionVerified` 里的指纹比对失败会计入 mismatch 计数，
   连续 3 次即吊销会话 —— 正常用户会被莫名踢掉。现在每个 handler 内该方法**只出现一次**
   （静态断言守护）。
2. **请求体在分流内自行解析**：该分流位于 `handleApiBridge` 顶部统一 `readJson` **之前**，
   外层 `body` 此时尚未声明（直接用会撞 TDZ 的 `ReferenceError`）。
   且 `Request` 是可读流、只能消费一次，故在分流内 `readJson` 后传入。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.12.1`。

---

## 版本记录 v0.12.0（绕开官方卡片，自渲染交付物面板）

> 一句话：官方 deliverables 文件卡片在本环境**不渲染**，本版改为**自己拉清单、自己画**，
> 不再依赖官方卡片是否存在。

### 为什么要绕开官方卡片

用 Playwright + chromium 实测确认：

| 检查项 | 结果 |
| :--- | :--- |
| 插件 client 加载 | ✅ Console 有 `[dsh-postapi-download] slot registered: deliverables.file.actions` |
| 页面 `[data-presented-file]` 节点 | ❌ **零个**（滚到底也没有） |
| 服务端会话日志里的 present 事件 | ✅ 确实存在（`seq:1781`、`seq:2365`） |

根因在官方：`turn-deliverables.ts` 的 `presentedForClosing` 从
`turn.data.get('deliverables')?.presented` 取数，而客户端 projection 没把这个 turn 的
present 数据投出来 —— 官方卡片因此没有数据可渲染。**这部分不在本插件可修范围**，
故改为自渲染（方案 A）。

### ① 新增接口 `GET /api/dsh/v1/presented?sessionId=<sid>`

- **鉴权**：必须已登录（复用 `findSessionVerified`），会话归属判据与 `file-ticket` 一致。
- **数据源**：`ctx.sessionQuery.listEvents(sessionId)`（官方公开接口，返回会话全部事件），
  筛 `type === 'deliverables/presented'`，按 `seq` **倒序**（最新交付在最前）。
- **不签发票据**：列表只返回元数据，用户点下载时才走 `file-ticket`。
  这样「48h 待激活 + 首下起 5h」的票据规则**零改动**。
- **返回**：
  ```json
  {
    "ok": true,
    "sessionId": "...",
    "files": [{
      "seq": 1781, "index": 0, "turn": 33, "time": 1792636949516,
      "path": "/main/app/.../test-download.txt",
      "name": "test-download.txt", "description": "...", "size": 909,
      "ticketUrl": "/api/dsh/v1/file-ticket"
    }],
    "skipped": 4,
    "skippedReasons": { "path-escape": 3, "path-not-file": 1 }
  }
  ```
- **逐条校验，逐条跳过**：与下载端点同口径（`realpath` 双向归属、必须是普通文件、
  `size ≤ downloadMaxMB`）。**单条不合格只跳过该条**并在 `skippedReasons` 记原因，
  不让整张列表变空（一个文件被删不该拖垮整个面板）。
- **状态码**：`401` 未登录 / `400` 缺 sessionId / `404` 会话不存在 /
  `403` 会话工作区不可用 / `503` sessionQuery 缺失（fail-closed，与下载端点一致）。
- **审计**：`presented-list`（记 sid / 事件数 / 候选数 / 文件数 / skipped / 原因摘要），**不记 token**。

### ② client 侧：自渲染面板

- 新增 `PresentedFilesPanel`：拉上面的接口，渲染 `图标 + 文件名 + 描述 · 大小 + 下载按钮`。
- 注入点：`conversation.session.header.actions`（`scope: 'session'`，会话头部）。
  > ⚠️ **没有用 `conversation.chat.turnTail`**：那个 slot 是**逐 turn** 渲染的，
  > 而本面板展示的是整个会话的清单 —— 放进去会让同一列表在每一轮回答后重复出现 N 次。
  > 交付物清单天然是会话级信息。
- `DownloadFileAction` 改造：**支持直接接收坐标**（`props.coordinate = {sessionId, seq, index}`），
  不再强制解析官方 `actionUrl`。判定顺序「显式坐标 > actionUrl 解析」，两条路径共用同一套
  下载逻辑（调 file-ticket → 同源校验 → `<a download>`），不产生分叉。
- 旧的 `deliverables.file.actions` 注入**保留**：万一某环境官方卡片正常，双保险。
- 日志（前缀仍是 `[dsh-postapi-download]`）：`panel slot: ...` / `panel mounted` /
  `panel fetched n=<n> skipped=<n>` / `panel skip: <原因>` / `panel: no slot available`。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.12.0`。

---

## 版本记录 v0.11.1（诊断日志：区分「按钮没渲染」与「渲染了但官方提示也在」）

> 一句话：**纯诊断增强，不改任何行为**。给线上「文件资源不可用」这类反馈提供可判定的证据。

### 为什么需要

官方 `presented.unavailable`（「此主机没有可用的桌面…」）在**没有桌面环境的服务器**上是常态，
它只影响官方 open/reveal，**与下载无关**。但用户看到这条提示时，无法区分两种截然不同的情况：

| 情况 | 实际状态 | 用户看到 |
| :--- | :--- | :--- |
| **A** | 下载按钮在，官方提示也在 | 提示 + 下载按钮（功能正常，只是文案误导） |
| **B** | 下载按钮根本没渲染 | 只有提示，没有下载按钮 |

两者 UI 表现接近，**此前没有任何手段区分**。本版加日志补上这个观测点。

### ① client 侧（`lib/client.js`）

统一前缀 `[dsh-postapi-download]`，默认**开启**，可关闭：
```js
localStorage.setItem('dsh-postapi-download-log', 'off')   // 刷新后生效
```

| 日志 | 含义 |
| :--- | :--- |
| `slot registered: deliverables.file.actions` | 我们的贡献已进入官方 slot 表 |
| `action mounted url=<actionUrl> parsed=ok` | **按钮组件已挂载且坐标解析成功 → A 情况** |
| `action mounted url=<actionUrl> parsed=fail` + `skip: cannot parse actionUrl <原值>` | **B 情况主因**：官方 actionUrl 形态不符或未传 |
| `click -> POST .../file-ticket {...}` | 用户真的点到了 |
| `fail status=<n>` / `fail body=<前300字符>` | 后端拒绝，含原因 |
| `issued, navigating to /api/dsh/v1/file/ab12****…cdef` | 签发成功（token 已脱敏） |

> 🔒 **日志永不打印完整 token**：`maskDownloadUrl()` 只保留 path 前缀与 token 前后各 4 位，
> 中间用 `*` 填满；解析失败时输出固定占位 `<unparsable-url>` 而非原串。

### ② host 侧（`lib/index.js`）

插件 apply 时输出一条启动自检，让「下载能力是否就绪」在重启后第一眼可见：
```
[postapi-download] ready: sessionQuery=available maxMB=200 activateHours=48 sessionHours=5 ticketStore=ok
```
`sessionQuery=MISSING` 时额外告警 —— 此时下载端点会返回 503，
而此前**只有真发一次请求才知道**，运维完全无感。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.11.1`。

---

## 版本记录 v0.11.0（老会话 UA 指纹惰性迁移 + 失配日志拆分）

> 一句话：**修掉「手机端被反复踢下线、上传被拦」的线上故障**，并让指纹失配日志能区分是 IP 还是 UA 出问题。

### 故障与根因

20261022 线上：手机 Edge 上传图片被拒。审计日志里该会话只有 `expectUaHash`、没有
`expectUaClass` ⇒ 属于 **v0.6.3 之前签发的老格式会话**，走的是 UA **逐字节哈希**比对。
而手机浏览器 UA 必然漂移（Edge/Chrome 版本升级、系统更新、WebView↔App 浏览器），
逐字节比 ⇒ 必然失配 ⇒ 被踢 ⇒ 用户侧表现为「上传被拦」。

v0.6.3 已认定「字节比对会误杀手机」，但**只对之后签发的新会话生效**，
老会话永远卡在旧分支上 —— 本次补上迁移路径。

### ① 老会话惰性迁移

`verifyFingerprint` 对「有 `bindUaHash`、无 `bindUaClass`」的老会话，按以下顺序处理：

```
step1  UA 逐字节哈希仍匹配        → match（行为与此前完全一致，零回归）
step2  字节已漂移，且 ipOk        → 判定 UA 设备类别：
         · 类别可识别(desktop/mobile/tablet) → 放行，reason=legacy-migrated
                                              并把 bindUaClass 落盘（迁移）
         · 类别为 other(bot/curl/空 UA)     → 拒绝，不迁移
step3  IP 不匹配                  → 拒绝（mismatch），不迁移
```

- 新增 `sessionsStore.migrateUaClass(sessionId, uaClass)`（`lib/users-store.js`）：
  写入 `bindUaClass` 并 `persist()`。**这是本次唯一改动 `users-store.js` 的地方**，其余不动。
- 新增审计事件 `session-ua-class-migrated`（记 sid / uaClass / 原 bindUaHash）。
- **一次性语义**：迁移后会话已带 `bindUaClass`，此后走新分支（只比设备类别），
  不再经过迁移逻辑，**不会形成持续放宽**。

### ② 失配日志拆分

`verifyFingerprint` 返回值新增 `ipOk` / `uaOk` / `uaClassExpected` / `uaClassActual`，
`session-fingerprint-mismatch` 审计据此补充同名字段 —— 此前只有笼统 `outcome`，
排查时无法判断是哪一侧失配，只能猜：

| 字段组合 | 含义 |
| :--- | :--- |
| `ipOk=false` | 换了网络/出口 IP —— 可能是移动网络切基站，也可能是 cookie 被盗用 |
| `ipOk=true, uaOk=false` | UA 漂移 —— 老会话常见，正是本次迁移要解决的场景 |

**既有字段 `expectPrefix` / `expectUaHash` 保持原样未动**（append-only，不破坏已有日志消费）。

### ③ 顺带修复：`uaDeviceClass` 空 UA 归类

注释写的是「BOT/**空值**归为 other」，实现里空串却一路走到 `return 'desktop'`。
这会让「无 UA 的脚本请求」被当成桌面设备 —— 在本次迁移逻辑里尤其危险：
等于给任何裸 HTTP 客户端做永久放宽。已修：`s.trim().length === 0` → `'other'`。

### 迁移的安全边界

> 🔴 **以下两段已被 v0.12.2 / v0.12.4 取代，保留仅作历史记录。当前行为见「版本记录 v0.12.4」。**

**当时（v0.11.0）的规则：**

1. ~~**IP 段必须匹配**（`ipOk`）—— IP 是硬前提~~ → **已被 v0.12.2 取代**：IP 降级为软证据，
   只决定 `reason` 是 `match` 还是 `ip-drift`，不再一票否决（移动网络换基站会误杀）。
2. **UA 设备类别必须可识别**（非 `other`）—— bot/curl/空 UA 一律拒绝且不迁移。
   → **仍然有效**，且 v0.12.4 后将 `other` 判断提为显式分支，更严格。
3. **只对老格式会话生效**（有 `bindUaHash`、无 `bindUaClass`）—— 新会话完全不受影响。
   → **仍然有效**。

**当时写的「不存在持续性放宽」也已不准确** → **已被 v0.12.4 取代**：
- v0.11.0～v0.12.3 的迁移**只写 `bindUaClass`**，而新分支只比类别、永不读哈希 ——
  一次迁移就把「逐字节哈希(≈2^57 熵)」**永久**换成「设备类别三选一(≈2^2 熵)」，
  且不可逆。这正是审查发现的 **H1**。
- v0.12.4 起：迁移 = **把锁刷新到当前版本**（同时刷新 `bindUaHash` 并把旧哈希推进
  `bindUaHashHistory`，N=3），match 判定要求「类别命中 **且** 哈希命中（当前或历史）」——
  熵不降级。UA 版本升级导致的哈希变化走独立 reason `ua-hash-drift`（放行但留痕），
  不再无痕地混进 `ip-drift`。

- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.11.0`。

---

## 版本记录 v0.10.0（交付物卡片下载按钮）

> 一句话：**在聊天里的交付物文件卡片上点一下就下载**，不用再手工 copy 路径去蹭接口。

- **新增前端贡献 `deliverables.file.actions`**（官方 slot，`kind: 'list'` / `scope: 'session'`）。
  这个 slot 由官方 `ui-deliverables` 在 `Deliverables.tsx` 里 `renderSlot`，
  渲染进 `PresentedFileCard` 的 actions 区 —— 也就是每张文件卡片的右侧按钮位。
  本插件以 `id: 'postapi-bridge'` 注册一个「下载」按钮，与官方 `ui-open-in-app`
  的 open/reveal 并排（本按钮 `order: 10`，排在它们之后）。
  - **按钮行为**：点击 → 从 `owner.actionUrl` 反解 `{ sessionId, seq, index }`
    → `POST <apiPrefix>/file-ticket`（`credentials: 'same-origin'`）
    → 200 拿 `url` → 用隐藏 `<a download>` 触发浏览器下载。
  - **为什么不用 `window.location.href = url`**（三层理由，写在代码注释里）：
    ① 不打断当前会话页面（SPA 状态、滚动位置、正在流式输出的回复都保留）；
    ② 不污染浏览器历史 —— 那个 url 里的 token 是 bearer 式凭据，
       留在地址栏/历史里本身就是泄露面；
    ③ `download` 属性让浏览器走下载通道而非就地打开，
       文件名由后端的 `Content-Disposition`（RFC 5987）决定，中文名不乱码。
  - **状态与边界**（全部 inline，不弹窗、不 alert）：

    | 情形 | 表现 |
    | :--- | :--- |
    | 请求中 | 按钮 disabled + 转圈 +「准备中…」 |
    | 官方 open/reveal 在途（`owner.pending`） | 一并 disabled（避免「点了没反应」式连点） |
    | 连点 | 在途直接吞掉（`useRef` 同步标志，不是 state —— state 异步生效会漏一帧） |
    | 401 / 403 | 按钮原地变红：「请先登录」 |
    | 410 | 「链接已过期，请重新打开」 |
    | 503 | 「下载服务不可用」 |
    | 413 | 「文件超出下载上限」 |
    | 其它失败 / 断网 | 「下载失败」 |
    | 错误态 | 4 秒后自动回到「下载」（可立即重试） |

  - **依赖契约（隐性依赖，升级 DSH 后按钮消失先查这里）**：
    `owner` 里**没有 `sessionId`**，只有 `actionUrl`；后端坐标要从这个 URL 反解。
    该 URL 形态来自官方 `presented.ts` 的 `presentedFileUrl()`：

```
present/open?sessionId=<sid>&seq=<n>&index=<i>
```

    本插件用 `new URL(actionUrl, location.origin)` 解析（**不用字符串 split**），
    并校验 pathname 为 `/present/open`、`seq`/`index` 为 ≥0 的十进制安全整数、
    `sessionId` 非空、同源。**官方一旦改这个 URL 形态，本按钮会静默不显示**。

- **按钮在什么情况下会静默不显示（这是设计，不是 bug）**：

  | 触发条件 | 为什么这样设计 |
  | :--- | :--- |
  | `actionUrl` 解析失败（缺参、非法 seq/index、路径不符、跨来源、非法编码） | 宁可少一个按钮，也不发一个必然失败的请求；更不能因为本插件让官方卡片渲染崩掉 |
  | `actionUrl` 不是字符串 / 为空 | 同上（官方 slot owner 异常时的兜底） |
  | 非浏览器环境且拿不到 `location.origin` | 无从解析基准 |
  | 官方 `ui-deliverables` 未装配（slot 未声明） | `ctx.slots.inject` 会等声明出现才注册；槽不存在就没有挂载点 |
  | 本插件 client 注册抛错 | 注册块外包了 `try/catch`：下载按钮是锦上添花，绝不允许它连累「账号管理」面板或整个 client 插件 |
  | 用户未登录 | 按钮**仍然显示**（点击后才提示「请先登录」）—— 保留可知性，避免「有时有按钮有时没有」的困惑 |

  > 为了让「无声消失」不至于变成无解谜题：解析失败时会在控制台打**一次**告警
  > （模块级 once 标志，不按卡片数刷屏），直接说明「官方 actionUrl 形态不符预期」
  > 并附上实际收到的值。

- **为什么 `available` 不参与判断**：官方 owner 的 `available` 表示「宿主桌面是否可用」
  （open/reveal 需要在本机桌面打开）。下载只是普通 HTTP GET，手机/平板/远程浏览器
  都能下，因此**不看**这一位 —— 否则手机端会看不到下载按钮。
- **安全**：下载地址由后端签发，仍走完整的服务端校验（票据验签 → 时效 → 登录态 →
  uid 绑定 → present 记录 → realpath 归属 → 大小上限）。
  前端额外做一道**下发 url 的同源校验**才交给浏览器，防后端若被改为返回外部地址时
  变成开放重定向。**不新增任何鉴权口径、不放宽任何既有规则。**
- **样式**：沿用 `client.js` 既有的 `dsa-*` 命名与 Apple 风格；尺寸（24px 高、0.5px 描边、
  11px 字）对齐官方 `ui-open-in-app` 的文件操作按钮，因为它俩坐在同一处 actions 区里。
  颜色走官方 `--dsw-alias-*` 语义 token（**暗黑模式自动跟随**，无需额外适配规则）；
  转圈动画尊重 `prefers-reduced-motion`。
- **测试**（新增两份，均不启动服务、不碰浏览器）：
  - `test/download-button.mjs`：actionUrl 解析纯函数（正常形态 / 缺参 / 非法 seq /
    空串 / 非字符串 / 无 origin / 纯函数性 / 边界值）+ 错误文案映射。
  - `test/download-button-static.mjs`：静态断言（slot 名与注册方式、注册块在 try 内、
    `credentials: 'same-origin'`、无 alert / 无 `window.open` / 无 location 赋值、
    `<a download>` 实现、`new URL` 而非 split、解析失败 return null、在途防抖用 ref、
    inline 失败态、同源校验、依赖契约注释存在、样式 token、版本号同步）。
  - 被测代码是**线上那一份** `lib/client.js`，经 `test/client-bundle-loader.mjs`
    用最小 shim 求值 —— 不是复制品（复制品必然漂移，测了等于没测）。
- **没有改的东西**：官方源码（只读）、后端逻辑（`handleFileTicket` /
  `handleFileDownload` / 状态机 / 11 步校验全部原样）、不重启服务。
- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.10.0`。

---

## 版本记录 v0.8.0（安卓客户端 JSON 登录）

- **新增机器通道端点 `POST /api/dsh/v1/mobile-login`**：面向安卓客户端（DSH PostAPI）的
  **可编程 JSON 登录**入口。客户端无法提交 HTML 表单，也不能自己从启动日志里捞 token，
  该端点把「账号密码 → 可加载的 URL + 插件会话 cookie」一步备齐。
- **请求**（JSON）：
  ```json
  { "username": "<用户名>", "password": "<密码>", "scheme": "https", "host": "可选，客户端期望的 authority" }
  ```
  `scheme` 可选（缺省按 `X-Forwarded-Proto`，再缺省 `https`）；`host` 可选
  （缺省按 `X-Forwarded-Host` → `Host` → `localhost`）。两者均做白名单校验，
  非法一律 `400`（防注入/SSRF）。
- **成功 `200`**：
  ```json
  {
    "ok": true,
    "username": "<用户名>",
    "role": "<role>",
    "launchUrl": "https://<host>/?token=<启动令牌>",
    "sessionCookie": { "name": "dsh_postapi_session", "value": "<签名后的会话 cookie>", "maxAgeSeconds": 86400 },
    "expiresAt": 1700000000000
  }
  ```
  客户端用法：先把 `sessionCookie` 写入 WebView 的 CookieManager，再 `loadUrl(launchUrl)` ——
  `launchUrl` 是 DSH **官方门禁唯一认的 `GET /?token=xxx`**，由宿主完成官方签名 cookie 的铸造。
- **失败**：`400` 缺字段 / 非法 host·scheme；`401 Invalid credentials`（**账号不存在、密码错、
  被禁用一律同一响应，防用户名枚举**）；`429` 按 IP 限流；`503` 读不到启动令牌。
- **鉴权与限流**：该端点**不要求 Bearer token**（它是登录入口本身），因此必须在
  `handleApiBridge` 的 token 校验**之前**分流白名单放行；安全性由**按 IP 限流**兜底 ——
  复用 step-up 的既有机制（`stepupFails`，5 次失败锁 10 分钟，与 stepup 合并计数）。
  放行条件严格限定 `method === 'POST' && subPath === '/mobile-login'`，其它路径与方法
  保持原有的 fail-closed 语义。
- **审计**：`mobile-login-ok` / `mobile-login-failed` / `mobile-login-throttled`，
  **不记录密码**，也不记录返回的会话 cookie 值。
- 版本号：`package.json` 与 `AUDIT_VERSION` 同步为 `0.8.0`。
- **0.8.1 补丁**：移除 `handleMobileLogin` 末尾仅供测试用的 `return { sessionId, session }`
  （返回语义应只有 HTTP 响应体一种）；e2e 自测改为从响应里的 `sessionCookie.value`
  用同一 secret 验签反查 sid 再断言落库，测试不再依赖实现内部返回值。

---

## 版本记录 v0.7.0（20261021，适配 DSH 0.2.x / 登录入口行为修正）

- **`/login` 已登录直通**：已持有有效会话访问 `/login` 时，直接 `302` 回使用页（带最新启动 token
  以补齐原生 BrowserAuth cookie），不再重复展示登录表单。校验复用 `findSessionVerified`
  （含指纹/过期/用户禁用检查），**不使用「cookie 是否存在」的弱判断**。
- **文档更正**：明确「未登录自动跳转」在 DSH 0.2.x 上已不适用，改为**请直接访问 `/login`**；
  给出反向代理层实现方案。详见「⚠️ 使用方式」章节。
- **兼容性声明**：新增 `engines.dsh` 与 `dsh.compatibility.dshReleases`，声明对 DSH
  `>=0.2.0-rc.1 <0.3.0-0` 的支持（本机 0.2.1-rc.2 实测装配通过）。
- 移除 `cordis.patch.yml` 中失效的 `webauth` disabled 补丁（宿主 0.2.x 已无该 entry）。

---

## 版本记录 v0.6.4（20260902，机器通道安全加固·PLAN-SEC02 P1-急）

- **机器通道 fail-closed**：/api/dsh/v1/* 非本地(严格双回环之外)请求一律要求 Bearer/X-Gateway-Token；
  apiToken 为空也拒绝——杜绝「token 未配 → 全网可 RCE」的 fail-open。
- **严格回环判定 isStrictLoopback**：socket+Host 双回环，绝不经 X-Forwarded-For
  —— 伪造 XFF:127.0.0.1 与 frp 直连(socket=127,Host=公网)均无法蒙混免 token；
  verifyFingerprint / handleApiBridge / handleAdminUsers 三处统一。
- **/health 白名单免 token**：健康探测不要求凭据，其它机器通道方法一律 401。
- package.json 与 AUDIT_VERSION 对齐 0.6.4。

## 版本记录 v0.6.3（20260902，网关鉴权体验/误杀缓解）

- 会话指纹放宽：UA 只绑定设备类别(desktop/mobile/tablet/other)而非逐字节哈希，桌面/手机切换不再误杀；旧会话回退 UA 哈希硬匹配。ipPrefixBits 默认 24→16。
- 未登录自动跳登录页：浏览器半侧包装全局 fetch 捕获 /api 401/403，仅无会话 cookie 且在登录页外时跳 /login；stepup 场景不狂跳。
  > 🔴 **20261021 更正：该功能在 DSH 0.2.x 上已失效**，见下方「⚠️ 自动跳转不适用，请直接访问 /login」。保留此条仅为历史记录。
- package.json 与 AUDIT_VERSION 对齐 0.6.3。

---

## 🏗️ 前身与历史（承接 `mai_study_code`）

本项目的缘起，与 `maibot_dsh_bridge` 一脉相承，同样承接自早期架构探索原型 —— **`mai_study_code`（麦麦学代码）**。

- **前身定位**：为麦麦设计"目录式 + Web 可视化 + 自进化"的代码学习/编辑工作台，后演变为独立 Web 应用（AgentLoop + WebServer + Sandbox + SSE 事件总线），其架构与 DSH 相似度约 **70%~75%**。
- **中断原因**：自造整套轮子（Agent 循环、Web 编辑器、沙盒、权限、持久化、事件流）维护负担过高，遂暂停。
- **迁移验证**：经研究确认 **DSH** 的架构正是最初构想的那套，转而采用 DSH 作为承载底座。
- **本项目角色**：`dsh-postapi-bridge` 是承接该构想、为外部系统/机器人开放 **DSH HTTP POST / RESTful API 调度网关** 的落地插件（客户端一侧配套 `maibot_dsh_bridge` 负责麦麦接入）。

> 🔗 **前身仓库（已归档）**：https://github.com/ptrel1/mai_study_code.git  
> 📖 该仓库 README 内含完整的架构对比、探索历史与归档说明。

---

## 🧠 DSH 上下文清理与压缩机制（网关长任务背景）

当外部系统通过本网关驱动 DSH 执行长任务时，DSH 通过 **`compaction`（压缩）体系** 控制上下文增长，其**二级漏斗**设计对理解长任务稳定性很有帮助：

| 级别 | 机制 | 是否调 LLM |
|---|---|---|
| **第一级 `dsh-compaction-tool-result-pruner`** | 超预算的 `tool/result`（如 `read`/`bash` 长输出）改写为「保留开头 + 省略标记 + 保留尾部」，**纯语法级剪枝** | ❌ **不调 LLM** |
| **第二级 `dsh-compaction-basic`** | 剪枝仍不足以缓解上下文压力时，调用 LLM 生成**语义摘要**（`retainRatio: 0.08` 保留最新 8%、`maxTokens: 8192`、`thresholdRatio: 0.8`） | ✅ 仅在必要时 |

> **理解要点**：DSH 先通过**非 LLM 剪枝**低成本地把工具输出"压形"，只有仍超预算才让 LLM "压义"。这对网关侧的长任务（跨多次 POST push/pull）至关重要——它避免了上下文无限膨胀，同时保住工具结果细节与对话语义，让长流程稳定可控。

---

## 🎯 核心目的之一：让公网访问 DSH 变得可行

> 这是本插件**最主要的立项动因**，而非附加功能。

### 问题：DSH 原生公网访问，凭证要去服务器上抓

DSH 官方为了防未授权访问，**每次启动都会生成一次性动态 token**，它只出现在：

1. 服务端启动日志里（形如 `dsh web: http://127.0.0.1:3080/?token=xxxx`）；
2. 或本机自动弹出的浏览器地址栏里。

这意味着：**你想从公网（手机、公司、异地）访问家里的 DSH，就必须先 SSH 登录服务器、翻日志把 token 抄出来**，再拼进 URL。而 token **每次重启都会变**——一旦 DSH 重启（升级、崩溃拉起、配置生效），你手里的旧链接立即失效，你得再登录一次服务器。

对"偶尔用一次"的场景还能忍，对日常远程使用则完全不现实。

### 本插件的做法：用密码换取那条动态凭证

本插件把「**去服务器抓 token**」这一步，替换成了「**输入一次密码**」：

```text
以前：SSH 登录服务器 → 翻 /main/log/app/dsh-web.log → 找到 ?token=xxx → 手工拼接 URL
现在：浏览器打开公网域名 → 输入账号密码 → 自动完成，落到已登录的 DSH 页面
```

实现要点（源码 `lib/index.js` 的 `resolveLatestLaunchToken` / `handleLogin`）：

- 登录密码校验通过后，插件**从本实例的启动日志中解析出最新一条动态 token**；
- 再以 `302` 跳转到 `/?token=<该 token>`，由 **DSH 官方原生机制**完成签名 cookie 的铸造；
- 因此**用户感知到的只是"输密码登录"**，底层走的仍是官方认可的凭证链路，**没有绕过 DSH 的任何安全机制**；
- 解析时按**端口匹配**（`--port` 参数）区分实例，避免 dsh1/dsh2 串 token 导致 401；
- 附带 60 秒缓存，避免每次登录都全量扫描日志。

> **一句话概括**：它不是"给 DSH 开后门"，而是"**把官方那串每次重启就变、且只存在服务器上的动态凭证，变成用户用密码就能自助获取的东西**"。

### ⚠️ 使用前提与边界（务必阅读）

| 项 | 说明 |
|---|---|
| **日志可读** | 插件需能读到 DSH 启动日志。v1.7.9 起为**三级回退**：① 环境变量 `DSH_LOG_PATHS`（逗号分隔，**推荐**）② `$DSH_HOME/logs/dsh-web.log` 与 `dsh-rescue.log` ③ 本机既有路径 `/main/log/app/...`（兜底）。**路径不同请用 `DSH_LOG_PATHS` 指定** |
| **运行身份** | 运行 DSH 的进程需有该日志的读权限，否则解析失败、登录后无法自动注入凭证 |
| **不是绕过鉴权** | 只是把官方 token 的**获取方式**从"人工抓日志"改为"密码自助取"。密码错误仍然登不进去 |
| **仍需反向代理** | 公网可达性本身由 frp / nginx 等提供，本插件只解决**认证**，不解决**网络连通** |
| **安全强相关** | 开放公网后请配合：强密码、账号管理面板、会话指纹绑定（见下文安全章节）、以及反向代理层的 TLS |

---

## ✨ 核心特性

1. **插件本体零侵入（0-Diff）**：登录页、多账号管理、机器 POST API 均基于 DSH 标准扩展点实现，**无需修改官方核心代码**。
   > ✅ **20260923 核对**：DSH **0.1.5+ 起已完全零侵入**——官方原生提供 `/api` 前置登录门禁
   > （`client/connection` 的 `browserAuth.isAuthenticated()`），本插件无需任何源码补丁。
   > 早期（0.1.2）曾需加 `requireSession` 扩展点，该路径已废弃。
2. **人类 Web 通道**：
   - 优美自适应主题登录页（`/login` 与 `/logout`）；
   - **用账号密码自助换取 DSH 动态登录凭证**，免去登录服务器抓 token —— 公网访问的核心（详见上方「🎯 核心目的之一」）；
   - 多账号独立权限与 Web 账号管理面板；
   - 本机回环（`127.0.0.1`）免密直通。
3. **机器 POST API 通道**：
   - 为 **MaiBot（麦麦）/ 微信机器人 / 飞书 / CI/CD** 等外部系统提供免 Cookie 的纯 POST API；
   - 携带 `Authorization: Bearer <Token>` 或 `X-Gateway-Token` 即可跨域直通，无论是在容器内、公网域名还是内网反向代理，**永不受 127/Cookie 重定向限制**。

---

## 🔐 公网账号系统与 DSH 源码扩展点（重要）

> ⚠️ **现状核对（20260923，针对 DSH 0.1.5-rc.2 实测）**：
>
> 本节以下原文描述的是 **0.1.2 时代**的实现路径。**实测结论**：
>
> | 原文所述 | 0.1.5 现状 |
> |---|---|
> | 需改源码加 `requireSession` 扩展点 | ❌ **源码中已不存在该扩展点**（全仓库 grep 无命中） |
> | 插件 `provide('sessionAuth')` 供 DSH 调用 | ⚠️ **仍在 provide（`lib/index.js:710`），但源码中零消费者** —— 属**预留/历史接口** |
> | 鉴权由 DSH 侧统一完成 | ✅ **成立**，但走的是**官方原生实现**：`packages/client/connection/src/browser-auth.ts` 的 `isAuthenticated()`，由 `rpc-host.ts:99` 调用（`requestRejection`） |
>
> **✅ 现状结论**：DSH 0.1.5 已把「`/api` 前置登录门禁」**吸收进官方源码**，
> 公网未登录访问 `/api/*`（含 `remote.mux` websocket）**一律 401**，loopback 恒放行。
> **不再需要修改 DSH 源码**，本插件负责的是登录页 + 多账号 + 机器通道。
>
> 因此，若你在 0.1.5+ 上看到 `/api/*` 返回 401 —— **这是正常的门禁行为，不是故障**。
> （实测：dsh1 与 dsh2 的无 cookie 请求表现完全一致。）

---

本插件保护的是「登录页 + 管理 API + 机器通道」，**无法保护官方 `/api/*` 核心 RPC**。DSH 官方把 `/api/*` 的信任边界定义在"谁能连到服务"（Host 头）而非"是否登录"，且 webserver **无中间件、路由防重复、RPC interceptor 拿不到 request**——纯插件无法在 `/api` 前置登录校验。

因此，公网场景要实现「未登录禁止调用任何 DSH 核心功能」（发消息、执行命令、读写配置等），必须：
1. **修改 DSH 源码**：在 `packages/client/connection/src/index.ts` 增加**默认关闭**的 `requireSession` 扩展点（不开启时与官方单用户行为完全一致；配套 `api-request-trust.ts` 导出两个内部函数）；
   > ⚠️ **0.1.5+ 已不需要此步骤**——官方已原生实现，见上方现状核对。
2. **本插件提供实现**：`ctx.provide('sessionAuth', { isAuthenticated })` 返回鉴权判定。
   > ⚠️ **0.1.5+ 此接口已无消费者**，保留仅为兼容旧版 DSH。

> **配置面（settings.* / credentials.*）公网可用**：原生门禁放行登录用户后，原本公网一律 403 的配置面（读配置、改配置、凭据管理、原生对话框、agent preset 管理、模型发现）在公网可访问与修改——登录校验由 DSH 侧统一完成，未登录仍被 401 拦截。
> ✅ **0.1.5+ 实测确认此行为成立**（门禁由官方 `browserAuth.isAuthenticated()` 承担）。

> 完整决策流程（仅本地 → 不改源码；公网 → 需改源码）、源码改动方案、git 维护与升级指导，见：
> 🔒 `skill/public-network-auth-guide.md`

---

## 📡 API 接口速查

| 接口 | 方法 | 鉴权方式 | 说明 |
| :--- | :--- | :--- | :--- |
| `/login` | `GET / POST` | 账号/密码表单 | Web 用户登录与会话颁发 |
| `/logout` | `GET / POST` | Cookie | 安全登出 |
| `/api/dsh/v1/health` | `GET` | 免密 / Token | 健康检查与状态探测 |
| `/api/dsh/v1/task` | `POST` | Bearer Token | 调度 DSH 核心引擎派发 Agent 任务 |
| `/api/dsh/v1/mcp/tool`| `POST` | Bearer Token | 直接调用 DSH 工具（如 `bash`, `read`） |
| `/api/dsh/v1/mobile-login` | `POST` | 免密（账号密码登录，按 IP 限流） | 安卓客户端 JSON 登录：返回 launchUrl + 会话 cookie |
| `/api/dsh/v1/file-ticket` | `POST` | 已登录（插件会话） | 为 present 过的交付物签发票据（48h 待激活 / 首下起 5h） |
| `/api/dsh/v1/files` | `GET` | 已登录（插件会话） | 列出会话内交付物元数据（查询参数 **`sid`**；v1.0.0） |
| `/api/dsh/v1/file/<token>` | `GET` | 已登录 + 票据绑定本人 | 流式下载交付物；5h 内不限次数，支持 Range 续传 |

### 溯源审计（v0.3.0）

**功能**：为网关的每一笔请求（`/api/dsh/v1/*`，含 `/task`）固化成一条溯源记录，用于回答「谁、从哪、走什么通道、调用哪个接口/插件下发了任务」。

**落册两条**：
- `ctx.logger`：进程日志中以 `[postapi-audit]` 前缀输出（DSH supervisor 的 `dsh-web.log` / `dsh-rescue.log` 可见）；
- `data/access-log.jsonl`：插件数据目录下的 JSON Lines 文件（默认 `插件目录/data/`，超 5MB 自动轮转保留 3 份 `.1/.2/.3`）。

**记录四要素**：
| 要素 | 字段 | 来源 |
| :--- | :--- | :--- |
| 来源 IP | `ip` / `xff` / `loopback` | 直连 IP + `X-Forwarded-For` 全链 + 是否回环 |
| 域名入口 | `host` / `xForwardedHost` / `xForwardedProto` | `Host` 头与转发头 |
| 通道 | `channel` / `channelVia` | `X-DSH-Channel` 头 → `config.channels` / `DSH_GATEWAY_CHANNELS` 的 token↔通道映射 → UA 推断 → `unknown` |
| 调用方 | `caller` / `ua` | token 指纹（SHA256 前 8 位，明文 token 不落盘）+ User-Agent |

**配置**：
- `config.channels`：`{ "<token>": "通道名", ... }`（把 maibot 的网关 token 映射为 `maibot`，通道一眼可辨）；
- `DSH_GATEWAY_CHANNELS`：环境变量 JSON，格式同上（默认层，低于 `config.channels`）；
- `config.accessLogDir`：自定义审计日志目录（默认插件 `data/`）。

**生效**：改完重启 DSH（`supervisorctl restart dsh-web`），`/api/dsh/v1/health` 返回 `"audited": true` 作为启用标记。

---

## ⚠️ 使用方式：请直接访问 `/login`（重要）

> **自动跳转功能在 DSH 0.2.x 上不适用**，请按下述方式手动进入登录页。

### 正确的访问方式

```text
❌ 不要直接访问   https://你的域名/
✅ 请访问         https://你的域名/login
```

访问 `/login`：**未登录**时展示登录表单；**已登录**时直接跳回使用页（v0.7.0 起）。

### 为什么自动跳转不适用

| 环节 | DSH 0.2.x 的实际行为 |
|---|---|
| 访问 `/` 且未登录 | 宿主 **在请求分发阶段**就返回 401 纯文本：`dsh web authentication required; reopen the URL printed by dsh web.` |
| 插件的 `tapIndex` 跳转脚本 | ❌ **拿不到 HTML**（响应体只有 68 字节纯文本，非 HTML），注入永远不执行 |
| 访问 `/login` | ✅ **正常返回登录页**（插件自有路由，不经过宿主的 401 门禁） |

**根因**：DSH 0.2.x 把浏览器认证门禁放在 `frontend-static` 的 fallback 层
（`serveStatic` → `connection.authorizeIndex`）。插件注册的命名路由优先级高于 fallback，
而 `tapIndex` 只作用于 fallback 渲染出的 HTML —— 但 fallback 在渲染前就已被 401 拦下，
所以 `tapIndex` 收不到任何内容。

> ⚠️ **技术上可以**用 `webServer.register({ kind: 'exact', path: '/' })` 抢在 fallback 前接管根路径，
> 但需自行读取并渲染 `dist/index.html`、并同时兼容**原生 BrowserAuth cookie** 与**插件 session cookie**
> 两套认证体系，**依赖多处宿主非公开实现** —— 一旦 DSH 升级导致路径或服务形态变化，
> **整个 Web UI 将无法打开**。权衡后**不采用**。

### 想要「访问根路径自动跳登录页」怎么办

在**反向代理层**做，这是唯一稳妥的位置（nginx 一定在 DSH 之前）：

```nginx
# 未携带插件会话 cookie 时，重定向到登录页
if ($cookie_dsh_postapi_session = "") {
    return 302 /login;
}
```

> 💡 注意：若用户持有的是**原生 BrowserAuth cookie**（通过 `?token=` 登录），
> 上述判断会把已登录用户也重定向到 `/login`。由于 `/login` 已实现「已登录直通」，
> 这类用户会被立即送回使用页，**不会造成困扰**，仅多一次 302。

---

## 🚀 安装与挂载

### 方式一：从 GitHub 源码安装（推荐）

```bash
# 一行命令挂载到 DSH web profile
dsh plugin --profile web add git+https://github.com/ptrel1/dsh-postapi-bridge.git

# 重启 DSH 服务生效
supervisorctl restart dsh-web
```

> 📦 本仓库为当前维护源（最新 `0.6.6`）。
> ⚠️ npm registry 上的 `dsh-postapi-bridge` 停留在 `0.1.0`（缺少 `sessionAuth` 接线，会导致公网 API 403/401），
> **不建议**用 `dsh plugin add dsh-postapi-bridge` 安装。

### 方式二：本地源码 Link（开发 / 定制）

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:/main/app/github/dsh-postapi-bridge

# 重启 DSH 服务生效
supervisorctl restart dsh-web
```

---

## 🔧 为什么需要修改 DSH 源码（而非纯插件）—— 好处

> ⚠️ **现状（20260923）**：本节论述的是**为什么当初选择"源码门禁"而不是"纯插件方案"**——
> 这个**设计判断本身仍然成立**（能力边界对比见下表）。
> 但**实现路径已变**：官方在 **0.1.5** 把该门禁**吸收进了源码本体**
> （`client/connection` 的 `browserAuth.isAuthenticated()`），
> 因此**使用者不再需要自己打补丁**——那是上游替我们做了这件事。
> 下表左列「纯插件」的局限，仍是当前生态里第三方远程控制插件的真实局限。

本插件的**登录鉴权**依赖一个源码级扩展点（`client-connection` 的 `requireSession`）。为什么不做成"零侵入"纯插件？因为两种方案的**能力边界完全不同**：

| 维度 | 纯插件（零侵入） | 源码扩展点（官方原生门禁） |
| :--- | :--- | :--- |
| 能否在 `/api` 前置鉴权 | **不能**（官方无中间件、路由防重复、interceptor 无 request） | **能**：connection 路由 handler 内统一校验 |
| 覆盖范围 | 只能 gate **自己新开的通道** | 整个 `/api/*`：HTTP RPC + SSE + WebSocket，**fail-closed** |
| 对直连 `/api`（curl 绕过） | 管不住 | 一律 401/403 |
| 与官方升级的兼容性 | 天然无冲突 | 由官方维护（0.1.5+ 起**无需自行 merge**） |

**源码门禁的好处（对比纯插件远程控制方案）**：
1. **守住官方唯一的门**：鉴权发生在 `/api` 入口本身，任何客户端（浏览器、curl、脚本、第三方前端）都被同一道门拦截；
2. **不被通道绕过**：纯插件"远程控制"方案只能把流量引到自己通道再以本机身份代理回 `/api`，本质是可绕过的通道门禁；源码门禁没有这个缝；
3. **行为不漂移**：loopback 恒放行、非回环未登录 401 —— 由官方语义保证；
4. **配置面随用户登录开放**：登录用户可在公网读写 `settings.*`/`credentials.*`（官方默认 pin loopback）。

## 🆚 与第三方远程控制插件（@linxin666/dsh-remote-web-ui）的区别

- **设备配对 ≠ 用户登录**：`dsh-remote-web-ui` 的"设备配对"只是给**设备**发 cookie，管不住直连官方 `/api` 的请求（官方源码原话："没有插件能做到；`/api` 的围栏是 SDK 自己的接缝"）。
- **配对会绕过登录门禁**：它把远程流量经 `/remote` 通道用 loopback 反向代理（伪造 `Host:127.0.0.1`）转回本机，而门禁对 loopback 恒放行 → **配对成功即免登录全权限**。
- **本部署取舍**：公网登录鉴权的唯一入口是源码级门禁（**0.1.5+ 为官方原生**，fail-closed）；已在 profile patch 禁用 `web-ui-remote-web-ui`：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: web-ui-remote-web-ui
  disabled: true
```

- 详细架构对比见 🔒 `skill/public-network-auth-guide.md` §七。
