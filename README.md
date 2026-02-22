# QQ OneBot Bot

基于 OneBot v11 协议的 QQ 机器人，使用 Claude AI 进行对话。

## 特性

- 🤖 支持私聊和群聊
- 🧠 Claude AI 驱动
- 🔌 OneBot v11 协议
- 🔄 反向 WebSocket 连接
- 📝 自动将 Markdown 回复转为 QQ 友好文本

## 架构

```
QQ 消息 → NapCat (Docker) → WebSocket → 本 Bot → Claude AI
```

## 快速开始

### 1. 安装依赖

需要安装 [Bun](https://bun.sh):

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件
```

### 3. 部署 NapCat

```bash
cd deploy/napcat
cp .env.example .env
# 编辑 .env，填写你的 QQ 号
docker compose up -d
```

### 4. 登录 QQ

访问 WebUI 扫码登录：
```
http://127.0.0.1:6099/webui
```

### 5. 配置 OneBot

编辑 `deploy/napcat/napcat/config/onebot11_<QQ号>.json`：

```json
{
  "network": {
    "websocketClients": [
      {
        "name": "QQ Bot",
        "enable": true,
        "url": "ws://host.docker.internal:3002/onebot/v11/ws",
        "token": "",
        "heartInterval": 30000,
        "reconnectInterval": 5000
      }
    ]
  }
}
```

### 6. 启动 Bot

```bash
bun run index.ts
```

## 作为系统服务运行 (macOS)

```bash
# 复制 LaunchAgent 配置
cp deploy/com.fanzhh.qq-onebot-bot.plist ~/Library/LaunchAgents/

# 加载服务
launchctl load ~/Library/LaunchAgents/com.fanzhh.qq-onebot-bot.plist
```

服务健康检查（脚本）：

```bash
chmod +x deploy/service.sh
./deploy/service.sh status      # 查看服务与端口
./deploy/service.sh logs        # 查看运行日志
./deploy/service.sh error-logs  # 查看错误日志
./deploy/service.sh restart     # 重启服务
```

## 使用

- **私聊**: 直接发送消息
- **群聊**: @机器人 + 消息

## 配置说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| ONEBOT_PORT | 3002 | WebSocket 端口 |
| ONEBOT_TOKEN | "" | 访问令牌 |
| CLAUDE_WORKING_DIR | $HOME | Claude 工作目录 |

## 故障排除

### 连接失败

1. 确认 NapCat 已登录
2. 检查 OneBot 配置文件路径
3. 查看日志: `tail -f logs/qq-onebot-bot.log`

### Claude 调用失败

1. 确认 Claude CLI 已安装
2. 检查 CLAUDE_WORKING_DIR 设置

## 许可证

MIT
