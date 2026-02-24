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

// ============== Dify API 配置 ==============
// 与 gmp-ai-assistant 项目共用相同的环境变量
const DIFY_API_BASE_URL = process.env.DIFY_API_BASE_URL || "http://100.78.159.78/v1";
const DIFY_GMP_QA_API_KEY = process.env.DIFY_GMP_QA_API_KEY || "";
const DIFY_REGULATIONS_API_KEY = process.env.DIFY_REGULATIONS_QA_API_KEY || process.env.DIFY_REGULATIONS_API_KEY || "";
const DIFY_PHARMACOPOEIA_API_KEY = process.env.DIFY_PHARMACOPOEIA_QA_API_KEY || process.env.DIFY_PHARMACOPOEIA_API_KEY || "";

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
  const allowedSourceTypes = new Set(["six-db", "md-doc", "vector-search", "dify-kb", "none"]);
  const structuredMatches = text.match(/\[SOURCE\]\s*([^\n]+)/g) || [];
  structuredMatches.forEach((line) => {
    const item = line.replace(/^\[SOURCE\]\s*/, "").trim();
    const [type] = item.split("|").map((part) => part.trim());
    if (item && type && allowedSourceTypes.has(type)) sources.add(item);
  });

  const urlMatches = text.match(/https?:\/\/[^\s)\]]+/g) || [];
  urlMatches.forEach((url) => sources.add(url));

  const fileMatches = text.match(/[A-Za-z0-9_./-]+\.(md|pdf|docx|doc|xlsx|xls|txt|html)/gi) || [];
  fileMatches.forEach((file) => sources.add(file));

  const lineSourceMatches = text.match(/(?:参考来源|信息来源|来源)[:：]\s*([^\n]+)/g) || [];
  lineSourceMatches.forEach((line) => sources.add(line.replace(/^(?:参考来源|信息来源|来源)[:：]\s*/, "").trim()));

  return Array.from(sources).filter(Boolean).slice(0, 3);
}

function stripSourceLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\[SOURCE\]\s*/.test(line))
    .join("\n")
    .trim();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function buildReplyWithMeta(answer: string, durationMs: number): string {
  const formatted = formatMarkdownForQQ(stripSourceLines(answer));
  const sources = extractSources(answer);
  const sourceText = sources.length > 0 ? sources.join("；") : "来源不足（未提供可验证来源）";
  const meta = `参考来源: ${sourceText}\n回答用时: ${formatDuration(durationMs)}`;
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

// ============ Dify API 调用 ============

// 调用 Dify Workflow API
async function callDifyAPI(query: string, apiKey: string, timeoutMs: number = 60000): Promise<{ answer: string; elapsedTime?: number; totalTokens?: number }> {
  const startTime = Date.now();
  console.log(`[Dify] 调用API，查询: ${query.slice(0, 50)}...`);

  try {
    const response = await fetch(`${DIFY_API_BASE_URL}/workflows/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: { query },
        response_mode: "blocking",
        user: "qq-bot",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Dify] API错误: ${response.status} - ${errorText}`);
      throw new Error(`Dify API错误: ${response.status}`);
    }

    const result = await response.json();
    const data = result.data || {};
    const outputs = data.outputs || {};

    // 尝试多个可能的输出字段名
    const answer = outputs.output || outputs.answer || outputs.text || outputs.result || outputs.response || "未获取到回答";

    console.log(`[Dify] API调用成功，耗时: ${Date.now() - startTime}ms`);

    return {
      answer,
      elapsedTime: data.elapsed_time,
      totalTokens: data.total_tokens,
    };
  } catch (error) {
    console.error(`[Dify] 调用失败:`, error);
    throw error;
  }
}

// ============ 工作群快捷命令系统 ============
// 工作群ID
const WORK_GROUP_ID = 216801329;

// 快捷命令类型
type QuickCommandType = "dify" | "skill" | "help";

// 快捷命令定义
type QuickCommand = {
  name: string;
  description: string;
  type: QuickCommandType;
  skill?: string;
  apiKey?: string;
  buildPrompt?: (args: string) => string;
};

// 获取今日日期字符串（YYYY-MM-DD）
function getTodayDate(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

// 构建事件命令的 prompt（/活动和/事件共用）
function buildEventPrompt(args: string, cmdName: string): string {
  // 解析：/活动 2026/02/24 10:30-11:00 标题
  // 或：/活动 2026/02/24 标题（全天）
  // 或：/活动 10:30-11:00 标题（默认今日）
  // 支持 2026-2-24 或 2026-02-24 格式（月份和日期可以是一位或两位）
  const patternWithDateAndTime = /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)/;
  const patternWithDateAllDay = /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s+(.+)/;
  const patternTimeOnly = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)/;
  const patternTitleOnly = /(.+)/;

  // 匹配：日期 + 时间
  const matchDateTime = args.match(patternWithDateAndTime);
  if (matchDateTime) {
    const date = matchDateTime[1].replace(/\//g, '-');
    const startTime = matchDateTime[2];
    const endTime = matchDateTime[3];
    const title = matchDateTime[4].trim();
    return `【快捷命令：${cmdName}】\n\n直接调用 work-calendar skill 执行：\n在 six_calendar 表插入事件，标题「${title}」，日期 ${date}，时间 ${startTime}-${endTime}。必须写 start_at 和 end_at。\n\n执行后返回：已创建活动「${title}」在 ${date} ${startTime}-${endTime}`;
  }

  // 匹配：日期 + 标题（全天）
  const matchDateAllDay = args.match(patternWithDateAllDay);
  if (matchDateAllDay) {
    const remainingText = matchDateAllDay[2];
    // 检查是否包含时间部分，如果包含则不是全天事件
    if (!/^\d{1,2}:\d{2}/.test(remainingText)) {
      const date = matchDateAllDay[1].replace(/\//g, '-');
      const title = remainingText.trim();
      return `【快捷命令：${cmdName}】\n\n直接调用 work-calendar skill 执行：\n在 six_calendar 表插入全天事件，标题「${title}」，日期 ${date}，start_at 为 00:00:00，end_at 为 23:59:59。\n\n执行后返回：已创建全天活动「${title}」在 ${date}`;
    }
  }

  // 匹配：仅时间 + 标题（默认今日）
  const matchTimeOnly = args.match(patternTimeOnly);
  if (matchTimeOnly) {
    const date = getTodayDate();
    const startTime = matchTimeOnly[1];
    const endTime = matchTimeOnly[2];
    const title = matchTimeOnly[3].trim();
    return `【快捷命令：${cmdName}】\n\n直接调用 work-calendar skill 执行：\n在 six_calendar 表插入事件，标题「${title}」，日期 ${date}（今日），时间 ${startTime}-${endTime}。必须写 start_at 和 end_at。\n\n执行后返回：已创建活动「${title}」在 ${date} ${startTime}-${endTime}`;
  }

  // 匹配：仅标题（默认今日全天）
  const matchTitleOnly = args.match(patternTitleOnly);
  if (matchTitleOnly && matchTitleOnly[1].trim()) {
    const date = getTodayDate();
    const title = matchTitleOnly[1].trim();
    return `【快捷命令：${cmdName}】\n\n直接调用 work-calendar skill 执行：\n在 six_calendar 表插入全天事件，标题「${title}」，日期 ${date}（今日），start_at 为 00:00:00，end_at 为 23:59:59。\n\n执行后返回：已创建全天活动「${title}」在 ${date}`;
  }

  return `【快捷命令：${cmdName}】\n\n格式错误。正确格式：\n${cmdName} 2026/02/24 10:30-11:00 会议标题\n${cmdName} 2026/02/24 全天事件标题\n${cmdName} 10:30-11:00 会议标题（默认今日）\n${cmdName} 会议标题（默认今日全天）`;
}

const QUICK_COMMANDS: Record<string, QuickCommand> = {
  "/活动": {
    name: "/活动",
    description: "添加日历活动，格式：/活动 2026/02/24 10:30-11:00 会议标题",
    type: "skill",
    skill: "work-calendar",
    buildPrompt: (args: string) => buildEventPrompt(args, "/活动"),
  },

  "/事件": {
    name: "/事件",
    description: "添加日历事件（同/活动），格式：/事件 2026/02/24 10:30-11:00 会议标题",
    type: "skill",
    skill: "work-calendar",
    buildPrompt: (args: string) => buildEventPrompt(args, "/事件"),
  },

  "/GMP": {
    name: "/GMP",
    description: "搜索GMP知识库（直接调用Dify API）",
    type: "dify",
    apiKey: DIFY_GMP_QA_API_KEY,
  },

  "/法规": {
    name: "/法规",
    description: "搜索药品监管法规（直接调用Dify API）",
    type: "dify",
    apiKey: DIFY_REGULATIONS_API_KEY,
  },

  "/药典": {
    name: "/药典",
    description: "搜索中国药典四部内容（直接调用Dify API）",
    type: "dify",
    apiKey: DIFY_PHARMACOPOEIA_API_KEY,
  },

  "/SIX": {
    name: "/SIX",
    description: "搜索SIX数据库",
    type: "skill",
    skill: "six-database",
    buildPrompt: (args: string) => `【快捷命令：/SIX】\n\n直接调用 six-database skill 执行：\n查询SIX数据库：${args}\n\n执行SQL查询并返回结果。`,
  },

  "/文档": {
    name: "/文档",
    description: "搜索工作文档",
    type: "skill",
    skill: "work-search",
    buildPrompt: (args: string) => `【快捷命令：/文档】\n\n直接调用 work-search skill 执行：\n搜索工作文档：${args}\n\n在知识库中搜索相关文档，返回结果。`,
  },

  "/help": {
    name: "/help",
    description: "显示所有快捷命令",
    type: "help",
  },
};

// 解析快捷命令
function parseQuickCommand(message: string): { isCommand: boolean; command?: QuickCommand; args?: string } {
  const trimmed = message.trim();

  // 匹配 /命令 格式
  const match = trimmed.match(/^\/([\u4e00-\u9fa5a-zA-Z]+)(?:\s+(.+))?$/);
  if (!match) return { isCommand: false };

  const cmdName = "/" + match[1];
  const args = match[2] || "";

  const command = QUICK_COMMANDS[cmdName];
  if (!command) return { isCommand: false };

  return { isCommand: true, command, args };
}

// 生成帮助信息
function generateHelpMessage(): string {
  const lines = [
    "📋 工作群快捷命令列表：",
    "",
    "  /活动 - 添加日历活动",
    "  /事件 - 添加日历事件（同/活动）",
    "  /GMP - 搜索GMP知识库（Dify API）",
    "  /法规 - 搜索药品监管法规（Dify API）",
    "  /药典 - 搜索中国药典四部内容（Dify API）",
    "  /SIX - 搜索SIX数据库",
    "  /文档 - 搜索工作文档",
    "  /help - 显示所有快捷命令",
    "",
    "💡 提示：快捷命令以 / 开头，直接调用对应服务，不经过AI判断。",
    "",
    "📝 /活动 格式：",
    "  /活动 2026/02/24 10:30-11:00 会议标题",
    "  /活动 2026/02/24 全天事件标题",
    "  /活动 10:30-11:00 会议标题（默认今日）",
    "  /活动 会议标题（默认今日全天）",
  ];
  return lines.join("\n");
}

// 旧的添加事件命令（保留兼容）
function parseAddEventCommand(message: string): { isCommand: boolean; date?: string; startTime?: string; endTime?: string; title?: string } {
  const patternWithTime = /添加事件[：:]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)/i;
  const patternAllDay = /添加事件[：:]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s+(.+)/i;

  const matchWithTime = message.match(patternWithTime);
  if (matchWithTime) {
    return {
      isCommand: true,
      date: matchWithTime[1].replace(/\//g, '-'),
      startTime: matchWithTime[2],
      endTime: matchWithTime[3],
      title: matchWithTime[4].trim(),
    };
  }

  const matchAllDay = message.match(patternAllDay);
  if (matchAllDay) {
    const remainingText = matchAllDay[2];
    if (/^\d{1,2}:\d{2}/.test(remainingText)) {
      return { isCommand: false };
    }
    return {
      isCommand: true,
      date: matchAllDay[1].replace(/\//g, '-'),
      title: remainingText.trim(),
    };
  }

  return { isCommand: false };
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

  // 工作群快捷命令处理（群ID: 216801329）
  const WORK_GROUP_ID = 216801329;
  const isWorkGroup = event.message_type === "group" && event.group_id === WORK_GROUP_ID;
  let isQuickEventCommand = false;

  if (event.message_type === "group") {
    // 群聊需要 @ 机器人
    if (!Array.isArray(message) || !message.some(s => s.type === "at" && String(s.data?.qq) === String(selfId))) {
      console.log(`[跳过] 群聊消息未@机器人`);
      return;
    }
    promptText = text.replace(/\[CQ:at[^\]]*\]\s*/g, "").trim();

    // 工作群快捷命令处理
    if (isWorkGroup) {
      const quickCmd = parseQuickCommand(promptText);

      if (quickCmd.isCommand && quickCmd.command) {
        console.log(`[快捷命令] 检测到: ${quickCmd.command.name}, 类型: ${quickCmd.command.type}`);

        // /help 命令直接返回帮助信息
        if (quickCmd.command.type === "help") {
          const helpMsg = generateHelpMessage();
          sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: helpMsg });
          console.log(`[快捷命令] /help 已发送`);
          return;
        }

        // Dify API 命令 - 直接调用 Dify，不经过 AI
        if (quickCmd.command.type === "dify") {
          console.log(`[快捷命令] 直接调用 Dify API: ${quickCmd.command.name}`);

          // 发送"思考中"提示
          sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: "🤔 正在查询，请稍候..." });

          try {
            const startTime = Date.now();
            const result = await callDifyAPI(quickCmd.args || "", quickCmd.command.apiKey || "", 60000);
            const duration = Date.now() - startTime;

            // 格式化响应
            const formattedAnswer = formatMarkdownForQQ(result.answer);
            const meta = `回答用时: ${formatDuration(duration)}${result.totalTokens ? ` | Tokens: ${result.totalTokens}` : ""}`;
            const finalResponse = `${formattedAnswer}\n\n${meta}`;

            sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: finalResponse });
            console.log(`[快捷命令] Dify API 响应已发送，耗时: ${duration}ms`);
          } catch (error) {
            console.error(`[快捷命令] Dify API 调用失败:`, error);
            sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: "❌ 查询失败，请稍后重试" });
          }
          return;
        }

        // Skill 类型命令 - 构建 prompt 调用 skill
        if (quickCmd.command.type === "skill" && quickCmd.command.buildPrompt) {
          // 构建对应技能的 prompt - 直接指示调用特定 skill，不经过 AI 判断
          promptText = [
            `来源群ID: ${WORK_GROUP_ID}`,
            "",
            `【系统指令】这是快捷命令 ${quickCmd.command.name}，必须直接调用 ${quickCmd.command.skill} skill 执行，不需要 AI 判断或路由。`,
            "",
            quickCmd.command.buildPrompt(quickCmd.args || ""),
            "",
            "【执行要求】",
            "1. 直接调用上述指定的 skill",
            "2. 不需要解释思考过程",
            "3. 不需要请求用户确认",
            "4. 直接返回执行结果",
          ].join("\n");

          isQuickEventCommand = true;
          console.log(`[快捷命令] 已转换 prompt，直接调用 skill: ${quickCmd.command.skill}`);
        }
      }
    }

    if (!promptText) {
      console.log(`[跳过] 群聊消息内容为空`);
      return;
    }
  }

  console.log(`[消息] ${nickname}(${userId}): ${text}`);
  console.log(`[处理] ========== 开始处理消息 ==========`);
  console.log(`[处理] 消息内容: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
  console.log(`[处理] 会话Key: ${chatKey}`);

  try {
    const startTime = Date.now();
    const stepTimes: Record<string, number> = {};

    // Step 1: 构建历史记录
    console.log(`[步骤1] 构建历史记录...`);
    const historyStart = Date.now();
    const historyPrompt = buildPromptWithHistory(chatKey, promptText);
    stepTimes['buildHistory'] = Date.now() - historyStart;
    console.log(`[步骤1] ✓ 完成，耗时: ${stepTimes['buildHistory']}ms, 历史长度: ${historyPrompt.length}字符`);

    // Step 2: 附加群来源
    console.log(`[步骤2] 附加群来源...`);
    const attachStart = Date.now();
    const baseInput = event.message_type === "group" ? attachGroupSource(historyPrompt, event.group_id) : historyPrompt;
    stepTimes['attachSource'] = Date.now() - attachStart;
    console.log(`[步骤2] ✓ 完成，耗时: ${stepTimes['attachSource']}ms`);

    // Step 3: 检测和注入 prompt（跳过快捷命令）
    console.log(`[步骤3] 检测消息模式...`);
    const detectStart = Date.now();
    const forceDirectSql = shouldForceDirectSql(promptText);
    const forceCalendarStartEnd = shouldForceCalendarStartEnd(promptText);
    // 如果是快捷事件命令，跳过任务检测
    const forceTaskWrite = !isQuickEventCommand && shouldForceTaskWrite(promptText);
    stepTimes['detectPatterns'] = Date.now() - detectStart;
    console.log(`[步骤3] ✓ 完成，耗时: ${stepTimes['detectPatterns']}ms`);
    console.log(`[步骤3] 检测结果: SQL=${forceDirectSql}, 日历=${forceCalendarStartEnd}, 任务=${forceTaskWrite}, 快捷命令=${isQuickEventCommand}`);

    // Step 4: 构建 prompt
    const promptStart = Date.now();
    let claudeInput = baseInput;
    if (forceDirectSql) {
      claudeInput = [
        "你必须直接执行 SQL 查询，不要再次请求确认、批准或授权。",
        "如果是 six 数据库相关请求，直接返回可执行 SQL 与查询结果（或明确执行失败原因）。",
        "禁止输出「请确认是否执行」「需要批准」等语句。",
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
    if (forceTaskWrite) {
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
    claudeInput = [
      "请在回答末尾给出最多3行可核验来源，每行格式固定为：[SOURCE] <类型>|<引用>|<证据>。",
      "类型仅允许：six-db、md-doc、vector-search、dify-kb、none。",
      "示例：[SOURCE] six-db|six_risk|SQL: SELECT ...；时间范围: 2025-07-01~now",
      "示例：[SOURCE] md-doc|01_AREAS/work/xx.md|段落: 第3节",
      "若无法给出可核验来源，必须输出：[SOURCE] none|无|无法提供可验证来源。",
      "",
      claudeInput,
    ].join("\n");
    stepTimes['buildPrompt'] = Date.now() - promptStart;
    console.log(`[步骤4] ✓ 完成，耗时: ${stepTimes['buildPrompt']}ms, 最终Prompt长度: ${claudeInput.length}字符`);

    // Step 5: 发送思考中消息
    console.log(`[步骤5] 发送"思考中"提示...`);
    const thinkingStart = Date.now();
    const thinkingMsg = "🤔 正在思考，请稍候...";
    if (event.message_type === "group") {
      sendMessageNoWait("send_group_msg", { group_id: event.group_id, message: thinkingMsg });
    } else {
      sendMessageNoWait("send_private_msg", { user_id: userId, message: thinkingMsg });
    }
    stepTimes['sendThinking'] = Date.now() - thinkingStart;
    console.log(`[步骤5] ✓ 完成，耗时: ${stepTimes['sendThinking']}ms`);

    // Step 6: 调用 AI (使用 Ollama 或 Claude)
    console.log(`[步骤6] 调用AI模型...`);
    console.log(`[步骤6] 输入长度: ${claudeInput.length}字符`);
    const aiStart = Date.now();
    const response = await callAI(claudeInput);
    stepTimes['aiCall'] = Date.now() - aiStart;
    console.log(`[步骤6] ✓ AI响应完成，耗时: ${stepTimes['aiCall']}ms, 响应长度: ${response.length}字符`);

    // Step 7: 记录会话
    console.log(`[步骤7] 记录会话...`);
    const convStart = Date.now();
    appendConversation(chatKey, promptText, response);
    stepTimes['recordConv'] = Date.now() - convStart;
    console.log(`[步骤7] ✓ 完成，耗时: ${stepTimes['recordConv']}ms`);

    const duration = Date.now() - startTime;
    console.log(`[完成] ========== 消息处理完成 ==========`);
    console.log(`[完成] 总耗时: ${duration}ms`);
    console.log(`[性能分析] 详细分解:`);
    console.log(`[性能分析]  - 步骤1-构建历史: ${stepTimes['buildHistory']}ms`);
    console.log(`[性能分析]  - 步骤2-附加来源: ${stepTimes['attachSource']}ms`);
    console.log(`[性能分析]  - 步骤3-模式检测: ${stepTimes['detectPatterns']}ms`);
    console.log(`[性能分析]  - 步骤4-构建Prompt: ${stepTimes['buildPrompt']}ms`);
    console.log(`[性能分析]  - 步骤5-发送思考: ${stepTimes['sendThinking']}ms`);
    console.log(`[性能分析]  - 步骤6-AI调用: ${stepTimes['aiCall']}ms (主要耗时)`);
    console.log(`[性能分析]  - 步骤7-记录会话: ${stepTimes['recordConv']}ms`);
    console.log(`[完成] 响应长度: ${response.length}字符`);
    
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

// ============== AI 调用（Claude CLI + 本地 DeepSeek 服务）=============

// DeepSeek 配置（通过环境变量让 Claude CLI 使用本地服务）
const DEEPSEEK_ENV = {
  ANTHROPIC_BASE_URL: "http://localhost:5001/v1",
  ANTHROPIC_AUTH_TOKEN: "secret-key",
  ANTHROPIC_MODEL: "deepseek-chat",
  ANTHROPIC_SMALL_FAST_MODEL: "deepseek-chat",
};

// 使用 Claude CLI 调用本地 DeepSeek 服务
async function callDeepSeek(
  message: string,
  timeoutMs: number = 20000,
): Promise<string> {
  const callStart = Date.now();
  console.log(`[DeepSeek] Claude CLI + 本地服务 (端口5001), 超时: ${timeoutMs}ms`);

  const proc = Bun.spawn({
    cmd: ["claude", "--print", "--dangerously-skip-permissions", message],
    cwd: CLAUDE_WORKING_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      ...DEEPSEEK_ENV,  // 强制使用本地 DeepSeek 配置
    },
  });

  const timeoutId = setTimeout(() => {
    console.log(`[DeepSeek] 超时 ${timeoutMs}ms，终止进程`);
    proc.kill();
  }, timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    console.log(`[DeepSeek] 完成，耗时: ${Date.now() - callStart}ms，退出码: ${exitCode}`);

    if (exitCode !== 0) {
      console.error(`[DeepSeek] 错误: ${stderr.slice(0, 200)}`);
      throw new Error(`DeepSeek 调用失败: ${exitCode}`);
    }

    return stdout.trim() || "（无响应）";
  } catch (error) {
    proc.kill();
    throw error;
  }
}

// Claude CLI 调用（降级用，使用默认配置）
async function callClaude(
  message: string,
  timeoutMs: number = 20000,
): Promise<string> {
  const callStart = Date.now();
  console.log(`[Claude] 调用开始，超时: ${timeoutMs}ms`);

  const proc = Bun.spawn({
    cmd: ["claude", "--print", "--dangerously-skip-permissions", message],
    cwd: CLAUDE_WORKING_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: undefined },
  });

  const timeoutId = setTimeout(() => {
    console.log(`[Claude] 超时 ${timeoutMs}ms，终止进程`);
    proc.kill();
  }, timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    console.log(`[Claude] 完成，耗时: ${Date.now() - callStart}ms，退出码: ${exitCode}`);

    if (exitCode !== 0) {
      console.error(`[Claude] 错误: ${stderr.slice(0, 200)}`);
      throw new Error(`Claude 调用失败: ${exitCode}`);
    }

    return stdout.trim() || "（无响应）";
  } catch (error) {
    proc.kill();
    throw error;
  }
}

// AI 调用接口 - 优先使用 Claude CLI + 本地 DeepSeek 服务
async function callAI(message: string): Promise<string> {
  const isComplexQuery = message.length > 500 || /分析|总结|比较|查询多个/i.test(message);
  const timeoutMs = isComplexQuery ? 30000 : 20000;

  console.log(`[AI] 调用开始，类型: ${isComplexQuery ? '复杂' : '简单'}, 超时: ${timeoutMs}ms`);

  // 所有查询都通过 Claude CLI + 本地 DeepSeek 服务
  // 这样既能使用 CLAUDE.md 配置，又能调用本地模型
  console.log(`[AI] 使用 Claude CLI + 本地 DeepSeek 服务...`);
  try {
    return await callDeepSeek(message, timeoutMs);
  } catch (error) {
    console.log(`[AI] DeepSeek 失败，降级到默认 Claude: ${error}`);
    return await callClaude(message, timeoutMs);
  }
}

// ============== 定时任务：工作日08:30发送工作提醒 ==============

function isWorkday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5; // 周一到周五
}

function getNextWorkdayMorning(): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(8, 30, 0, 0);

  if (now >= target || !isWorkday(target)) {
    // 今天已经过了08:30或者不是工作日，找下一个工作日
    do {
      target.setDate(target.getDate() + 1);
    } while (!isWorkday(target));
    target.setHours(8, 30, 0, 0);
  }

  return target;
}

async function sendDailyWorkReminder() {
  if (!wsClient || !selfId) {
    console.log("[定时任务] 未连接，跳过发送");
    return;
  }

  console.log("[定时任务] 发送每日工作提醒...");

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 构建提醒消息
  const reminderPrompt = [
    `来源群ID: ${WORK_GROUP_ID}`,
    "",
    `今天是 ${dateStr}，请查询并总结：`,
    "1. 今日未完成的工作事项（来自 six_calendar 今天的事件）",
    "2. 本周其他未完成的工作（来自 six_calendar 本周内未来日期的事件）",
    "",
    "请使用 work-calendar skill 查询日历数据。",
    "",
    "回复格式：",
    "📅 今日工作（日期）：",
    "• 事件1",
    "• 事件2",
    "",
    "📋 本周待办：",
    "• 事件3（日期）",
    "• 事件4（日期）",
    "",
    "💡 快捷命令：/活动 /GMP /法规 /药典 /SIX /文档 /help",
  ].join("\n");

  try {
    const response = await callAI(reminderPrompt);
    sendMessageNoWait("send_group_msg", { group_id: WORK_GROUP_ID, message: response });
    console.log("[定时任务] 工作提醒已发送");
  } catch (error) {
    console.error("[定时任务] 发送失败:", error);
    // 发送简化版提醒
    const simpleMsg = `📅 ${dateStr} 工作提醒\n\n💡 可用快捷命令：\n/活动 - 添加日历活动\n/GMP - 搜索GMP知识（Dify API）\n/法规 - 搜索法规（Dify API）\n/药典 - 搜索药典（Dify API）\n/SIX - 查询数据库\n/文档 - 搜索文档\n/help - 显示所有命令`;
    sendMessageNoWait("send_group_msg", { group_id: WORK_GROUP_ID, message: simpleMsg });
  }
}

function scheduleDailyReminder() {
  const nextRun = getNextWorkdayMorning();
  const delay = nextRun.getTime() - Date.now();

  console.log(`[定时任务] 下次工作提醒时间: ${nextRun.toLocaleString()}，还有 ${Math.round(delay / 1000 / 60)} 分钟`);

  setTimeout(() => {
    sendDailyWorkReminder();
    // 设置下一次
    scheduleDailyReminder();
  }, delay);
}

// ============== 启动 ==============

console.log(`🔌 等待 NapCat 连接 (路径: /onebot/v11/ws)...`);

// 启动定时任务
scheduleDailyReminder();

process.on("SIGINT", () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
