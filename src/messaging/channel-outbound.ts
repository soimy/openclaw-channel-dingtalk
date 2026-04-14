import { randomUUID } from "node:crypto";
import { getConfig } from "../config";
import { getLogger } from "../logger-context";
import { getDingTalkRuntime } from "../runtime";
import { sendMedia, sendMessage } from "../send-service";
import { normalizeResolvedDingTalkTarget } from "../targeting/target-directory-adapter";
import type { DingTalkChannelPlugin } from "../types";
import { formatDingTalkErrorPayloadLog, parseBooleanLike } from "../utils";

function readBooleanLikeParam(params: Record<string, unknown>, key: string): boolean | undefined {
  return parseBooleanLike(params[key]);
}

function readSharedAudioAsVoiceParam(params: Record<string, unknown>): boolean {
  const sharedValue = readBooleanLikeParam(params, "audioAsVoice");
  if (sharedValue !== undefined) {
    return sharedValue;
  }
  return readBooleanLikeParam(params, "asVoice") === true;
}

export function createDingTalkOutbound(): NonNullable<DingTalkChannelPlugin["outbound"]> {
  return {
    deliveryMode: "direct",
    resolveTarget: ({ to }: any) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false as const,
          error: new Error("DingTalk message requires --to <conversationId>"),
        };
      }
      return { ok: true as const, to: normalizeResolvedDingTalkTarget(trimmed) };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      const runtime = getDingTalkRuntime();
      const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: accountId,
      });
      const effectiveLog = getLogger(accountId) || log;
      try {
        const result = await sendMessage(config, to, text, {
          log: effectiveLog,
          accountId,
          storePath,
          conversationId: to,
        });
        effectiveLog?.debug?.(`[DingTalk] sendText: "${text}" result: ${JSON.stringify(result)}`);
        if (!result.ok) {
          throw new Error(result.error || "sendText failed");
        }
        const data = result.data as any;
        const messageId = String(data?.processQueryKey || data?.messageId || randomUUID());
        const meta =
          result.data || result.tracking
            ? {
                ...(result.data ? { data: result.data as unknown as Record<string, unknown> } : {}),
                ...(result.tracking ? { tracking: result.tracking } : {}),
              }
            : undefined;
        return {
          channel: "dingtalk",
          messageId,
          meta,
        };
      } catch (err: any) {
        if (err?.response?.data !== undefined) {
          effectiveLog?.error?.(formatDingTalkErrorPayloadLog("outbound.sendText", err.response.data));
        }
        throw new Error(
          typeof err?.response?.data === "string"
            ? err.response.data
            : err?.message || "sendText failed",
          { cause: err },
        );
      }
    },
    sendMedia: async ({
      cfg,
      to,
      mediaPath,
      filePath,
      mediaUrl,
      mediaType: providedMediaType,
      audioAsVoice,
      asVoice,
      accountId,
      mediaLocalRoots,
      log,
      expectedCardOwnerId,
    }: any) => {
      const config = getConfig(cfg, accountId);
      const runtime = getDingTalkRuntime();
      const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: accountId,
      });
      const effectiveLog = getLogger(accountId) || log;
      if (!config.clientId) {
        throw new Error("DingTalk not configured");
      }

      const rawMediaPath = mediaPath || filePath || mediaUrl;
      if (!rawMediaPath) {
        throw new Error(
          `mediaPath, filePath, or mediaUrl is required. Received: ${JSON.stringify({
            to,
            mediaPath,
            filePath,
            mediaUrl,
          })}`,
        );
      }

      const requestedMediaType = typeof providedMediaType === "string"
        ? (providedMediaType as "image" | "voice" | "video" | "file")
        : undefined;

      try {
        const result = await sendMedia(config, to, rawMediaPath, {
          log: effectiveLog,
          accountId,
          storePath,
          conversationId: to,
          mediaType: requestedMediaType,
          audioAsVoice: readSharedAudioAsVoiceParam({ audioAsVoice, asVoice }),
          mediaLocalRoots,
          expectedCardOwnerId,
        });
        effectiveLog?.debug?.(`[DingTalk] sendMedia result: ${JSON.stringify(result)}`);
        if (!result.ok) {
          throw new Error(result.error || "sendMedia failed");
        }
        const data = result.data;
        const messageId = String(
          result.messageId || data?.processQueryKey || data?.messageId || randomUUID(),
        );
        return {
          channel: "dingtalk",
          messageId,
          meta: result.data
            ? { data: result.data as unknown as Record<string, unknown> }
            : undefined,
        };
      } catch (err: any) {
        if (err?.response?.data !== undefined) {
          effectiveLog?.error?.(formatDingTalkErrorPayloadLog("outbound.sendMedia", err.response.data));
        }
        throw new Error(
          typeof err?.response?.data === "string"
            ? err.response.data
            : err?.message || "sendMedia failed",
          { cause: err },
        );
      }
    },
  };
}
