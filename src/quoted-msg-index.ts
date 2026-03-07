import * as fs from "node:fs";
import * as path from "node:path";

const INDEX_FILE_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface QuotedCardIndexEntry {
  content: string;
  createdAt: number;
  expiresAt: number;
}

export interface QuotedFileIndexEntry {
  downloadCode?: string;
  msgType: string;
  createdAt: number;
  expiresAt: number;
  spaceId?: string;
  fileId?: string;
}

interface QuotedMsgIndexFile {
  version: number;
  updatedAt: number;
  cards: Record<string, QuotedCardIndexEntry>;
  files: Record<string, QuotedFileIndexEntry>;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getIndexFilePath(storePath: string, accountId: string, conversationId: string): string {
  const dir = path.join(
    path.dirname(path.resolve(storePath)),
    "dingtalk-quoted-index",
    sanitizeSegment(accountId),
  );
  return path.join(dir, `${sanitizeSegment(conversationId)}.json`);
}

function readIndexFile(storePath: string, accountId: string, conversationId: string): QuotedMsgIndexFile {
  const filePath = getIndexFilePath(storePath, accountId, conversationId);
  try {
    if (!fs.existsSync(filePath)) {
      return { version: INDEX_FILE_VERSION, updatedAt: Date.now(), cards: {}, files: {} };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return { version: INDEX_FILE_VERSION, updatedAt: Date.now(), cards: {}, files: {} };
    }
    const parsed = JSON.parse(raw) as Partial<QuotedMsgIndexFile>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : INDEX_FILE_VERSION,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      cards: typeof parsed.cards === "object" && parsed.cards ? parsed.cards : {},
      files: typeof parsed.files === "object" && parsed.files ? parsed.files : {},
    };
  } catch {
    return { version: INDEX_FILE_VERSION, updatedAt: Date.now(), cards: {}, files: {} };
  }
}

function writeIndexFile(
  storePath: string,
  accountId: string,
  conversationId: string,
  data: QuotedMsgIndexFile,
): void {
  const filePath = getIndexFilePath(storePath, accountId, conversationId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function purgeExpiredEntries(index: QuotedMsgIndexFile, nowMs: number): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(index.cards)) {
    if (nowMs >= entry.expiresAt) {
      delete index.cards[key];
      changed = true;
    }
  }
  for (const [key, entry] of Object.entries(index.files)) {
    if (nowMs >= entry.expiresAt) {
      delete index.files[key];
      changed = true;
    }
  }
  return changed;
}

export function cacheQuotedCardContent(params: {
  storePath?: string;
  accountId?: string;
  conversationId?: string;
  processQueryKey?: string;
  content: string;
  createdAt?: number;
  ttlMs?: number;
}): void {
  if (!params.storePath || !params.accountId || !params.conversationId || !params.processQueryKey) {
    return;
  }
  if (!params.content.trim()) {
    return;
  }
  const nowMs = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const index = readIndexFile(params.storePath, params.accountId, params.conversationId);
  purgeExpiredEntries(index, nowMs);
  index.cards[params.processQueryKey] = {
    content: params.content,
    createdAt: params.createdAt ?? nowMs,
    expiresAt: nowMs + ttlMs,
  };
  index.updatedAt = nowMs;
  writeIndexFile(params.storePath, params.accountId, params.conversationId, index);
}

export function getQuotedCardContent(params: {
  storePath?: string;
  accountId?: string;
  conversationId?: string;
  processQueryKey?: string;
}): string | null {
  if (!params.storePath || !params.accountId || !params.conversationId || !params.processQueryKey) {
    return null;
  }
  const nowMs = Date.now();
  const index = readIndexFile(params.storePath, params.accountId, params.conversationId);
  const changed = purgeExpiredEntries(index, nowMs);
  const entry = index.cards[params.processQueryKey];
  if (!entry) {
    if (changed) {
      index.updatedAt = nowMs;
      writeIndexFile(params.storePath, params.accountId, params.conversationId, index);
    }
    return null;
  }
  return entry.content;
}

export function cacheQuotedFileMetadata(params: {
  storePath?: string;
  accountId?: string;
  conversationId?: string;
  msgId?: string;
  downloadCode?: string;
  msgType: string;
  createdAt?: number;
  spaceId?: string;
  fileId?: string;
  ttlMs?: number;
}): void {
  if (!params.storePath || !params.accountId || !params.conversationId || !params.msgId) {
    return;
  }
  if (!params.downloadCode && !params.spaceId && !params.fileId) {
    return;
  }
  const nowMs = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const index = readIndexFile(params.storePath, params.accountId, params.conversationId);
  purgeExpiredEntries(index, nowMs);
  index.files[params.msgId] = {
    downloadCode: params.downloadCode,
    msgType: params.msgType,
    createdAt: params.createdAt ?? nowMs,
    expiresAt: nowMs + ttlMs,
    spaceId: params.spaceId,
    fileId: params.fileId,
  };
  index.updatedAt = nowMs;
  writeIndexFile(params.storePath, params.accountId, params.conversationId, index);
}

export function getQuotedFileMetadata(params: {
  storePath?: string;
  accountId?: string;
  conversationId?: string;
  msgId?: string;
}): QuotedFileIndexEntry | null {
  if (!params.storePath || !params.accountId || !params.conversationId || !params.msgId) {
    return null;
  }
  const nowMs = Date.now();
  const index = readIndexFile(params.storePath, params.accountId, params.conversationId);
  const changed = purgeExpiredEntries(index, nowMs);
  const entry = index.files[params.msgId];
  if (!entry) {
    if (changed) {
      index.updatedAt = nowMs;
      writeIndexFile(params.storePath, params.accountId, params.conversationId, index);
    }
    return null;
  }
  return entry;
}
