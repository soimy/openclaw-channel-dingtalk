import axios from "axios";
import { getAccessToken } from "./auth";
import { getDingTalkRuntime } from "./runtime";
import type { DingTalkConfig, MediaFile } from "./types";
import { formatDingTalkErrorPayloadLog, maskSensitiveData } from "./utils";

type MediaDownloadLogger = {
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
};

function formatAxiosErrorData(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Buffer.isBuffer(value)) {
    return `<buffer ${value.length} bytes>`;
  }
  if (value instanceof ArrayBuffer) {
    return `<arraybuffer ${value.byteLength} bytes>`;
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  try {
    return JSON.stringify(maskSensitiveData(value));
  } catch {
    return String(value);
  }
}

export async function downloadMedia(
  config: DingTalkConfig,
  downloadCode: string,
  log?: MediaDownloadLogger,
): Promise<MediaFile | null> {
  const rt = getDingTalkRuntime();

  if (!downloadCode) {
    log?.error?.("[DingTalk] downloadMedia requires downloadCode to be provided.");
    return null;
  }
  if (!config.robotCode) {
    log?.error?.("[DingTalk] downloadMedia requires robotCode to be configured.");
    return null;
  }

  try {
    const token = await getAccessToken(config, log as any);
    const response = await axios.post(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      { downloadCode, robotCode: config.robotCode },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
    const payload = response.data as Record<string, any>;
    const downloadUrl = payload?.downloadUrl ?? payload?.data?.downloadUrl;
    if (!downloadUrl) {
      const payloadDetail = formatAxiosErrorData(payload);
      log?.error?.(
        `[DingTalk] downloadMedia missing downloadUrl. payload=${payloadDetail ?? "unknown"}`,
      );
      return null;
    }

    const mediaResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
    const contentType = mediaResponse.headers["content-type"] || "application/octet-stream";
    const buffer = Buffer.from(mediaResponse.data as ArrayBuffer);
    const maxBytes =
      config.mediaMaxMb && config.mediaMaxMb > 0 ? config.mediaMaxMb * 1024 * 1024 : undefined;
    const saved = maxBytes
      ? await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound", maxBytes)
      : await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound");

    log?.debug?.(`[DingTalk] Media saved: ${saved.path}`);
    return { path: saved.path, mimeType: saved.contentType ?? contentType };
  } catch (err: any) {
    if (log?.error) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const statusText = err.response?.statusText;
        const dataDetail = formatAxiosErrorData(err.response?.data);
        const code = err.code ? ` code=${err.code}` : "";
        const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
        log.error(
          `[DingTalk] Failed to download media:${statusLabel}${code} message=${err.message}`,
        );
        if (err.response?.data !== undefined) {
          log.error(formatDingTalkErrorPayloadLog("inbound.downloadMedia", err.response.data));
        } else if (dataDetail) {
          log.error(`[DingTalk] downloadMedia response data: ${dataDetail}`);
        }
      } else {
        log.error(`[DingTalk] Failed to download media: ${err.message}`);
      }
    }
    return null;
  }
}
