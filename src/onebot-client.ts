/**
 * OneBot v11 WebSocket 客户端 (Bun 原生版本)
 *
 * 使用 Bun 内置的 WebSocket API
 */

import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage } from "./onebot-types";

interface OneBotClientOptions {
  wsUrl: string;
  accessToken?: string;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000;
  private selfId: number | null = null;
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private pendingMessages: Array<{ action: string; params: any }> = [];
  private lastMessageAt = 0;
  private messageHandlers: Map<string, (data: any) => void> = new Map();

  constructor(options: OneBotClientOptions) {
    super();
    this.options = options;
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setSelfId(id: number) {
    this.selfId = id;
  }

  connect() {
    this.cleanup();

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    try {
      // Bun 原生 WebSocket
      this.ws = new WebSocket(this.options.wsUrl, { headers });

      this.ws.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        this.emit("connect");
        console.log("[QQ] Connected to OneBot server");

        // 发送排队消息
        if (this.pendingMessages.length > 0) {
          const toFlush = this.pendingMessages.splice(0, this.pendingMessages.length);
          let sent = 0;
          for (const item of toFlush) {
            if (this.safeSend(item.action, item.params)) {
              sent += 1;
            }
          }
          console.log(`[QQ] Flushed ${sent}/${toFlush.length} queued message(s)`);
        }

        this.startHeartbeat();
      });

      this.ws.addEventListener("message", (event) => {
        this.lastMessageAt = Date.now();
        try {
          const payload = JSON.parse(event.data as string) as OneBotEvent & { echo?: string; status?: string; data?: any };

          // 处理 API 响应
          if (payload.echo && this.messageHandlers.has(payload.echo)) {
            const handler = this.messageHandlers.get(payload.echo)!;
            this.messageHandlers.delete(payload.echo);
            handler(payload);
            return;
          }

          // 忽略心跳
          if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
            this.emit("heartbeat", payload);
            return;
          }

          this.emit("message", payload);
        } catch (err) {
          // 忽略非 JSON
        }
      });

      this.ws.addEventListener("close", () => {
        this.handleDisconnect();
      });

      this.ws.addEventListener("error", (err) => {
        console.error("[QQ] WebSocket error:", err);
        this.handleDisconnect();
      });

    } catch (err) {
      console.error("[QQ] Failed to connect:", err);
      this.scheduleReconnect();
    }
  }

  private cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageHandlers.clear();
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const staleMs = Date.now() - this.lastMessageAt;
      if (staleMs > 180000) {
        console.warn(`[QQ] No traffic for ${Math.round(staleMs / 1000)}s, reconnecting...`);
        this.handleDisconnect();
      }
    }, 45000);
  }

  private handleDisconnect() {
    this.cleanup();
    this.emit("disconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`[QQ] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts + 1})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  // ============== API 方法 ==============

  sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    this.send("send_private_msg", { user_id: userId, message });
  }

  async sendPrivateMsgAck(userId: number, message: OneBotMessage | string): Promise<any> {
    return this.sendWithResponse("send_private_msg", { user_id: userId, message }, 15000);
  }

  sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    this.send("send_group_msg", { group_id: groupId, message });
  }

  async sendGroupMsgAck(groupId: number, message: OneBotMessage | string): Promise<any> {
    return this.sendWithResponse("send_group_msg", { group_id: groupId, message }, 15000);
  }

  async getLoginInfo(): Promise<any> {
    return this.sendWithResponse("get_login_info", {});
  }

  async getGroupList(): Promise<any[]> {
    return this.sendWithResponse("get_group_list", {});
  }

  async getFriendList(): Promise<any[]> {
    return this.sendWithResponse("get_friend_list", {});
  }

  // ============== 内部方法 ==============

  private sendWithResponse(action: string, params: any, timeoutMs: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }

      const echo = Math.random().toString(36).substring(2, 15);

      const timer = setTimeout(() => {
        this.messageHandlers.delete(echo);
        reject(new Error("Request timeout"));
      }, timeoutMs);

      this.messageHandlers.set(echo, (data) => {
        clearTimeout(timer);
        if (data.status === "ok") {
          resolve(data.data);
        } else {
          reject(new Error(data.msg || "API request failed"));
        }
      });

      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  private send(action: string, params: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.safeSend(action, params);
    } else {
      if (this.pendingMessages.length < 200) {
        this.pendingMessages.push({ action, params });
      }
      console.warn(`[QQ] WebSocket not open; queued action=${action}`);
      if (!this.reconnectTimer) {
        this.scheduleReconnect();
      }
    }
  }

  private safeSend(action: string, params: any): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ action, params }));
      return true;
    } catch {
      if (this.pendingMessages.length < 200) {
        this.pendingMessages.push({ action, params });
      }
      if (!this.reconnectTimer) {
        this.scheduleReconnect();
      }
      return false;
    }
  }

  disconnect() {
    this.cleanup();
  }
}
