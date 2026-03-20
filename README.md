# @cass/openclaw - 定制版 🦞 OpenClaw — Personal AI Assistant

基于 OpenClaw 的定制版本，支持内网部署。

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

---

## 快速开始

### 1. 安装

```bash
# 内网镜像安装（推荐）
pnpm add -g @cass/openclaw@latest --registry http://10.118.38.235:4873

# 或使用 npm
npm install -g @cass/openclaw@latest --registry http://10.118.38.235:4873
```

### 2. 启动

#### 首次启动（未配置过）

```bash
# 启动 Gateway（首次启动会引导配置）
openclaw-cass gateway --port 18666
```

首次启动会进入交互式配置向导，你需要：

1. 选择 Gateway 模式（local/remote）
2. 设置端口（建议 18666）
3. 配置认证 token
4. 配置消息通道（可选）
5. 配置 Skills（可选）

配置完成后，Gateway 会自动启动。

#### 已有配置（之前配置过）

如果之前已经配置过 OpenClaw，直接运行：

```bash
# 启动 Gateway
openclaw-cass gateway --port 18666

# 或者后台运行
openclaw-cass gateway start
```

配置文件位置：`~/.openclaw/openclaw.json`

#### 常用命令

```bash
# 查看状态
openclaw-cass status

# 查看日志
openclaw-cass logs

# 重启
openclaw-cass gateway restart

# 停止
openclaw-cass gateway stop
```

---

## 版本控制

**当前版本**：v3.14（最新稳定版）

**分支管理**：

- `v3.8`：历史稳定版
- `remote`：远程版本
- `dev`：开发版
- `v3.14`：最新稳定版

---

## 特色功能

### 下可兼容，上可拓展

- 可和官方版本同时使用，端口不同
- 可自定义源码的 systemPrompt、skills
- 同时兼容 remote 分支更新

### 玩法升级

- 接入开源项目《像素办公室》
- 接入 `session_send`、`sessions_spawn` 任务监听
- 实现任务面板查看

---

## 常见问题

### 端口被占用

```bash
# 查看端口占用
lsof -i :18666

# 更换端口
openclaw-cass gateway --port 18667
```

### 查看版本

```bash
openclaw-cass --version
```

### 卸载

```bash
pnpm remove -g @cass/openclaw --registry http://10.118.38.235:4873
```
