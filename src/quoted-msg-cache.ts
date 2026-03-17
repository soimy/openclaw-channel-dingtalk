import {
  clearMessageContextCacheForTest,
  DEFAULT_MEDIA_CONTEXT_TTL_MS,
  resolveQuotedMediaByMsgId,
  upsertInboundMessageContext,
} from "./message-context-store";

export interface DownloadCodeCacheEntry {
  downloadCode?: string;
  msgType: string;
  createdAt: number;
  expiresAt: number;
  spaceId?: string;
  fileId?: string;
}

export function cacheInboundDownloadCode(
  accountId: string,
  conversationId: string,
  msgId: string,
  downloadCode: string | undefined,
  msgType: string,
  createdAt: number,
  extra?: { spaceId?: string; fileId?: string; storePath?: string },
): void {
  if (!extra?.storePath || (!downloadCode && !extra.spaceId && !extra.fileId)) {
    return;
  }
  upsertInboundMessageContext({
    storePath: extra.storePath,
    accountId,
    conversationId,
    msgId,
    createdAt,
    messageType: msgType,
    media: {
      downloadCode,
      spaceId: extra.spaceId,
      fileId: extra.fileId,
    },
    ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
    topic: null,
  });
}

export function getCachedDownloadCode(
  accountId: string,
  conversationId: string,
  msgId: string,
  storePath?: string,
): DownloadCodeCacheEntry | null {
  if (!storePath) {
    return null;
  }
  const resolved = resolveQuotedMediaByMsgId({
    storePath,
    accountId,
    conversationId,
    msgId,
  });
  if (!resolved?.media) {
    return null;
  }
  return {
    downloadCode: resolved.media.downloadCode,
    msgType: resolved.messageType || "file",
    createdAt: resolved.createdAt,
    expiresAt: resolved.expiresAt ?? Date.now() + DEFAULT_MEDIA_CONTEXT_TTL_MS,
    spaceId: resolved.media.spaceId,
    fileId: resolved.media.fileId,
  };
}

export function clearQuotedMsgCacheForTest(): void {
  clearMessageContextCacheForTest();
}
