/**
 * QQ Bot - OneBot v11 反向 WebSocket 版本
 * 
 * 路径: /onebot/v11/ws (NapCat 要求)
 */

import type { OneBotEvent } from "./src/adapters/onebot-types";
import { session } from "./src/session";
import { WORKING_DIR } from "./src/config";

const ONEBOT_PORT = parseInt(process.env.ONEBOT_PORT || "3002");

let selfId: number | null = null;
let wsClient: WebSocket | null = null;
const pendingRequests: Map<string, { resolve: Function; reject: Function; timer: Timer }> = new Map();

console.log("=".repeat(50));
console.log("QQ Bot (OneBot v11 - 反向 WebSocket)");
console.log("=".repeat(50));
console.log(`端口: ${ONEBOT_PORT}`);
console.log(`Working Dir: ${WORKING_DIR}`);

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
    let response = "";
    await session.sendMessageStreaming(text, `QQ${userId}`, userId!, (type, content) => {
      if (type === "text") response += content;
    });
    
    const maxLen = 4000;
    if (response.length > maxLen) response = response.slice(0, maxLen) + "\n...(截断)";
    
    if (event.message_type === "group") {
      if (!Array.isArray(message) || !message.some(s => s.type === "at" && String(s.data?.qq) === String(selfId))) return;
      const cleanText = text.replace(/\[CQ:at[^\]]*\]\s*/g, "").trim();
      if (!cleanText) return;
      await sendApiRequest("send_group_msg", { group_id: event.group_id, message: response });
    } else {
      await sendApiRequest("send_private_msg", { user_id: userId, message: response });
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

console.log(`\n🔌 等待 NapCat 连接 (路径: /onebot/v11/ws)...`);

process.on("SIGINT", () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
