/**
 * QQ Bot Platform Adapter
 *
 * Implements PlatformAdapter for Tencent QQ Open Platform.
 * Uses WebSocket long-connection for real-time message receiving.
 *
 * Reference: https://github.com/sliverp/qqbot
 */

import {
  type PlatformAdapter,
  type UniversalMessage,
  type UniversalUser,
  type UniversalChat,
  type UniversalTextMessage,
  type UniversalVoiceMessage,
  type UniversalPhotoMessage,
  type UniversalDocumentMessage,
  type SendMessageOptions,
  type ReplyMarkup,
  type QQBotConfig,
} from "./types";

/**
 * QQ Bot API Client
 *
 * Handles authentication and communication with QQ Open Platform
 */
class QQApiClient {
  private appId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private baseUrl = "https://api.bot.q.qq.com";

  constructor(config: QQBotConfig) {
    this.appId = config.appId;
    this.clientSecret = config.clientSecret;
  }

  /**
   * Get access token (with caching)
   */
  async getAccessToken(): Promise<string> {
    // Check if token is still valid (with 5 minute buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 300000) {
      return this.accessToken;
    }

    const response = await fetch(
      `${this.baseUrl}/gettoken?grant_type=client_credential&appid=${this.appId}&secret=${this.clientSecret}`,
      {
        method: "POST",
        tls: { rejectUnauthorized: false }  // Disable TLS verification for QQ API
      }
    );

    const data = await response.json() as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (data.error) {
      throw new Error(`QQ API error: ${data.error}`);
    }

    this.accessToken = data.access_token || null;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;

    return this.accessToken!;
  }

  /**
   * Send message to QQ
   */
  async sendMessage(
    openid: string,
    content: string | object,
    msgType: 0 | 1 | 2 | 3 | 4 = 0 // 0=text, 1=markdown, 2=ark, 3=embed, 4=media
  ): Promise<{ id: string }> {
    const token = await this.getAccessToken();

    const body = {
      openid,
      msg_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
    };

    const response = await fetch(
      `${this.baseUrl}/v2/openapi/bot/send?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json() as {
      id?: string;
      message?: string;
      retcode?: number;
    };

    if (data.retcode && data.retcode !== 0) {
      throw new Error(`QQ send error: ${data.message} (code: ${data.retcode})`);
    }

    return { id: data.id || "" };
  }

  /**
   * Send media message
   */
  async sendMedia(
    openid: string,
    mediaType: "image" | "voice" | "video" | "file",
    fileUrl: string
  ): Promise<{ id: string }> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}/v2/openapi/bot/send?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openid,
          msg_type: 4, // media
          media: {
            file_type: mediaType === "image" ? 1 : mediaType === "voice" ? 2 : mediaType === "video" ? 3 : 4,
            url: fileUrl,
          },
        }),
      }
    );

    const data = await response.json() as {
      id?: string;
      message?: string;
      retcode?: number;
    };

    return { id: data.id || "" };
  }

  /**
   * Upload media file
   */
  async uploadMedia(
    filePath: string,
    mediaType: "image" | "voice" | "video" | "file"
  ): Promise<string> {
    const token = await this.getAccessToken();
    const file = Bun.file(filePath);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("file_type", String(
      mediaType === "image" ? 1 : mediaType === "voice" ? 2 : mediaType === "video" ? 3 : 4
    ));

    const response = await fetch(
      `${this.baseUrl}/v2/openapi/bot/upload?access_token=${token}`,
      {
        method: "POST",
        body: formData,
      }
    );

    const data = await response.json() as {
      media_url?: string;
      message?: string;
      retcode?: number;
    };

    if (data.retcode && data.retcode !== 0) {
      throw new Error(`QQ upload error: ${data.message}`);
    }

    return data.media_url || "";
  }

  /**
   * Get file URL
   */
  async getFileUrl(fileId: string): Promise<string> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}/v2/openapi/bot/file?access_token=${token}&file_id=${fileId}`,
      { method: "GET" }
    );

    const data = await response.json() as {
      url?: string;
      message?: string;
      retcode?: number;
    };

    return data.url || "";
  }
}

/**
 * Message handler type
 */
type MessageHandler = (message: UniversalMessage) => Promise<void>;
type CallbackHandler = (data: {
  data: string;
  user: UniversalUser;
  chat: UniversalChat;
  messageId: string | number;
}) => Promise<void>;
type CommandHandler = (message: UniversalMessage) => Promise<void>;

/**
 * QQ Bot Platform Adapter Implementation
 */
export class QQBotAdapter implements PlatformAdapter {
  readonly platform = "qq";

  private config: QQBotConfig;
  private apiClient: QQApiClient;
  private allowedUsers: Set<string>;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private ws: WebSocket | null = null;
  private isRunning = false;

  constructor(config: QQBotConfig, allowedUsers: string[] = []) {
    this.config = config;
    this.apiClient = new QQApiClient(config);
    this.allowedUsers = new Set(allowedUsers);
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log("🤖 Starting QQ Bot...");
    console.log(`📱 App ID: ${this.config.appId.slice(0, 8)}...`);
    console.log(`👥 Allowed users: ${this.allowedUsers.size}`);

    // Connect to QQ gateway WebSocket
    await this.connectGateway();

    this.isRunning = true;
    console.log("✅ QQ Bot started");
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    console.log("🛑 Stopping QQ Bot...");
    this.isRunning = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log("✅ QQ Bot stopped");
  }

  /**
   * Connect to QQ gateway
   */
  private async connectGateway(): Promise<void> {
    const token = await this.apiClient.getAccessToken();
    const wsUrl = `wss://api.bot.q.qq.com/gateway/bot?access_token=${token}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("🔗 QQ Gateway connected");
    };

    this.ws.onmessage = (event) => {
      this.handleGatewayMessage(event.data as string).catch((err) => {
        console.error("Gateway message handling error:", err);
      });
    };

    this.ws.onerror = (error) => {
      console.error("QQ Gateway error:", error);
    };

    this.ws.onclose = () => {
      console.log("QQ Gateway disconnected");
      // Auto reconnect after 5 seconds if still running
      if (this.isRunning) {
        setTimeout(() => this.connectGateway(), 5000);
      }
    };
  }

  /**
   * Handle incoming gateway message
   */
  private async handleGatewayMessage(data: string): Promise<void> {
    try {
      const event = JSON.parse(data) as {
        t?: string; // event type
        d?: {
          id?: string;
          author?: { id: string; username?: string };
          content?: string;
          channel_id?: string;
          guild_id?: string;
          attachments?: Array<{
            id: string;
            filename: string;
            content_type?: string;
            size?: number;
            width?: number;
            height?: number;
            duration?: number;
          }>;
          message_reference?: { message_id: string };
        };
        op?: number;
        s?: number;
      };

      // Heartbeat response
      if (event.op === 11 || event.op === 13) {
        return;
      }

      // Message events
      if (event.t === "AT_MESSAGE_CREATE" || event.t === "DIRECT_MESSAGE_CREATE") {
        const msg = event.d;
        if (!msg) return;

        const user: UniversalUser = {
          id: msg.author?.id || "unknown",
          username: msg.author?.username,
        };

        const chat: UniversalChat = {
          id: msg.channel_id || msg.author?.id || "unknown",
          type: event.t === "DIRECT_MESSAGE_CREATE" ? "private" : "group",
        };

        // Parse command
        let content = msg.content || "";
        const commandMatch = content.match(/^\/(\w+)\s*(.*)/);

        if (commandMatch) {
          const command = commandMatch[1];
          const handler = this.commandHandlers.get(command);

          if (handler) {
            const commandMessage: UniversalTextMessage = {
              type: "text",
              messageId: msg.id || Date.now(),
              user,
              chat,
              text: content,
              timestamp: Date.now(),
            };
            await handler(commandMessage);
            return;
          }
        }

        // Process attachments
        if (msg.attachments && msg.attachments.length > 0) {
          for (const attachment of msg.attachments) {
            const contentType = attachment.content_type || "";
            const isImage = contentType.startsWith("image/");
            const isAudio = contentType.startsWith("audio/");
            const isVoice = contentType.includes("voice") || contentType.includes("silk");

            if (isImage) {
              const photoMessage: UniversalPhotoMessage = {
                type: "photo",
                messageId: msg.id || Date.now(),
                user,
                chat,
                photos: [{
                  fileId: attachment.id,
                  width: attachment.width || 0,
                  height: attachment.height || 0,
                  fileSize: attachment.size,
                }],
                caption: content,
                timestamp: Date.now(),
              };
              await this.dispatchEvent(photoMessage);
            } else if (isAudio || isVoice) {
              const voiceMessage: UniversalVoiceMessage = {
                type: "voice",
                messageId: msg.id || Date.now(),
                user,
                chat,
                fileId: attachment.id,
                duration: attachment.duration,
                mimeType: contentType,
                timestamp: Date.now(),
              };
              await this.dispatchEvent(voiceMessage);
            } else {
              const docMessage: UniversalDocumentMessage = {
                type: "document",
                messageId: msg.id || Date.now(),
                user,
                chat,
                fileId: attachment.id,
                fileName: attachment.filename,
                mimeType: contentType,
                fileSize: attachment.size,
                caption: content,
                timestamp: Date.now(),
              };
              await this.dispatchEvent(docMessage);
            }
          }
        } else if (content) {
          // Text only message
          const textMessage: UniversalTextMessage = {
            type: "text",
            messageId: msg.id || Date.now(),
            user,
            chat,
            text: content,
            timestamp: Date.now(),
            replyToMessageId: msg.message_reference?.message_id,
          };
          await this.dispatchEvent(textMessage);
        }
      }
    } catch (err) {
      console.error("Failed to parse gateway message:", err);
    }
  }

  /**
   * Dispatch event to all handlers
   */
  private async dispatchEvent(message: UniversalMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (err) {
        console.error("Message handler error:", err);
      }
    }
  }

  /**
   * Check if user is authorized
   */
  isUserAuthorized(userId: string | number): boolean {
    const idStr = String(userId);
    // If no allowed users defined, allow all
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(idStr);
  }

  // ============== PlatformAdapter Implementation ==============

  async sendMessage(
    chatId: string | number,
    text: string,
    options?: SendMessageOptions & { replyMarkup?: ReplyMarkup }
  ): Promise<{ messageId: string | number }> {
    // Use markdown if specified
    const msgType = options?.parseMode === "markdown" ? 1 : 0;

    // Handle inline keyboard by appending buttons as text
    let finalText = text;
    if (options?.replyMarkup?.inlineKeyboard) {
      const buttons = options.replyMarkup.inlineKeyboard
        .flat()
        .map((btn) => `[${btn.text}]`)
        .join(" ");
      finalText += `\n\n${buttons}`;
    }

    const result = await this.apiClient.sendMessage(
      String(chatId),
      finalText,
      msgType as 0 | 1
    );

    return { messageId: result.id };
  }

  async editMessageText(
    chatId: string | number,
    messageId: string | number,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    // QQ doesn't have a direct edit API, so we send a new message
    // In practice, you might want to track and delete old messages
    await this.sendMessage(chatId, `[编辑] ${text}`, options);
  }

  async deleteMessage(
    chatId: string | number,
    messageId: string | number
  ): Promise<void> {
    // QQ Bot API may support deletion in future versions
    console.warn("QQ Bot: deleteMessage not fully supported");
  }

  async sendVoice(
    chatId: string | number,
    voicePath: string,
    caption?: string
  ): Promise<{ messageId: string | number }> {
    // Upload and send voice
    const mediaUrl = await this.apiClient.uploadMedia(voicePath, "voice");
    const result = await this.apiClient.sendMedia(
      String(chatId),
      "voice",
      mediaUrl
    );

    if (caption) {
      await this.sendMessage(chatId, caption);
    }

    return { messageId: result.id };
  }

  async sendPhoto(
    chatId: string | number,
    photoPath: string,
    caption?: string
  ): Promise<{ messageId: string | number }> {
    const mediaUrl = await this.apiClient.uploadMedia(photoPath, "image");
    const result = await this.apiClient.sendMedia(
      String(chatId),
      "image",
      mediaUrl
    );

    if (caption) {
      await this.sendMessage(chatId, caption);
    }

    return { messageId: result.id };
  }

  async sendDocument(
    chatId: string | number,
    documentPath: string,
    caption?: string
  ): Promise<{ messageId: string | number }> {
    const mediaUrl = await this.apiClient.uploadMedia(documentPath, "file");
    const result = await this.apiClient.sendMedia(
      String(chatId),
      "file",
      mediaUrl
    );

    if (caption) {
      await this.sendMessage(chatId, caption);
    }

    return { messageId: result.id };
  }

  async downloadFile(fileId: string, destPath: string): Promise<string> {
    const url = await this.apiClient.getFileUrl(fileId);
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    await Bun.write(destPath, buffer);
    return destPath;
  }

  async sendChatAction(
    chatId: string | number,
    action: "typing" | "upload_voice" | "upload_photo" | "upload_document"
  ): Promise<void> {
    // QQ doesn't have typing indicators
    // Could potentially send a temporary message
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCallbackQuery(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }
}

/**
 * Create adapter context for a message
 */
export function createQQAdapterContext(
  adapter: QQBotAdapter,
  message: UniversalMessage
) {
  return {
    adapter,
    message,
    user: message.user,
    chat: message.chat,

    async reply(
      text: string,
      options?: SendMessageOptions
    ): Promise<{ messageId: string | number }> {
      return adapter.sendMessage(message.chat.id, text, options);
    },

    async replyWithVoice(
      voicePath: string,
      caption?: string
    ): Promise<{ messageId: string | number }> {
      return adapter.sendVoice(message.chat.id, voicePath, caption);
    },

    async replyWithPhoto(
      photoPath: string,
      caption?: string
    ): Promise<{ messageId: string | number }> {
      return adapter.sendPhoto(message.chat.id, photoPath, caption);
    },

    async replyWithDocument(
      docPath: string,
      caption?: string
    ): Promise<{ messageId: string | number }> {
      return adapter.sendDocument(message.chat.id, docPath, caption);
    },

    async editMessage(
      messageId: string | number,
      text: string
    ): Promise<void> {
      return adapter.editMessageText(message.chat.id, messageId, text);
    },

    async deleteMessage(messageId: string | number): Promise<void> {
      return adapter.deleteMessage(message.chat.id, messageId);
    },

    async sendAction(
      action: "typing" | "upload_voice" | "upload_photo" | "upload_document"
    ): Promise<void> {
      return adapter.sendChatAction(message.chat.id, action);
    },
  };
}

// Re-export types
export type { QQBotConfig };
