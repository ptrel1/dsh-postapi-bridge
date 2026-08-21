# dsh-postapi-bridge 🚪🔐

> **DeepSeek Harness (DSH) 官方标准双半侧统一网关与鉴权桥梁插件**  
> 融合 **人类端多用户安全登录** + **机器端轻量 HTTP POST / RESTful API 调度网关**。

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
