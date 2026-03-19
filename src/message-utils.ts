import type { AtMention, DingTalkInboundMessage, MessageContent, QuotedInfo, SendMessageOptions } from "./types";


interface DingTalkDocMeta {
  spaceId: string;
  fileId: string;
}

function parseBizCustomActionUrl(url: string | undefined): DingTalkDocMeta | null {
  if (!url || typeof url !== "string") {
    return null;
  }

  const queryIndex = url.indexOf("?");
  if (queryIndex < 0 || queryIndex === url.length - 1) {
    return null;
  }

  try {
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    const route = params.get("route");
    const type = params.get("type");
    const spaceId = params.get("spaceId");
    const fileId = params.get("fileId");
    if (route !== "previewDentry" || type !== "file" || !spaceId || !fileId) {
      return null;
    }
    return { spaceId, fileId };
  } catch {
    return null;
  }
}

function extractRichTextQuoteParts(
  richText: Array<Record<string, unknown>> | undefined,
): { summary: string; pictureDownloadCode?: string; pictureDownloadCodes?: string[] } | null {
  if (!Array.isArray(richText) || richText.length === 0) {
    return null;
  }

  const textParts: string[] = [];
  const pictureDownloadCodes: string[] = [];

  for (const part of richText) {
    const partType =
      typeof part.msgType === "string"
        ? part.msgType
        : typeof part.type === "string"
          ? part.type
          : undefined;
    const textValue =
      typeof part.content === "string"
        ? part.content
        : typeof part.text === "string"
          ? part.text
          : undefined;

    if ((partType === "text" || partType === undefined) && textValue) {
      textParts.push(textValue);
      continue;
    }
    if (partType === "emoji" && textValue) {
      textParts.push(textValue);
      continue;
    }
    if (partType === "picture") {
      textParts.push("[图片]");
      if (typeof part.downloadCode === "string" && part.downloadCode.trim()) {
        pictureDownloadCodes.push(part.downloadCode.trim());
      }
      continue;
    }
    if (partType === "at") {
      const atName =
        typeof part.atName === "string"
          ? part.atName
          : typeof textValue === "string"
            ? textValue
            : "某人";
      textParts.push(`@${atName}`);
      continue;
    }
    if (textValue) {
      textParts.push(textValue);
    }
  }

  const summary = textParts.join("").trim();
  const uniquePictureDownloadCodes = [...new Set(pictureDownloadCodes)];
  const pictureDownloadCode = uniquePictureDownloadCodes[0];
  if (!summary && !pictureDownloadCode) {
    return null;
  }
  return {
    summary,
    pictureDownloadCode,
    pictureDownloadCodes: uniquePictureDownloadCodes.length > 0 ? uniquePictureDownloadCodes : undefined,
  };
}

/**
 * Auto-detect markdown usage and derive message title.
 * Title extraction follows DingTalk markdown card title constraints.
 */
export function detectMarkdownAndExtractTitle(
  text: string,
  options: SendMessageOptions,
  defaultTitle: string,
): { useMarkdown: boolean; title: string } {
  const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
  const useMarkdown = options.useMarkdown !== false && (options.useMarkdown || hasMarkdown);

  const title =
    options.title ||
    (useMarkdown
      ? text
          .split("\n")[0]
          .replace(/^[#*\s\->]+/, "")
          .slice(0, 20) || defaultTitle
      : defaultTitle);

  return { useMarkdown, title };
}

function isMarkdownTableSeparator(line: string): boolean {
  const normalized = line.trim();
  if (!normalized.includes("-")) {
    return false;
  }
  const cells = normalized
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !trimmed.startsWith("```");
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdownTable(lines: string[]): string {
  const rows = lines.map(parseMarkdownTableRow).filter((cells) => cells.length > 0);
  return rows.map((cells) => cells.join(" | ")).join("  \n");
}

export function convertMarkdownTablesToPlainText(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  let inCodeFence = false;

  while (index < lines.length) {
    const line = lines[index] || "";
    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      output.push(line);
      index += 1;
      continue;
    }

    if (
      !inCodeFence &&
      index + 1 < lines.length &&
      isMarkdownTableRow(line) &&
      isMarkdownTableSeparator(lines[index + 1] || "")
    ) {
      const tableLines = [line];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] || "")) {
        tableLines.push(lines[index] || "");
        index += 1;
      }
      output.push(renderMarkdownTable(tableLines));
      continue;
    }

    output.push(line);
    index += 1;
  }

  return output.join("\n");
}

export function extractMessageContent(data: DingTalkInboundMessage): MessageContent {
  const msgtype = data.msgtype || "text";
  const atMentions: AtMention[] = [];

  // 提取通过 @picker 选中的真实用户的 dingtalkId
  // 这些是真实钉钉用户，不包含 agent 名（如 @frontend）
  const atUserDingtalkIds = data.atUsers?.map((u) => u.dingtalkId).filter(Boolean);

  const formatQuotedContent = (): QuotedInfo | null => {
    const textField = data.text;

    if (textField?.isReplyMsg && textField?.repliedMsg) {
      const repliedMsg = textField.repliedMsg;
      const repliedMsgType = repliedMsg.msgType;
      const content = repliedMsg.content;

      if (repliedMsgType === "picture" && content?.downloadCode) {
        return {
          mediaDownloadCode: content.downloadCode,
          mediaType: "image",
        };
      }

      if (repliedMsgType === "richText") {
        const richTextQuote = extractRichTextQuoteParts(content?.richText);
        if (richTextQuote) {
          return {
            mediaDownloadCode: richTextQuote.pictureDownloadCode,
            mediaType: richTextQuote.pictureDownloadCode ? "image" : undefined,
          };
        }
      }

      if (repliedMsgType === "unknownMsgType") {
        return {
          isQuotedFile: true,
          fileCreatedAt: repliedMsg.createdAt,
          msgId: repliedMsg.msgId,
        };
      }

      if (repliedMsgType === "interactiveCard") {
        const isBotCard = repliedMsg.senderId === data.chatbotUserId;
        if (isBotCard) {
          return {
            isQuotedCard: true,
            cardCreatedAt: repliedMsg.createdAt,
            processQueryKey: data.originalProcessQueryKey,
            msgId: repliedMsg.msgId,
          };
        }

        return {
          isQuotedDocCard: true,
          fileCreatedAt: repliedMsg.createdAt,
          msgId: repliedMsg.msgId,
        };
      }

      if (repliedMsgType && repliedMsg.msgId) {
        return { msgId: repliedMsg.msgId };
      }

      // No msgType — backward compat: extract text or richText from content.
      if (content?.text?.trim()) {
        return repliedMsg.msgId ? { msgId: repliedMsg.msgId } : null;
      }

      if (content?.richText && Array.isArray(content.richText)) {
        const richTextQuote = extractRichTextQuoteParts(content.richText);
        if (richTextQuote) {
          return {
            msgId: repliedMsg.msgId,
            mediaDownloadCode: richTextQuote.pictureDownloadCode,
            mediaType: richTextQuote.pictureDownloadCode ? "image" : undefined,
          };
        }
      }
    }

    if (textField?.isReplyMsg && !textField?.repliedMsg && data.originalMsgId) {
      return {
        msgId: data.originalMsgId,
      };
    }

    if (data.quoteMessage) {
      if (data.quoteMessage.msgId) {
        return { msgId: data.quoteMessage.msgId };
      }
    }

    return null;
  };

  const quoted = formatQuotedContent();

  if (msgtype === "text") {
    const textContent = quotedPrefix + (data.text?.content?.trim() || "");

    // Strip quoted prefix before extracting @mentions to avoid matching @names inside quotes.
    const textForAtExtraction = textContent.replace(/^\[引用[^\]]*\]\s*/, "");
    // Match @name but exclude email-like patterns (user@domain.com) and emoji (@_@).
    const atMatches = textForAtExtraction.matchAll(/(?<!\w)@([^\s@.]+)(?!\.\w)/g);
    for (const match of atMatches) {
      atMentions.push({ name: match[1].trim() });
    }

    return {
      text: textContent,
      messageType: "text",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "richText") {
    const richTextParts = data.content?.richText || [];
    let text = "";
    const pictureDownloadCodes: string[] = [];
    // Keep first image downloadCode while preserving readable text and @mention parts.
    for (const part of richTextParts) {
      if (part.text && (part.type === "text" || part.type === undefined)) {
        text += part.text;
      }
      if (part.type === "at" && part.atName) {
        text += `@${part.atName} `;
        // 提取 @ 提及信息，包括 atUserId
        atMentions.push({
          name: part.atName.trim(),
          userId: part.atUserId,
        });
      }
      if (part.type === "picture" && part.downloadCode) {
        pictureDownloadCodes.push(part.downloadCode);
      }
    }
    const uniquePictureDownloadCodes = [...new Set(pictureDownloadCodes)];
    const pictureDownloadCode = uniquePictureDownloadCodes[0];
    return {
      text: text.trim() || (pictureDownloadCode ? "<media:image>" : "[富文本消息]"),
      mediaPath: pictureDownloadCode,
      mediaPaths: uniquePictureDownloadCodes.length > 0 ? uniquePictureDownloadCodes : undefined,
      mediaType: pictureDownloadCode ? "image" : undefined,
      mediaTypes: uniquePictureDownloadCodes.length > 0 ? uniquePictureDownloadCodes.map(() => "image") : undefined,
      messageType: "richText",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "picture") {
    return {
      text: "<media:image>",
      mediaPath: data.content?.downloadCode,
      mediaType: "image",
      messageType: "picture",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "audio") {
    return {
      text: data.content?.recognition || "<media:voice>",
      mediaPath: data.content?.downloadCode,
      mediaType: "audio",
      messageType: "audio",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "video") {
    return {
      text: "<media:video>",
      mediaPath: data.content?.downloadCode,
      mediaType: "video",
      messageType: "video",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "file") {
    return {
      text: `<media:file> (${data.content?.fileName || "文件"})`,
      mediaPath: data.content?.downloadCode,
      mediaType: "file",
      messageType: "file",
      atMentions,
      atUserDingtalkIds,
    };
  }

  if (msgtype === "interactiveCard") {
    const docMeta = parseBizCustomActionUrl(data.content?.biz_custom_action_url);
    if (docMeta) {
      return {
        text: "[钉钉文档]\n\n",
        messageType: "interactiveCardFile",
        docSpaceId: docMeta.spaceId,
        docFileId: docMeta.fileId,
        quoted: quoted ?? undefined,
        atMentions,
        atUserDingtalkIds,
      };
    }
    return {
      text: data.text?.content?.trim() || "[interactiveCard消息]",
      messageType: msgtype,
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }
  if (msgtype === "chatRecord") {
    const content = data.content as Record<string, unknown> | undefined;
    const summary = typeof content?.summary === "string" ? content.summary.trim() : "";
    const rawRecord = content?.chatRecord;
    if (
      summary === "[]" ||
      (typeof rawRecord === "string" && rawRecord.trim() === "[]") ||
      (Array.isArray(rawRecord) && rawRecord.length === 0)
    ) {
      return {
        text: "[系统提示] 没有读到引用记录（chatRecord 为空）。请改用逐条转发、复制原文，或重新转发非空聊天记录。",
        messageType: "chatRecord",
        quoted: quoted ?? undefined,
        atMentions,
        atUserDingtalkIds,
      };
    }
    if (summary) {
      return {
        text: `[聊天记录摘要] ${summary}`,
        messageType: "chatRecord",
        quoted: quoted ?? undefined,
        atMentions,
        atUserDingtalkIds,
      };
    }
    return {
      text: "[chatRecord消息: 无可读内容]",
      messageType: "chatRecord",
      quoted: quoted ?? undefined,
      atMentions,
      atUserDingtalkIds,
    };
  }

  return {
    text: data.text?.content?.trim() || `[${msgtype}消息]`,
    messageType: msgtype,
    quoted: quoted ?? undefined,
    atMentions,
    atUserDingtalkIds,
  };
}
