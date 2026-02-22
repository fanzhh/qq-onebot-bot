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

// ============== 配置 ==============

const ONEBOT_PORT = parseInt(process.env.ONEBOT_PORT || "3002");
const ONEBOT_TOKEN = process.env.ONEBOT_TOKEN || "";
const CLAUDE_WORKING_DIR = process.env.CLAUDE_WORKING_DIR || process.env.HOME;

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
        console.log("[收到]", JSON.stringify(payload).slice(0, 100));
        
        if (payload.echo && pendingRequests.has(payload.echo)) {
          const { resolve, timer } = pendingRequests.get(payload.echo)!;
          pendingRequests.delete(payload.echo);
          clearTimeout(timer);
          resolve(payload.data);
          return;
        }
        
        if (payload.post_type === "message") {
          handleMessage(payload).catch(console.error);
        }
      } catch {}
    },
    
    close() {
      console.log("⚠️ NapCat 断开");
      wsClient = null;
    },
  },
});

// ============== API 请求 ==============

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

async function handleMessage(event: OneBotEvent) {
  if (event.post_type !== "message") return;
  
  const userId = event.user_id;
  const message = event.message;
  
  let text = "";
  if (typeof message === "string") {
    text = message;
  } else if (Array.isArray(message)) {
    text = message
      .filter((seg): seg is { type: "text"; data: { text: string } } => seg.type === "text")
      .map((seg) => seg.data.text)
      .join("");
  }
  
  if (!text?.trim()) return;
  
  const sender = event.sender || {};
  const nickname = sender.nickname || sender.card || `用户${userId}`;
  
  console.log(`[消息] ${nickname}(${userId}): ${text}`);
  
  try {
    // 调用 Claude 处理消息
    const response = await callClaude(text);
    
    const maxLen = 4000;
    const finalResponse = response.length > maxLen 
      ? response.slice(0, maxLen) + "\n...(截断)" 
      : response;
    
    if (event.message_type === "group") {
      // 群聊需要 @ 机器人
      if (!Array.isArray(message) || !message.some(s => s.type === "at" && String(s.data?.qq) === String(selfId))) return;
      const cleanText = text.replace(/\[CQ:at[^\]]*\]\s*/g, "").trim();
      if (!cleanText) return;
      await sendApiRequest("send_group_msg", { group_id: event.group_id, message: finalResponse });
    } else {
      await sendApiRequest("send_private_msg", { user_id: userId, message: finalResponse });
    }
  } catch (err) {
    console.error("处理错误:", err);
    const errMsg = "❌ 处理出错";
    if (event.message_type === "group") {
      await sendApiRequest("send_group_msg", { group_id: event.group_id, message: errMsg });
    } else {
      await sendApiRequest("send_private_msg", { user_id: userId, message: errMsg });
    }
  }
}

// ============== Claude 调用 ==============

async function callClaude(message: string): Promise<string> {
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
  
  if (exitCode !== 0) {
    console.error("Claude 错误:", stderr);
    throw new Error("Claude 调用失败");
  }
  
  return stdout.trim() || "（无响应）";
}

// ============== 启动 ==============

console.log(`🔌 等待 NapCat 连接 (路径: /onebot/v11/ws)...`);

process.on("SIGINT", () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
