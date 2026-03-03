import type { DingTalkInboundMessage, MessageContent, SendMessageOptions } from "./types";

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

export function extractMessageContent(data: DingTalkInboundMessage): MessageContent {
  const msgtype = data.msgtype || "text";

  // Normalize quote/reply metadata into a readable text prefix so the agent can understand message context.
  const formatQuotedContent = (): string => {
    const textField = data.text as any;

    if (textField?.isReplyMsg && textField?.repliedMsg) {
      const repliedMsg = textField.repliedMsg as any;
      const content = repliedMsg?.content;

      if (content?.text) {
        const quoteText = content.text.trim();
        if (quoteText) {
          return `[引用消息: "${quoteText}"]\n\n`;
        }
      }

      if (content?.richText && Array.isArray(content.richText)) {
        const textParts: string[] = [];
        for (const part of content.richText) {
          if (part.msgType === "text" && part.content) {
            textParts.push(part.content);
          } else if (part.msgType === "emoji" || part.type === "emoji") {
            textParts.push(part.content || "[表情]");
          } else if (part.msgType === "picture" || part.type === "picture") {
            textParts.push("[图片]");
          } else if (part.msgType === "at" || part.type === "at") {
            textParts.push(`@${part.content || part.atName || "某人"}`);
          } else if (part.text) {
            textParts.push(part.text);
          }
        }
        const quoteText = textParts.join("").trim();
        if (quoteText) {
          return `[引用消息: "${quoteText}"]\n\n`;
        }
      }

      const repliedMsgType = String(repliedMsg?.msgType || "").trim();
      const repliedMsgId = String(repliedMsg?.msgId || data.originalMsgId || "").trim();
      if (repliedMsgType === "unknownMsgType" || repliedMsgType) {
        const idPart = repliedMsgId ? `，原消息ID: ${repliedMsgId}` : "";
        return `[引用消息不可见: msgType=${repliedMsgType || "unknown"}${idPart}]\n\n`;
      }
    }

    // Some clients only send originalMsgId for rich media reply messages.
    if (textField?.isReplyMsg && !textField?.repliedMsg && data.originalMsgId) {
      return `[这是一条引用消息，原消息ID: ${data.originalMsgId}]\n\n`;
    }

    if (data.quoteMessage) {
      const quoteText = data.quoteMessage.text?.content?.trim() || "";
      if (quoteText) {
        return `[引用消息: "${quoteText}"]\n\n`;
      }
    }

    if (data.content?.quoteContent) {
      return `[引用消息: "${data.content.quoteContent}"]\n\n`;
    }

    return "";
  };

  const quotedPrefix = formatQuotedContent();

  // Unified extraction by DingTalk msgtype for downstream routing/agent processing.
  if (msgtype === "text") {
    return { text: quotedPrefix + (data.text?.content?.trim() || ""), messageType: "text" };
  }

  if (msgtype === "richText") {
    const richTextParts = data.content?.richText || [];
    let text = "";
    let pictureDownloadCode: string | undefined;
    // Keep first image downloadCode while preserving readable text and @mention parts.
    for (const part of richTextParts) {
      if (part.text && (part.type === "text" || part.type === undefined)) {
        text += part.text;
      }
      if (part.type === "at" && part.atName) {
        text += `@${part.atName} `;
      }
      if (part.type === "picture" && part.downloadCode && !pictureDownloadCode) {
        pictureDownloadCode = part.downloadCode;
      }
    }
    return {
      text:
        quotedPrefix + (text.trim() || (pictureDownloadCode ? "<media:image>" : "[富文本消息]")),
      mediaPath: pictureDownloadCode,
      mediaType: pictureDownloadCode ? "image" : undefined,
      messageType: "richText",
    };
  }

  if (msgtype === "picture") {
    return {
      text: "<media:image>",
      mediaPath: data.content?.downloadCode,
      mediaType: "image",
      messageType: "picture",
    };
  }

  if (msgtype === "audio") {
    return {
      text: data.content?.recognition || "<media:voice>",
      mediaPath: data.content?.downloadCode,
      mediaType: "audio",
      messageType: "audio",
    };
  }

  if (msgtype === "video") {
    return {
      text: "<media:video>",
      mediaPath: data.content?.downloadCode,
      mediaType: "video",
      messageType: "video",
    };
  }

  if (msgtype === "file") {
    return {
      text: `<media:file> (${data.content?.fileName || "文件"})`,
      mediaPath: data.content?.downloadCode,
      mediaType: "file",
      messageType: "file",
    };
  }

  if (msgtype === "chatRecord") {
    const summary = String((data.content as any)?.summary || "").trim();
    const rawRecord = (data.content as any)?.chatRecord;
    let parsedLines: string[] = [];

    if (typeof rawRecord === "string" && rawRecord.trim()) {
      try {
        const arr = JSON.parse(rawRecord);
        if (Array.isArray(arr)) {
          parsedLines = arr
            .map((it: any) => {
              const sender = String(it?.senderName || it?.senderNick || it?.senderId || "某人").trim();
              const content = String(it?.content || it?.text || "").trim();
              return content ? `${sender}: ${content}` : "";
            })
            .filter(Boolean)
            .slice(0, 20);
        }
      } catch {
        // ignore parse errors and fallback to summary only
      }
    }

    const parts: string[] = [];
    if (summary) {
      parts.push(`[聊天记录摘要] ${summary}`);
    }
    if (parsedLines.length > 0) {
      parts.push(`[聊天记录内容]\n${parsedLines.join("\n")}`);
    }
    const text = parts.join("\n\n") || "[chatRecord消息: 无可读内容]";
    return { text, messageType: "chatRecord" };
  }

  // Fallback: preserve unknown msgtype as readable marker.
  return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype };
}
