// src/media-utils.ts

/**
 * Media handling utilities for DingTalk channel plugin.
 * Provides functions for media type detection and file upload to DingTalk media servers.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fsPromises } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import axios from "axios";
import FormData from "form-data";
import type { DingTalkConfig, Logger } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

export type DingTalkMediaType = "image" | "voice" | "video" | "file";
export type DingTalkOutboundMediaType = DingTalkMediaType;

export interface PreparedMediaInput {
  path: string;
  cleanup?: () => Promise<void>;
}

export const REMOTE_MEDIA_ERROR_CODES = {
  ALLOWLIST_MISS: "ERR_MEDIA_ALLOWLIST_MISS",
  PRIVATE_HOST: "ERR_MEDIA_PRIVATE_HOST",
  DNS_UNRESOLVED: "ERR_MEDIA_DNS_UNRESOLVED",
  DNS_PRIVATE: "ERR_MEDIA_DNS_PRIVATE",
  REDIRECT_HOST: "ERR_MEDIA_REDIRECT_HOST",
} as const;

export class RemoteMediaError extends Error {
  constructor(
    message: string,
    public readonly code: (typeof REMOTE_MEDIA_ERROR_CODES)[keyof typeof REMOTE_MEDIA_ERROR_CODES],
  ) {
    super(message);
    this.name = "RemoteMediaError";
  }
}

const REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
const REMOTE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

function normalizeAllowlistEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").trim().toLowerCase();
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, rawMask] = cidr.split("/");
  const mask = Number.parseInt(rawMask || "", 10);
  const normalizedIp = normalizeHostname(ip);
  const normalizedNetwork = normalizeHostname(network || "");
  if (!normalizedNetwork || Number.isNaN(mask)) {
    return false;
  }

  const ipVersion = isIP(normalizedIp);
  const networkVersion = isIP(normalizedNetwork);
  if (ipVersion === 0 || ipVersion !== networkVersion) {
    return false;
  }

  const blockList = new BlockList();
  if (ipVersion === 4) {
    blockList.addSubnet(normalizedNetwork, mask, "ipv4");
    return blockList.check(normalizedIp, "ipv4");
  }

  blockList.addSubnet(normalizedNetwork, mask, "ipv6");
  return blockList.check(normalizedIp, "ipv6");
}

function matchesAllowlistHost(hostname: string, port: string, entry: string): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedEntry = normalizeAllowlistEntry(entry);
  if (!normalizedEntry) {
    return false;
  }

  if (normalizedEntry.includes("/")) {
    return isIpInCidr(normalizedHost, normalizedEntry);
  }

  if (normalizedEntry.startsWith("*.")) {
    const suffix = normalizedEntry.slice(1);
    return normalizedHost.endsWith(suffix);
  }

  if (normalizedEntry.includes(":")) {
    return `${normalizedHost}:${port}` === normalizedEntry;
  }

  return normalizedHost === normalizedEntry;
}

function isAllowedByMediaUrlAllowlist(url: URL, mediaUrlAllowlist: string[]): boolean {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return mediaUrlAllowlist.some((entry) => matchesAllowlistHost(url.hostname, port, entry));
}

/**
 * Detect media type from file extension
 * Matches DingTalk's supported media types:
 * - image: jpg, gif, png, bmp (max 20MB)
 * - voice: amr, mp3, wav (max 2MB)
 * - video: mp4 (max 20MB)
 * - file: doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar (max 20MB)
 *
 * @param filePath Path to the media file
 * @returns Detected media type
 */
export function detectMediaTypeFromExtension(filePath: string): DingTalkMediaType {
  const ext = path.extname(filePath).toLowerCase();

  if ([".jpg", ".jpeg", ".png", ".gif", ".bmp"].includes(ext)) {
    return "image";
  } else if ([".mp3", ".amr", ".wav"].includes(ext)) {
    return "voice";
  } else if ([".mp4", ".avi", ".mov"].includes(ext)) {
    return "video";
  }

  return "file";
}

function normalizeOutboundMediaType(value?: string | null): DingTalkOutboundMediaType | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "voice" || normalized === "video" || normalized === "file") {
    return normalized;
  }

  return undefined;
}

export function resolveOutboundMediaType(params: {
  mediaType?: string | null;
  mediaPath: string;
  asVoice: boolean;
}): DingTalkOutboundMediaType {
  const explicitType = normalizeOutboundMediaType(params.mediaType);
  const detectedType = detectMediaTypeFromExtension(params.mediaPath);

  if (params.asVoice) {
    if (explicitType && explicitType !== "voice") {
      throw new Error('asVoice requires mediaType="voice" when mediaType is provided.');
    }

    if (detectedType !== "voice") {
      throw new Error("asVoice requires an audio file (mp3, amr, wav).");
    }

    return "voice";
  }

  if (explicitType) {
    return explicitType;
  }

  return detectedType;
}

function isRemoteMediaUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return true;
  }

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return true;
    }

    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    if (normalized === "::1") {
      return true;
    }
    return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80");
  }

  return false;
}

async function resolveHostname(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return Array.isArray(records) ? records : [records];
}

function detectExtensionFromContentType(contentType?: string): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "audio/amr":
      return ".amr";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

export async function prepareMediaInput(
  input: string,
  log?: Logger,
  mediaUrlAllowlist?: string[],
): Promise<PreparedMediaInput> {
  const trimmed = input.trim();
  if (!isRemoteMediaUrl(trimmed)) {
    return { path: trimmed };
  }

  const parsedUrl = new URL(trimmed);
  const isPrivateHost = isPrivateOrLocalHost(parsedUrl.hostname);
  const allowlist = mediaUrlAllowlist?.filter((entry) => entry.trim().length > 0) || [];
  const allowlistConfigured = allowlist.length > 0;
  const inAllowlist = allowlistConfigured ? isAllowedByMediaUrlAllowlist(parsedUrl, allowlist) : false;

  if (allowlistConfigured && !inAllowlist) {
    throw new RemoteMediaError(
      `remote media URL host is not in mediaUrlAllowlist: ${parsedUrl.hostname}`,
      REMOTE_MEDIA_ERROR_CODES.ALLOWLIST_MISS,
    );
  }

  if (isPrivateHost && !inAllowlist) {
    throw new RemoteMediaError(
      `remote media URL points to private or local network host: ${parsedUrl.hostname}`,
      REMOTE_MEDIA_ERROR_CODES.PRIVATE_HOST,
    );
  }

  const isIpLiteralHost = isIP(parsedUrl.hostname) !== 0;
  let pinnedResolved: { address: string; family: number } | undefined;
  if (!isIpLiteralHost) {
    const resolvedRecords = await resolveHostname(parsedUrl.hostname);
    if (resolvedRecords.length === 0) {
      throw new RemoteMediaError(
        `remote media URL host cannot be resolved: ${parsedUrl.hostname}`,
        REMOTE_MEDIA_ERROR_CODES.DNS_UNRESOLVED,
      );
    }

    if (!inAllowlist && resolvedRecords.some((record) => isPrivateOrLocalHost(record.address))) {
      throw new RemoteMediaError(
        `remote media URL host resolves to private or local network address: ${parsedUrl.hostname}`,
        REMOTE_MEDIA_ERROR_CODES.DNS_PRIVATE,
      );
    }

    pinnedResolved = resolvedRecords[0];
  }

  const lookup = pinnedResolved
    ? async (hostname: string): Promise<{ address: string; family: number }> => {
        if (hostname === parsedUrl.hostname) {
          return pinnedResolved;
        }

        throw new RemoteMediaError(
          `remote media URL redirected to unexpected host: ${hostname}`,
          REMOTE_MEDIA_ERROR_CODES.REDIRECT_HOST,
        );
      }
    : undefined;

  const response = await axios.get(trimmed, {
    responseType: "arraybuffer",
    maxBodyLength: REMOTE_MEDIA_MAX_BYTES,
    maxContentLength: REMOTE_MEDIA_MAX_BYTES,
    timeout: REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 0,
    lookup,
  });
  const contentType =
    typeof response.headers?.["content-type"] === "string"
      ? response.headers["content-type"]
      : undefined;
  const urlPath = parsedUrl.pathname;
  const ext = path.extname(urlPath) || detectExtensionFromContentType(contentType) || ".bin";
  const tempPath = path.join(os.tmpdir(), `dingtalk_${randomUUID()}${ext}`);
  const buffer = Buffer.isBuffer(response.data)
    ? response.data
    : Buffer.from(response.data as ArrayBuffer);

  await fsPromises.writeFile(tempPath, buffer);
  log?.debug?.(`[DingTalk] Downloaded remote media to temp file: ${tempPath}`);

  return {
    path: tempPath,
    cleanup: async () => {
      try {
        await fsPromises.unlink(tempPath);
      } catch (err: unknown) {
        const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
        if (code !== "ENOENT") {
          const message = err instanceof Error ? err.message : String(err);
          log?.warn?.(`[DingTalk] Failed to remove temp media ${tempPath}: ${message}`);
        }
      }
    },
  };
}

/**
 * File size limits for DingTalk media types (in bytes)
 */
const FILE_SIZE_LIMITS: Record<DingTalkMediaType, number> = {
  image: 20 * 1024 * 1024, // 20MB
  voice: 2 * 1024 * 1024, // 2MB
  video: 20 * 1024 * 1024, // 20MB
  file: 20 * 1024 * 1024, // 20MB
};

/**
 * Upload media file to DingTalk and get media_id
 * Uses DingTalk's media upload API: https://oapi.dingtalk.com/media/upload
 *
 * Note: Media files are stored temporarily by DingTalk (not in permanent storage).
 * The media_id can be used in subsequent message sends.
 *
 * @param config DingTalk configuration
 * @param mediaPath Local path to the media file
 * @param mediaType Type of media: 'image' | 'voice' | 'video' | 'file'
 * @param getAccessToken Function to get DingTalk access token
 * @param log Optional logger
 * @returns media_id on success, null on failure
 */
export async function uploadMedia(
  config: DingTalkConfig,
  mediaPath: string,
  mediaType: DingTalkMediaType,
  getAccessToken: (config: DingTalkConfig, log?: Logger) => Promise<string>,
  log?: Logger,
): Promise<string | null> {
  let fileStream: fs.ReadStream | null = null;

  try {
    const token = await getAccessToken(config, log);

    // Check file size (stat will throw if file doesn't exist)
    const stats = await fsPromises.stat(mediaPath);
    const sizeLimit = FILE_SIZE_LIMITS[mediaType];
    if (stats.size > sizeLimit) {
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      const limitMB = (sizeLimit / (1024 * 1024)).toFixed(2);
      log?.error?.(
        `[DingTalk] Media file too large: ${sizeMB}MB exceeds ${limitMB}MB limit for ${mediaType}`,
      );
      return null;
    }

    // Read file as a stream for better memory efficiency
    fileStream = fs.createReadStream(mediaPath);
    const filename = path.basename(mediaPath);

    // Upload to DingTalk's media server using form-data
    const form = new FormData();
    form.append("media", fileStream, { filename });

    const uploadUrl = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}`;

    log?.debug?.(`[DingTalk] Uploading media: ${filename} (${stats.size} bytes) as ${mediaType}`);

    const response = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    if (response.data?.errcode === 0 && response.data?.media_id) {
      log?.debug?.(
        `[DingTalk] Media uploaded successfully: ${response.data.media_id} (${stats.size} bytes)`,
      );
      return response.data.media_id;
    } else {
      log?.error?.(`[DingTalk] Media upload failed: ${JSON.stringify(response.data)}`);
      return null;
    }
  } catch (err: any) {
    // Handle file system errors (e.g., file not found, permission denied)
    if (err.code === "ENOENT") {
      log?.error?.(`[DingTalk] Media file not found: ${mediaPath}`);
    } else if (err.code === "EACCES") {
      log?.error?.(`[DingTalk] Permission denied accessing media file: ${mediaPath}`);
    } else {
      log?.error?.(`[DingTalk] Failed to upload media: ${err.message}`);
      if (axios.isAxiosError(err) && err.response) {
        const status = err.response.status;
        const statusText = err.response.statusText;
        const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
        log?.error?.(`[DingTalk] Upload response${statusLabel}`);
        log?.error?.(formatDingTalkErrorPayloadLog("media.upload", err.response.data));
      }
    }
    return null;
  } finally {
    // Ensure file stream is closed even on error
    if (fileStream) {
      fileStream.destroy();
    }
  }
}
