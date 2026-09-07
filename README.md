# dsh-postapi-bridge 🚪🔐

> **DeepSeek Harness (DSH) 官方标准双半侧统一网关与鉴权桥梁插件**  
> 融合 **人类端多用户安全登录** + **机器端轻量 HTTP POST / RESTful API 调度网关**。

---

## 📦 npm 发布状态

> ✅ **已发布到 npm**：`dsh-postapi-bridge@0.1.1`（dist-tag `latest`）  
> ⚠️ **0.1.1 起含 `sessionAuth` 服务接线**（对接 DSH `requireSession` 门禁扩展点）。曾发布的 **0.1.0 缺少该接线**——若 profile 以 `"*"` 依赖声明重装拉到旧版，会导致公网 API 全部 403/401（fail-closed），务必升到 0.1.1+。  
> 📦 安装：`dsh plugin --profile web add dsh-postapi-bridge`  
> 🔗 查看：[https://www.npmjs.com/package/dsh-postapi-bridge](https://www.npmjs.com/package/dsh-postapi-bridge)

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

## ✨ 核心特性

1. **插件本体零侵入（0-Diff）**：登录页、多账号管理、机器 POST API 均基于 DSH 标准扩展点实现，**无需修改官方核心代码**。
   > ⚠️ **但请注意**：若要在**公网部署**中强制「未登录用户禁止使用 DSH 核心功能」，因官方 webserver 架构未给 `/api` 前置登录鉴权留插件接入位，**需配合修改 DSH 源码**（见下方「🔐 公网账号系统」章节）。
2. **人类 Web 通道**：
   - 优美自适应主题登录页（`/login` 与 `/logout`）；
   - 多账号独立权限与 Web 账号管理面板；
   - 本机回环（`127.0.0.1`）免密直通。
3. **机器 POST API 通道**：
   - 为 **MaiBot（麦麦）/ 微信机器人 / 飞书 / CI/CD** 等外部系统提供免 Cookie 的纯 POST API；
   - 携带 `Authorization: Bearer <Token>` 或 `X-Gateway-Token` 即可跨域直通，无论是在容器内、公网域名还是内网反向代理，**永不受 127/Cookie 重定向限制**。

---

## 🔐 公网账号系统与 DSH 鉴权（20260907 更新：0.1.2 原生 BrowserAuth 时代）

**dsh ≥ 0.1.2：`/api/*` 鉴权主力已原生内置（BrowserAuth），不再需要任何源码补丁。**
- 门禁：无 cookie 401 / Host 不可信 403；一次性 `?token=` 入口 URL 铸签名 cookie（30 天，跨重启有效）。
- **登录体验**：本插件 `/login`（账号密码）登录成功后自动解析 supervisor 日志最新启动 token
  并 302 跳转铸原生 cookie——用户只需记 `/login` + 密码，重启换 token 无感。
- 高危 step-up 二次验证、多账号、审计：仍由本插件提供（无原生等价物）。
- ⚠️ **0.1.2 起 `apiProxy` 服务已被上游移除**：插件 `inject` 不再含 `apiProxy`，
  `/task` 会话驱动改 `ctx.agents.get/create` + `handle.agent.followup`（不兼容 dsh < 0.1.2）。

<details><summary>历史方案（dsh ≤ 0.1.1 requireSession 源码扩展点，已废弃）</summary>

旧版公网场景要保护官方 `/api/*` 必须改 DSH 源码：在 `packages/client/connection/src/index.ts` 增加
默认关闭的 `requireSession` 扩展点 + 插件 `ctx.provide('sessionAuth', { isAuthenticated })`。
详见 `skill/public-network-auth-guide.md` 存档部分。</details>

> **配置面（settings.* / credentials.*）公网可用**：开启 `requireSession` 并登录后，原本公网一律 403 的配置面（读配置、改配置、凭据管理、原生对话框、agent preset 管理、模型发现）在公网可访问与修改——登录校验由 DSH 侧统一完成，未登录仍被 401 拦截。

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

## 🚀 安装与挂载

### 方式一：从 npm 安装（推荐，面向大众）

```bash
# 一行命令挂载到 DSH web profile
dsh plugin --profile web add dsh-postapi-bridge

# 重启 DSH 服务生效
supervisorctl restart dsh-web
```

> 📦 npm 包名：**`dsh-postapi-bridge`**（公开发布，`dsh plugin add dsh-postapi-bridge` 即可）。

### 方式二：本地源码 Link（开发 / 定制）

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:/main/app/github/dsh-postapi-bridge

# 重启 DSH 服务生效
supervisorctl restart dsh-web
```

---

## 🔧 为什么需要修改 DSH 源码（而非纯插件）—— 好处

本插件的**登录鉴权**依赖一个源码级扩展点（`client-connection` 的 `requireSession`）。为什么不做成"零侵入"纯插件？因为两种方案的**能力边界完全不同**：

| 维度 | 纯插件（零侵入） | 源码扩展点（`requireSession`） |
| :--- | :--- | :--- |
| 能否在 `/api` 前置鉴权 | **不能**（官方无中间件、路由防重复、interceptor 无 request） | **能**：connection 路由 handler 内统一校验 |
| 覆盖范围 | 只能 gate **自己新开的通道** | 整个 `/api/*`：HTTP RPC + SSE + WebSocket，**fail-closed** |
| 对直连 `/api`（curl 绕过） | 管不住 | 一律 401/403 |
| 与官方升级的兼容性 | 天然无冲突 | 需 merge 时 review `client-connection`（增量小、冲突集中） |

**修改源码的好处（对比纯插件远程控制方案）**：
1. **守住官方唯一的门**：鉴权发生在 `/api` 入口本身，任何客户端（浏览器、curl、脚本、第三方前端）都被同一道门拦截；
2. **不被通道绕过**：纯插件"远程控制"方案只能把流量引到自己通道再以本机身份代理回 `/api`，本质是可绕过的通道门禁；源码门禁没有这个缝；
3. **默认关闭、行为不漂移**：`requireSession` 默认 `false`，不开 = 官方原样；开启 = 公网未登录 401，loopback 恒放行；
4. **配置面随用户登录开放**：登录用户可在公网读写 `settings.*`/`credentials.*`（官方默认 pin loopback），多用户协作不必局限本机。

## 🆚 与第三方远程控制插件（@linxin666/dsh-remote-web-ui）的区别

- **设备配对 ≠ 用户登录**：`dsh-remote-web-ui` 的"设备配对"只是给**设备**发 cookie，管不住直连官方 `/api` 的请求（官方源码原话："没有插件能做到；`/api` 的围栏是 SDK 自己的接缝"）。
- **配对会绕过本插件的登录门禁**：它把远程流量经 `/remote` 通道用 loopback 反向代理（伪造 `Host:127.0.0.1`）转回本机，`requireSession` 对 loopback 恒放行 → **配对成功即免登录全权限**。
- **本部署取舍**：公网登录鉴权的唯一入口是 `requireSession`（源码级、fail-closed）；已在 profile patch 禁用 `web-ui-remote-web-ui`：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: web-ui-remote-web-ui
  disabled: true
```

- 详细架构对比见 🔒 `skill/public-network-auth-guide.md` §七。
