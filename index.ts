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
const CLAUDE_MODEL_LABEL = process.env.CLAUDE_MODEL_LABEL || "Claude CLI（模型名未公开）";
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
const conversationHistory: Map<string, Array<{ role: "user" | "assistant"; text: string }>> = new Map();
const MAX_HISTORY_MESSAGES = 12;
let connectionSeq = 0;
let activeConnectionId = 0;
let connectedAt = 0;
let wsMessageCount = 0;

// ============== 初始化 ==============

console.log("=".repeat(50));
console.log("QQ Bot (OneBot v11 - 反向 WebSocket)");
console.log("=".repeat(50));
console.log(`端口: ${ONEBOT_PORT}`);
console.log(`Claude 工作目录: ${CLAUDE_WORKING_DIR}`);
console.log(`回答模型标识: ${CLAUDE_MODEL_LABEL}`);
console.log("");

// ============== WebSocket 服务器 ==============

const server = Bun.serve({
  port: ONEBOT_PORT,
  hostname: "0.0.0.0",
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
      connectionSeq += 1;
      activeConnectionId = connectionSeq;
      connectedAt = Date.now();
      wsMessageCount = 0;
      console.log("✅ NapCat 已连接");
      console.log(`[连接] conn#${activeConnectionId} 已建立`);
      wsClient = client as any;
      
      sendApiRequest("get_login_info", {}).then((info: any) => {
        selfId = info.user_id;
        console.log(`🤖 机器人: ${info.nickname} (${info.user_id})`);
      }).catch(console.error);
    },
    
    message(client, data) {
      try {
        wsMessageCount += 1;
        console.log(`[连接] conn#${activeConnectionId} 收包#${wsMessageCount}, bytes=${String(data).length}`);
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
    
    close(client, code, reason) {
      const onlineMs = connectedAt ? Date.now() - connectedAt : 0;
      console.error(`⚠️ NapCat 断开`);
      console.error(`[连接] conn#${activeConnectionId} 已关闭, code=${code}, reason=${reason || "无"}, 在线=${onlineMs}ms, 收包=${wsMessageCount}`);
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
  try {
    wsClient.send(JSON.stringify({ action, params, echo }));
    console.log(`[发送] ${action} 已发送, conn#${activeConnectionId}, echo=${echo}`);
  } catch (err) {
    console.error(`[错误] ${action} 发送失败, conn#${activeConnectionId}:`, err);
  }
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
    try {
      wsClient.send(JSON.stringify({ action, params, echo }));
      console.log(`[发送] ${action} 请求, conn#${activeConnectionId}, echo=${echo}`);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(echo);
      reject(err);
    }
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

function buildPromptWithHistory(chatKey: string, userMessage: string): string {
  const history = conversationHistory.get(chatKey) || [];
  if (history.length === 0) return userMessage;

  const historyText = history
    .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.text}`)
    .join("\n");

  return [
    "以下是同一会话最近的对话记录，请结合上下文回答，避免重复：",
    historyText,
    "",
    `用户: ${userMessage}`,
  ].join("\n");
}

function appendConversation(chatKey: string, userMessage: string, assistantMessage: string): void {
  const history = conversationHistory.get(chatKey) || [];
  history.push({ role: "user", text: userMessage });
  history.push({ role: "assistant", text: assistantMessage });
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  conversationHistory.set(chatKey, history);
}

function extractSources(text: string): string[] {
  const sources = new Set<string>();
  const urlMatches = text.match(/https?:\/\/[^\s)\]]+/g) || [];
  urlMatches.forEach((url) => sources.add(url));

  const fileMatches = text.match(/[A-Za-z0-9_./-]+\.(md|pdf|docx|doc|xlsx|xls|txt|html)/gi) || [];
  fileMatches.forEach((file) => sources.add(file));

  const lineSourceMatches = text.match(/(?:信息来源|来源)[:：]\s*([^\n]+)/g) || [];
  lineSourceMatches.forEach((line) => sources.add(line.replace(/^(?:信息来源|来源)[:：]\s*/, "").trim()));

  return Array.from(sources).filter(Boolean).slice(0, 3);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function buildReplyWithMeta(answer: string, durationMs: number): string {
  const formatted = formatMarkdownForQQ(answer);
  const sources = extractSources(answer);
  const sourceText = sources.length > 0 ? sources.join("；") : "未提供显式来源（基于工作上下文生成）";
  const meta = `信息来源: ${sourceText}\n使用模型: ${CLAUDE_MODEL_LABEL}\n回答用时: ${formatDuration(durationMs)}`;
  const maxLen = 4000;

  if (formatted.length + meta.length + 2 <= maxLen) {
    return `${formatted}\n\n${meta}`;
  }

  const available = Math.max(0, maxLen - meta.length - 9);
  const clipped = `${formatted.slice(0, available)}...(截断)`;
  return `${clipped}\n\n${meta}`;
}

function attachGroupSource(message: string, groupId: number): string {
  return `来源群ID: ${groupId}\n\n${message}`;
}

function shouldForceDirectSql(message: string): boolean {
  return /(查询|执行).*(six|数据库|sql)|six.*(数据库|sql)/i.test(message);
}

function shouldForceCalendarStartEnd(message: string): boolean {
  const isSixCalendarWrite = /(?:往|向)?\s*six\s*日历.*(?:写入|添加|新增|创建)/i.test(message);
  const hasChineseRange = /\d{1,2}点(?:半)?到\d{1,2}点(?:半)?/.test(message);
  return isSixCalendarWrite && hasChineseRange;
}

function shouldForceTaskWrite(message: string): boolean {
  // 检测任务/待办/Todo 添加请求
  const taskPatterns = [
    /(?:添加|创建|新建|记).*(?:任务|todo|待办|待处理)/i,
    /(?:帮?我?)?(?:记|加|添).*(?:件事|个任务)/i,
    /(?:提醒|通知).*(?:我|自己)/i,
  ];
  return taskPatterns.some(pattern => pattern.test(message));
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
  const chatKey = event.message_type === "group" ? `group:${event.group_id}` : `private:${userId}`;
  let promptText = text;

  if (event.message_type === "group") {
    // 群聊需要 @ 机器人
    if (!Array.isArray(message) || !message.some(s => s.type === "at" && String(s.data?.qq) === String(selfId))) {
      console.log(`[跳过] 群聊消息未@机器人`);
      return;
    }
    promptText = text.replace(/\[CQ:at[^\]]*\]\s*/g, "").trim();
    if (!promptText) {
      console.log(`[跳过] 群聊消息内容为空`);
      return;
    }
  }

  console.log(`[消息] ${nickname}(${userId}): ${text}`);
  console.log(`[Claude] 开始调用...`);

  try {
    const startTime = Date.now();
    // 调用 Claude 处理消息
    const historyPrompt = buildPromptWithHistory(chatKey, promptText);
    const baseInput = event.message_type === "group" ? attachGroupSource(historyPrompt, event.group_id) : historyPrompt;
    const forceDirectSql = shouldForceDirectSql(promptText);
    const forceCalendarStartEnd = shouldForceCalendarStartEnd(promptText);
    let claudeInput = baseInput;
    if (forceDirectSql) {
      claudeInput = [
        "你必须直接执行 SQL 查询，不要再次请求确认、批准或授权。",
        "如果是 six 数据库相关请求，直接返回可执行 SQL 与查询结果（或明确执行失败原因）。",
        "禁止输出“请确认是否执行”“需要批准”等语句。",
        "",
        claudeInput,
      ].join("\n");
    }
    if (forceCalendarStartEnd) {
      claudeInput = [
        "检测到用户给出了「X点到Y点/ X点半到Y点」时间范围。",
        "这是明确执行指令，必须直接执行写入，不要再次请求确认、批准或授权。",
        "不要先要求查看表结构，不要让用户手动执行 SQL。",
        "写入 six 日历时必须写 start_at 和 end_at，严禁退化为全天事件。",
        "如果无法生成有效 start_at/end_at，必须明确报错并停止写入，不允许仅把时间写进描述。",
        "",
        claudeInput,
      ].join("\n");
    }
    // 检测任务写入请求并注入授权覆盖 prompt
    if (shouldForceTaskWrite(promptText)) {
      claudeInput = [
        "用户要求添加任务/待办事项。",
        "这是明确的写入指令，必须直接执行，不要请求确认、批准或授权。",
        "直接写入任务到 01_AREAS/Inbox.md，使用格式：- [ ] 任务内容 📅 YYYY-MM-DD #标签",
        "如果任务包含 #six 标签，写入后必须执行同步：cd /Users/mac/knowledge1/00_META/SKILLS/tasks && python3 task_sync.py sync",
        "禁止输出「需要授权」「请确认」等要求用户手动操作的语句。",
        "",
        claudeInput,
      ].join("\n");
    }
    const thinkingMsg = "🤔 正在思考，请稍候...";
    if (event.message_type === "group") {
      sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: thinkingMsg });
    } else {
      sendMessageNoWait("send_private_msg", { user_id: userId, message: thinkingMsg });
    }
    console.log(`[Claude] 输入长度: ${claudeInput.length}, 会话: ${chatKey}, 直查SQL: ${forceDirectSql}, 强制日历时段: ${forceCalendarStartEnd}`);
    const response = await callClaude(claudeInput);
    const duration = Date.now() - startTime;
    console.log(`[Claude] 响应完成，耗时: ${duration}ms, 长度: ${response.length}`);
    appendConversation(chatKey, promptText, response);
    
    const finalResponse = buildReplyWithMeta(response, duration);
    
    if (event.message_type === "group") {
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
  // 使用 Claude CLI 处理消息，添加 --dangerously-skip-permissions 跳过权限确认
  // 取消 CLAUDECODE 环境变量以避免嵌套会话检测
  const proc = Bun.spawn({
    cmd: ["claude", "--print", "--dangerously-skip-permissions", message],
    cwd: CLAUDE_WORKING_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: undefined },
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
