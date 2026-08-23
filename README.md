# dsh-postapi-bridge 🚪🔐

> **DeepSeek Harness (DSH) 官方标准双半侧统一网关与鉴权桥梁插件**  
> 融合 **人类端多用户安全登录** + **机器端轻量 HTTP POST / RESTful API 调度网关**。

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

## ✨ 核心特性

1. **零侵入架构（0-Diff）**：基于 DSH 标准扩展点开发，完全无需修改官方核心代码。
2. **人类 Web 通道**：
   - 优美自适应主题登录页（`/login` 与 `/logout`）；
   - 多账号独立权限与 Web 账号管理面板；
   - 本机回环（`127.0.0.1`）免密直通。
3. **机器 POST API 通道**：
   - 为 **MaiBot（麦麦）/ 微信机器人 / 飞书 / CI/CD** 等外部系统提供免 Cookie 的纯 POST API；
   - 携带 `Authorization: Bearer <Token>` 或 `X-Gateway-Token` 即可跨域直通，无论是在容器内、公网域名还是内网反向代理，**永不受 127/Cookie 重定向限制**。

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

```bash
# 挂载到 DSH web profile
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:/main/app/github/dsh-postapi-bridge

# 重启 DSH 服务生效
supervisorctl restart dsh-web
```
