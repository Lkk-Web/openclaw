# OpenClaw NPM 用户完整指南

本文档详细介绍 OpenClaw 发布到 npm 后的完整用户流程。

---

## 1. 发布流程

### 1.1 发布前准备

在发布到 npm 之前，需要确保 `package.json` 中的关键字段已正确配置：

| 字段 | 说明 | 示例值 |
|------|------|--------|
| `name` | npm 包名称 | `openclaw` |
| `version` | 版本号 (遵循 vYYYY.M.D 格式) | `2026.3.14` |
| `description` | 包描述 | `Multi-channel AI gateway with extensible messaging integrations` |
| `license` | 许可证 | `MIT` |
| `bin` | CLI 入口点 | `{"openclaw": "openclaw.mjs"}` |
| `files` | 发布时包含的文件 | 见下方 |
| `engines` | Node.js 版本要求 | `{"node": ">=22.16.0"}` |
| `packageManager` | pnpm 版本要求 | `pnpm@10.23.0` |

**关键 files 配置说明：**
```json
"files": [
  "CHANGELOG.md",
  "LICENSE",
  "openclaw.mjs",
  "README.md",
  "assets/",
  "dist/",
  "docs/",
  "extensions/",
  "skills/"
]
```

### 1.2 构建和发布命令

```bash
# 进入项目目录
cd ~/Desktop/github/ai/openclaw

# 1. 安装依赖
pnpm install

# 2. 构建项目（生成 dist 目录）
pnpm build

# 3. 登录 npm（如果没有登录）
npm login

# 4. 发布到 npm
pnpm publish

# 或者发布到特定标签
pnpm publish --tag beta    # 发布到 beta 频道
pnpm publish --tag dev     # 发布到 dev 频道
```

### 1.3 版本号管理

OpenClaw 使用日期格式的版本号：`vYYYY.M.D`

- **stable**: 正式发布，使用 `latest` 标签
- **beta**: 测试版，使用 `beta` 标签
- **dev**: 开发版，使用 `dev` 标签

发布后切换版本频道：
```bash
# 切换到 stable 频道
openclaw update --channel stable

# 切换到 beta 频道
openclaw update --channel beta

# 切换到 dev 频道
openclaw update --channel dev
```

---

## 2. 用户安装流程

### 2.1 环境要求

| 要求 | 最小版本 |
|------|----------|
| Node.js | ≥ 22.16.0 |
| 包管理器 | npm, pnpm 或 bun |

**推荐使用 nvm 管理 Node.js 版本：**
```bash
# 安装 nvm (如果没有)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 安装并使用 Node.js 22
nvm install 22
nvm use 22
nvm alias default 22
```

### 2.2 安装命令

```bash
# 使用 npm 安装
npm install -g openclaw@latest

# 或者使用 pnpm 安装（推荐）
pnpm add -g openclaw@latest

# 或者使用 bun 安装
bun add -g openclaw@latest
```

### 2.3 初始化配置

安装完成后，运行交互式配置向导：

```bash
# 完整初始化（推荐）
openclaw onboard

# 或者快速安装守护进程
openclaw onboard --install-daemon
```

`onboard` 命令会引导你完成：
1. 配置 Gateway（网关）
2. 配置工作区
3. 配置消息通道（WhatsApp、Telegram、Discord 等）
4. 配置技能（Skills）

### 2.4 启动命令（指定端口避免冲突）

#### 方式一：使用命令行参数

```bash
# 指定端口启动 Gateway
openclaw gateway --port 18666

# 如果端口被占用，强制杀掉占用进程
openclaw gateway --port 18666 --force

# 开发模式（隔离配置，默认端口 19001）
openclaw --dev gateway

# 开发模式指定端口
openclaw --dev gateway --port 19001
```

#### 方式二：配置文件

在 `~/.openclaw/config.yaml` 中配置：

```yaml
gateway:
  mode: local
  bind: loopback
  port: 18666
  token: your-secure-token
```

### 2.5 验证安装

```bash
# 查看版本
openclaw --version

# 查看帮助
openclaw --help

# 检查 Gateway 状态
openclaw gateway status

# 检查健康状态
openclaw health
```

---

## 3. 运行管理

### 3.1 启动服务

#### 前台运行
```bash
# 启动 Gateway
openclaw gateway run

# 启动 Node Host
openclaw node run --host 127.0.0.1 --port 18666
```

#### 后台守护进程（推荐）

```bash
# 安装 Gateway 守护进程 (macOS: launchd, Linux: systemd, Windows: schtasks)
openclaw gateway install

# 安装 Node Host 守护进程
openclaw node install

# 启动守护进程
openclaw gateway start
openclaw node start

# 守护进程开机自启会自动配置
```

### 3.2 重启服务

```bash
# 重启 Gateway 守护进程
openclaw gateway restart

# 重启 Node Host 守护进程
openclaw node restart

# 如果是前台运行，按 Ctrl+C 停止，然后重新启动
```

### 3.3 查看状态

```bash
# 查看 Gateway 状态
openclaw gateway status

# 查看 Node Host 状态
openclaw node status

# 查看通道状态
openclaw status

# 查看健康状态
openclaw health

# 查看实时日志
openclaw logs
```

### 3.4 常用命令速查

| 操作 | 命令 |
|------|------|
| 启动 Gateway | `openclaw gateway run` |
| 停止 Gateway | `openclaw gateway stop` |
| 重启 Gateway | `openclaw gateway restart` |
| 查看状态 | `openclaw gateway status` |
| 健康检查 | `openclaw health` |
| 查看日志 | `openclaw logs` |
| 配置通道 | `openclaw channels login telegram` |
| 发送消息 | `openclaw message send --to @user --message "Hello"` |
| 与助手对话 | `openclaw agent --message "你的问题"` |
| 运行 TUI | `openclaw tui` |
| 打开控制面板 | `openclaw dashboard` |
| 健康检查和修复 | `openclaw doctor` |

---

## 4. 卸载流程

### 4.1 停止服务

```bash
# 停止 Gateway 守护进程
openclaw gateway stop

# 停止 Node Host 守护进程
openclaw node stop
```

### 4.2 卸载守护进程

```bash
# 卸载 Gateway 守护进程
openclaw gateway uninstall

# 卸载 Node Host 守护进程
openclaw node uninstall
```

### 4.3 删除 npm 包

```bash
# 使用 npm 卸载
npm uninstall -g openclaw

# 使用 pnpm 卸载
pnpm remove -g openclaw

# 使用 bun 卸载
bun remove -g openclaw
```

### 4.4 清理配置和数据

OpenClaw 的配置和数据存储在以下位置：

| 类型 | 路径 |
|------|------|
| 默认配置目录 | `~/.openclaw/` |
| 开发模式配置 | `~/.openclaw-dev/` |
| 指定 profile | `~/.openclaw-<name>/` |

#### 方式一：使用内置命令（保留 CLI）

```bash
# 重置本地配置（保留 CLI 安装）
openclaw reset

# 完全卸载（删除配置和数据，保留 CLI）
openclaw uninstall
```

#### 方式二：手动删除

```bash
# 删除配置和数据目录
rm -rf ~/.openclaw

# 如果使用了开发模式
rm -rf ~/.openclaw-dev

# 如果使用了自定义 profile
rm -rf ~/.openclaw-<profile-name>

# 删除全局 node 模块（如果上面卸载命令无效）
rm -rf $(npm root -g)/openclaw
```

### 4.5 完整卸载流程

```bash
#!/bin/bash
# 完整卸载 OpenClaw

# 1. 停止并卸载服务
openclaw gateway stop 2>/dev/null
openclaw gateway uninstall 2>/dev/null
openclaw node stop 2>/dev/null
openclaw node uninstall 2>/dev/null

# 2. 卸载 npm 包
npm uninstall -g openclaw
# 或 pnpm remove -g openclaw

# 3. 清理配置和数据
rm -rf ~/.openclaw
rm -rf ~/.openclaw-dev

echo "OpenClaw 已完全卸载"
```

---

## 5. 常见问题

### 5.1 端口冲突

```bash
# 查看端口占用
lsof -i :18666

# 使用 --force 参数强制占用
openclaw gateway --port 18666 --force
```

### 5.2 Node.js 版本问题

```
openclaw requires Node >=22.16.0.
```

解决方案：
```bash
# 使用 nvm 切换版本
nvm install 22
nvm use 22

# 验证版本
node --version
```

### 5.3 更新 OpenClaw

```bash
# 检查更新
openclaw update

# 更新到最新版本
npm update -g openclaw
# 或
pnpm update -g openclaw

# 更新后运行 doctor 检查
openclaw doctor
```

### 5.4 查看配置位置

```bash
# 查看配置文件路径
openclaw config file

# 查看具体配置项
openclaw config get gateway.port
```

---

## 6. 快速参考卡

```bash
# ===== 安装 =====
npm install -g openclaw@latest
openclaw onboard --install-daemon

# ===== 启动 =====
openclaw gateway --port 18666 --verbose    # 前台运行
openclaw gateway start                      # 后台运行

# ===== 常用 =====
openclaw status                             # 查看状态
openclaw health                             # 健康检查
openclaw doctor                             # 诊断修复
openclaw logs                               # 查看日志
openclaw tui                                # 打开 TUI

# ===== 消息 =====
openclaw message send --to @user --message "Hello"
openclaw agent --message "你的问题" --deliver

# ===== 更新 =====
npm update -g openclaw

# ===== 卸载 =====
openclaw gateway stop
openclaw gateway uninstall
npm uninstall -g openclaw
rm -rf ~/.openclaw
```

---

*文档版本: 2026.3.20*
