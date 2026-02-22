/**
 * QQ Bot - OneBot v11 反向 WebSocket 版本
 * 
 * 通过 NapCat 连接 QQ，使用 Claude AI 进行对话
 * 
 * 使用方法:
 *   1. 配置 .env 文件
 *   2. 启动 NapCat 并登录 QQ
 *   3. 运行: bun run index.ts
 */

import type { OneBotEvent } from "./src/onebot-types";
import { existsSync } from "node:fs";

// ============== 配置 ==============

const ONEBOT_PORT = parseInt(process.env.ONEBOT_PORT || "3002");
const ONEBOT_TOKEN = process.env.ONEBOT_TOKEN || "";
const configuredClaudeDir = process.env.CLAUDE_WORKING_DIR;
const CLAUDE_WORKING_DIR =
  configuredClaudeDir && existsSync(configuredClaudeDir) ? configuredClaudeDir : process.cwd();
if (configuredClaudeDir && !existsSync(configuredClaudeDir)) {
  console.warn(`[警告] CLAUDE_WORKING_DIR 不存在，回退到当前目录: ${configuredClaudeDir}`);
}

// ============== 状态 ==============

let selfId: number | null = null;
let wsClient: WebSocket | null = null;
const pendingRequests: Map<string, { resolve: Function; reject: Function; timer: Timer }> = new Map();

// ============== 初始化 ==============

console.log("=".repeat(50));
console.log("QQ Bot (OneBot v11 - 反向 WebSocket)");
console.log("=".repeat(50));
console.log(`端口: ${ONEBOT_PORT}`);
console.log(`Claude 工作目录: ${CLAUDE_WORKING_DIR}`);
console.log("");

// ============== WebSocket 服务器 ==============

const server = Bun.serve({
  port: ONEBOT_PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    
    // NapCat 反向 WebSocket 路径
    if (url.pathname === "/onebot/v11/ws" || url.pathname === "/onebot" || url.pathname === "/") {
      const success = server.upgrade(req);
      if (success) return undefined;
    }
    
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(client) {
      console.log("✅ NapCat 已连接");
      wsClient = client as any;
      
      sendApiRequest("get_login_info", {}).then((info: any) => {
        selfId = info.user_id;
        console.log(`🤖 机器人: ${info.nickname} (${info.user_id})`);
      }).catch(console.error);
    },
    
    message(client, data) {
      try {
        const payload = JSON.parse(data as string);
        console.log("[收到]", JSON.stringify(payload).slice(0, 200));

        // 调试：显示所有 post_type
        console.log(`[调试] post_type: ${payload.post_type}, message_type: ${payload.message_type}`);

        if (payload.echo && pendingRequests.has(payload.echo)) {
          const { resolve, timer } = pendingRequests.get(payload.echo)!;
          pendingRequests.delete(payload.echo);
          clearTimeout(timer);
          resolve(payload.data);
          return;
        }

        if (payload.post_type === "message") {
          console.log("[调试] 收到消息事件，调用 handleMessage");
          handleMessage(payload).catch((err) => {
            console.error("[错误] handleMessage 失败:", err);
          });
        } else {
          console.log(`[调试] 非消息事件: ${payload.post_type}`);
        }
      } catch (err) {
        console.error("[错误] 消息处理异常:", err);
      }
    },
    
    close() {
      console.log("⚠️ NapCat 断开");
      wsClient = null;
    },
  },
});

// ============== API 请求 ==============

// 发送消息不等待响应（避免超时问题）
function sendMessageNoWait(action: string, params: any): void {
  if (!wsClient) {
    console.error("[错误] 未连接，无法发送消息");
    return;
  }
  const echo = Math.random().toString(36).substring(2, 15);
  wsClient.send(JSON.stringify({ action, params, echo }));
  console.log(`[发送] ${action} 已发送`);
}

function sendApiRequest(action: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!wsClient) return reject(new Error("未连接"));
    
    const echo = Math.random().toString(36).substring(2, 15);
    const timer = setTimeout(() => {
      pendingRequests.delete(echo);
      reject(new Error("超时"));
    }, 15000);
    
    pendingRequests.set(echo, { resolve, reject, timer });
    wsClient.send(JSON.stringify({ action, params, echo }));
  });
}

// ============== 消息处理 ==============

function formatMarkdownForQQ(input: string): string {
  return input
    // 代码块: 保留内容并标记语言
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      const header = lang ? `[代码:${lang}]` : "[代码]";
      return `${header}\n${String(code).trimEnd()}\n[/代码]`;
    })
    // 行内代码
    .replace(/`([^`\n]+)`/g, "「$1」")
    // 标题
    .replace(/^#{1,6}\s*(.+)$/gm, "【$1】")
    // 粗体/斜体
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // 删除线
    .replace(/~~(.+?)~~/g, "$1")
    // 链接
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    // 引用
    .replace(/^>\s?/gm, "┃ ")
    // 任务列表
    .replace(/^- \[ \]\s+/gm, "☐ ")
    .replace(/^- \[[xX]\]\s+/gm, "☑ ")
    // 列表符号统一
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .trim();
}

async function handleMessage(event: OneBotEvent) {
  if (event.post_type !== "message") return;

  const userId = event.user_id;
  const message = event.message;
  const msgType = event.message_type;

  console.log(`[处理] 消息类型: ${msgType}, 用户: ${userId}`);
  console.log(`[处理] 消息格式: ${typeof message}, 是否数组: ${Array.isArray(message)}`);

  let text = "";
  if (typeof message === "string") {
    text = message;
    console.log(`[处理] 字符串消息: ${text.slice(0, 50)}`);
  } else if (Array.isArray(message)) {
    console.log(`[处理] 数组消息段数: ${message.length}`);
    message.forEach((seg, i) => {
      console.log(`[处理] 消息段[${i}]: type=${seg.type}`);
    });
    text = message
      .filter((seg): seg is { type: "text"; data: { text: string } } => seg.type === "text")
      .map((seg) => seg.data.text)
      .join("");
  }

  console.log(`[处理] 提取文本: ${text.slice(0, 50)}`);

  if (!text?.trim()) {
    console.log(`[跳过] 消息内容为空`);
    return;
  }
  
  const sender = event.sender || {};
  const nickname = sender.nickname || sender.card || `用户${userId}`;

  console.log(`[消息] ${nickname}(${userId}): ${text}`);
  console.log(`[Claude] 开始调用...`);

  try {
    const startTime = Date.now();
    // 调用 Claude 处理消息
    const response = await callClaude(text);
    const duration = Date.now() - startTime;
    console.log(`[Claude] 响应完成，耗时: ${duration}ms, 长度: ${response.length}`);
    
    const qqFriendlyResponse = formatMarkdownForQQ(response);
    const maxLen = 4000;
    const finalResponse = qqFriendlyResponse.length > maxLen
      ? qqFriendlyResponse.slice(0, maxLen) + "\n...(截断)"
      : qqFriendlyResponse;
    
    if (event.message_type === "group") {
      // 群聊需要 @ 机器人
      if (!Array.isArray(message) || !message.some(s => s.type === "at" && String(s.data?.qq) === String(selfId))) {
        console.log(`[跳过] 群聊消息未@机器人`);
        return;
      }
      const cleanText = text.replace(/\[CQ:at[^\]]*\]\s*/g, "").trim();
      if (!cleanText) {
        console.log(`[跳过] 群聊消息内容为空`);
        return;
      }
      console.log(`[发送] 群聊回复 -> ${event.group_id}`);
      // 发送消息不等待响应，避免超时
      sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: finalResponse });
    } else {
      console.log(`[发送] 私聊回复 -> ${userId}`);
      // 发送消息不等待响应，避免超时
      sendMessageNoWait("send_private_msg", { user_id: userId, message: finalResponse });
    }
  } catch (err) {
    console.error("[错误] 消息处理失败:", err);
    const errMsg = "❌ 处理出错";
    if (event.message_type === "group") {
      sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: errMsg });
    } else {
      sendMessageNoWait("send_private_msg", { user_id: userId, message: errMsg });
    }
  }
}

// ============== Claude 调用 ==============

async function callClaude(message: string): Promise<string> {
  console.log(`[Claude] 启动进程，工作目录: ${CLAUDE_WORKING_DIR}`);
  // 使用 Claude CLI 处理消息
  const proc = Bun.spawn({
    cmd: ["claude", "--print", message],
    cwd: CLAUDE_WORKING_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  console.log(`[Claude] 进程退出码: ${exitCode}`);
  if (stderr) {
    console.log(`[Claude] stderr: ${stderr.slice(0, 200)}`);
  }

  if (exitCode !== 0) {
    console.error("[Claude] 错误:", stderr);
    throw new Error("Claude 调用失败");
  }

  return stdout.trim() || "（无响应）";
}

// ============== 启动 ==============

console.log(`🔌 等待 NapCat 连接 (路径: /onebot/v11/ws)...`);

process.on("SIGINT", () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
