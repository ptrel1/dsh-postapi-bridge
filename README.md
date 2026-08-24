# dsh-postapi-bridge 🚪🔐

> **DeepSeek Harness (DSH) 官方标准双半侧统一网关与鉴权桥梁插件**  
> 融合 **人类端多用户安全登录** + **机器端轻量 HTTP POST / RESTful API 调度网关**。

---

## 📦 npm 发布状态

> ✅ **已发布到 npm**：`dsh-postapi-bridge@0.1.0`（dist-tag `latest`）  
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

## 🔐 公网账号系统与 DSH 源码扩展点（重要）

本插件保护的是「登录页 + 管理 API + 机器通道」，**无法保护官方 `/api/*` 核心 RPC**。DSH 官方把 `/api/*` 的信任边界定义在"谁能连到服务"（Host 头）而非"是否登录"，且 webserver **无中间件、路由防重复、RPC interceptor 拿不到 request**——纯插件无法在 `/api` 前置登录校验。

因此，公网场景要实现「未登录禁止调用任何 DSH 核心功能」（发消息、执行命令、读写配置等），必须：
1. **修改 DSH 源码**：在 `packages/client/connection/src/index.ts` 增加**默认关闭**的 `requireSession` 扩展点（不开启时与官方单用户行为完全一致；配套 `api-request-trust.ts` 导出两个内部函数）；
2. **本插件提供实现**：`ctx.provide('sessionAuth', { isAuthenticated })` 返回鉴权判定。

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
