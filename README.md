# GitHub 克隆加速器

基于 Cloudflare Worker 的 GitHub 反向代理，解决国内 `git clone` 缓慢或超时的问题。无需本地安装任何软件，部署到 Cloudflare 即可使用。

## 功能特性

- **Git 操作加速** — 支持 `clone` / `fetch` / `pull` / `push` 全流程加速
- **文件下载加速** — 支持 Release、Raw 文件、源码压缩包等下载
- **私有仓库支持** — 通过配置 GitHub Token 访问私有仓库
- **匿名优先** — 公开仓库匿名访问，仅在需要认证时才使用 Token
- **重定向保持** — 手动跟随重定向并保留认证信息，避免凭据丢失
- **多域名支持** — 覆盖 GitHub 全系列域名
- **Web 转换工具** — 访问首页可在线转换链接

## 支持的域名

| 域名 | 用途 |
|------|------|
| `github.com` | 仓库克隆、页面访问 |
| `raw.githubusercontent.com` | Raw 文件下载 |
| `gist.github.com` | Gist 访问 |
| `gist.githubusercontent.com` | Gist Raw 文件 |
| `objects.githubusercontent.com` | LFS / Release 资源 |
| `codeload.github.com` | 源码压缩包下载 |
| `github.githubassets.com` | 静态资源 |

## 部署

### 方式一：Cloudflare 面板（推荐）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers 和 Pages** → 创建 Worker（选择 "Hello World" 模板）
3. 部署后进入编辑器，将 `src/index.js` 的全部内容粘贴进去，保存并部署
4. **（重要）绑定自定义域名**：进入 Worker 设置 → 域和路由 → 添加自定义域
   > `workers.dev` 域名在国内无法直接访问，必须绑定自己的域名并托管到 Cloudflare

### 方式二：Wrangler CLI

需要 [Node.js](https://nodejs.org/) 环境：

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## 配置 GitHub Token（可选）

配置 Token 后可以访问私有仓库。Token 仅在目标返回 401 时才会使用，公开仓库始终匿名访问。

1. 前往 [GitHub Settings → Personal access tokens](https://github.com/settings/tokens) 生成 Token
   - Classic Token：勾选 `repo` 权限
   - Fine-grained Token：选择对应仓库的访问权限
2. 在 Cloudflare Worker 面板 → 设置 → **变量和机密** → 添加加密变量：
   - 名称：`GITHUB_TOKEN`
   - 值：你的 Token

## 使用方法

将原始 GitHub 链接中的 `https://` 替换为 `https://你的域名/` 即可。

### 克隆仓库

```bash
# 原始地址
git clone https://github.com/user/repo.git

# 加速地址
git clone https://你的域名/github.com/user/repo.git
```

### 下载文件

```bash
# Release 文件
wget https://你的域名/github.com/user/repo/releases/download/v1.0/file.zip

# Raw 文件
wget https://你的域名/raw.githubusercontent.com/user/repo/main/README.md

# 源码压缩包
wget https://你的域名/codeload.github.com/user/repo/zip/refs/heads/main
```

### 全局加速（可选）

如果不想每次都修改 URL，可以配置 Git 全局替换：

```bash
git config --global url."https://你的域名/github.com/".insteadOf "https://github.com/"
```

配置后所有 `git clone https://github.com/...` 会自动走代理，且远程地址不会被修改。

取消配置：

```bash
git config --global --unset url."https://你的域名/github.com/".insteadOf
```

## 诊断接口

部署后可通过以下接口排查问题：

| 接口 | 说明 |
|------|------|
| `/_health` | 检查 Token 是否配置正确、能否通过 GitHub API 认证 |
| `/_test/<owner>/<repo>` | 模拟 `git clone` 的首次请求，返回 GitHub 的原始响应状态 |

示例：

```bash
curl https://你的域名/_health
curl https://你的域名/_test/torvalds/linux
```

## 项目结构

```
├── src/
│   └── index.js        # Worker 核心代码
├── wrangler.toml        # Cloudflare Worker 配置
├── package.json         # 项目依赖
└── README.md
```

## 工作原理

```
客户端                    Cloudflare Worker                GitHub
  │                            │                             │
  │  git clone proxy/gh/repo   │                             │
  │ ──────────────────────────>│                             │
  │                            │  匿名请求 github.com/repo   │
  │                            │ ───────────────────────────>│
  │                            │                    200 / 401│
  │                            │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
  │                            │                             │
  │                            │  [如果 401] 带 Token 重试    │
  │                            │ ───────────────────────────>│
  │                            │                         200 │
  │                            │<───────────────────────────│
  │        返回数据             │                             │
  │<──────────────────────────│                             │
```

## 安全说明

- **Token 安全**：Token 作为加密变量存储在 Cloudflare，不会出现在代码或日志中
- **匿名优先**：公开仓库不发送 Token，保持匿名访问
- **域名白名单**：仅允许代理 GitHub 相关域名，防止被滥用为开放代理
- **注意事项**：任何知道你 Worker 地址的人都可以通过它访问你的私有仓库（如果配置了 Token），请勿公开分享地址或考虑添加访问控制

## 限制

- Cloudflare Workers 免费版每日 100,000 次请求
- 单次请求 CPU 时间限制 10ms（I/O 不计入，正常 clone 不受影响）
- 请求体大小上限 100MB（免费版）

## License

MIT
