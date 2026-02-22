/**
 * Platform-agnostic bot adapter types.
 *
 * This abstraction layer allows the same bot logic to work with
 * multiple messaging platforms (Telegram, QQ, etc.)
 */

/**
 * Universal user information
 */
export interface UniversalUser {
  id: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Universal chat information
 */
export interface UniversalChat {
  id: string | number;
  type: "private" | "group" | "channel";
  title?: string;
}

/**
 * Universal message types
 */
export interface UniversalTextMessage {
  type: "text";
  messageId: string | number;
  user: UniversalUser;
  chat: UniversalChat;
  text: string;
  timestamp: number;
  replyToMessageId?: string | number;
}

export interface UniversalVoiceMessage {
  type: "voice";
  messageId: string | number;
  user: UniversalUser;
  chat: UniversalChat;
  fileId: string;
  duration?: number;
  mimeType?: string;
  timestamp: number;
}

export interface UniversalPhotoMessage {
  type: "photo";
  messageId: string | number;
  user: UniversalUser;
  chat: UniversalChat;
  photos: Array<{
    fileId: string;
    width: number;
    height: number;
    fileSize?: number;
  }>;
  caption?: string;
  timestamp: number;
}

export interface UniversalDocumentMessage {
  type: "document";
  messageId: string | number;
  user: UniversalUser;
  chat: UniversalChat;
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  caption?: string;
  timestamp: number;
}

export type UniversalMessage =
  | UniversalTextMessage
  | UniversalVoiceMessage
  | UniversalPhotoMessage
  | UniversalDocumentMessage;

/**
 * Message send options
 */
export interface SendMessageOptions {
  parseMode?: "none" | "markdown" | "html";
  disableNotification?: boolean;
  replyToMessageId?: string | number;
}

/**
 * Inline keyboard button
 */
export interface InlineKeyboardButton {
  text: string;
  callbackData?: string;
  url?: string;
}

/**
 * Reply markup
 */
export interface ReplyMarkup {
  inlineKeyboard?: InlineKeyboardButton[][];
}

/**
 * Platform adapter interface
 *
 * Each platform (Telegram, QQ) must implement this interface
 */
export interface PlatformAdapter {
  readonly platform: string;

  // Send methods
  sendMessage(
    chatId: string | number,
    text: string,
    options?: SendMessageOptions & { replyMarkup?: ReplyMarkup }
  ): Promise<{ messageId: string | number }>;

  editMessageText(
    chatId: string | number,
    messageId: string | number,
    text: string,
    options?: SendMessageOptions
  ): Promise<void>;

  deleteMessage(
    chatId: string | number,
    messageId: string | number
  ): Promise<void>;

  // File methods
  sendVoice(
    chatId: string | number,
    voicePath: string,
    caption?: string
  ): Promise<{ messageId: string | number }>;

  sendPhoto(
    chatId: string | number,
    photoPath: string,
    caption?: string
  ): Promise<{ messageId: string | number }>;

  sendDocument(
    chatId: string | number,
    documentPath: string,
    caption?: string
  ): Promise<{ messageId: string | number }>;

  downloadFile(fileId: string, destPath: string): Promise<string>;

  // Chat actions
  sendChatAction(
    chatId: string | number,
    action: "typing" | "upload_voice" | "upload_photo" | "upload_document"
  ): Promise<void>;

  // Message handler registration
  onMessage(handler: (message: UniversalMessage) => Promise<void>): void;

  onCallbackQuery(
    handler: (data: {
      data: string;
      user: UniversalUser;
      chat: UniversalChat;
      messageId: string | number;
    }) => Promise<void>
  ): void;

  onCommand(
    command: string,
    handler: (message: UniversalMessage) => Promise<void>
  ): void;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Utility
  isUserAuthorized(userId: string | number): boolean;
}

/**
 * Adapter context for handlers
 *
 * Provides a unified interface for handlers to interact with any platform
 */
export interface AdapterContext {
  adapter: PlatformAdapter;
  message: UniversalMessage;
  user: UniversalUser;
  chat: UniversalChat;

  // Convenience methods
  reply(text: string, options?: SendMessageOptions): Promise<{ messageId: string | number }>;
  replyWithVoice(voicePath: string, caption?: string): Promise<{ messageId: string | number }>;
  replyWithPhoto(photoPath: string, caption?: string): Promise<{ messageId: string | number }>;
  replyWithDocument(docPath: string, caption?: string): Promise<{ messageId: string | number }>;
  editMessage(messageId: string | number, text: string): Promise<void>;
  deleteMessage(messageId: string | number): Promise<void>;
  sendAction(action: "typing" | "upload_voice" | "upload_photo" | "upload_document"): Promise<void>;
}

/**
 * Platform-specific config
 */
export interface QQBotConfig {
  appId: string;
  clientSecret: string;
  sandbox?: boolean;
}

export interface TelegramBotConfig {
  token: string;
  allowedUsers: number[];
}

export type BotConfig = QQBotConfig | TelegramBotConfig;
