import type { DingTalkInboundMessage, MessageContent, QuotedInfo, SendMessageOptions } from "./types";

function extractRichTextQuoteParts(
  richText: Array<Record<string, any>> | undefined,
): { summary: string; pictureDownloadCode?: string } | null {
  if (!Array.isArray(richText) || richText.length === 0) {
    return null;
  }

  const textParts: string[] = [];
  let pictureDownloadCode: string | undefined;

  for (const part of richText) {
    const partType = part.msgType || part.type;
    const textValue = typeof part.content === "string" ? part.content : part.text;

    if ((partType === "text" || partType === undefined) && textValue) {
      textParts.push(textValue);
      continue;
    }
    if ((partType === "emoji") && textValue) {
      textParts.push(textValue);
      continue;
    }
    if (partType === "picture") {
      textParts.push("[图片]");
      if (!pictureDownloadCode) {
        pictureDownloadCode = part.downloadCode;
      }
      continue;
    }
    if (partType === "at") {
      const atName = part.atName || textValue || "某人";
      textParts.push(`@${atName}`);
      continue;
    }
    if (textValue) {
      textParts.push(textValue);
    }
  }

  const summary = textParts.join("").trim();
  if (!summary && !pictureDownloadCode) {
    return null;
  }
  return { summary, pictureDownloadCode };
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

export function extractMessageContent(data: DingTalkInboundMessage): MessageContent {
  const msgtype = data.msgtype || "text";

  const formatQuotedContent = (): QuotedInfo | null => {
    const textField = data.text;

    if (textField?.isReplyMsg && textField?.repliedMsg) {
      const repliedMsg = textField.repliedMsg;
      const repliedMsgType = repliedMsg.msgType;
      const content = repliedMsg.content;

      if (repliedMsgType === "text" && content?.text?.trim()) {
        return { prefix: `[引用消息: "${content.text.trim()}"]\n\n` };
      }

      if (repliedMsgType === "picture" && content?.downloadCode) {
        return {
          prefix: "[引用图片]\n\n",
          mediaDownloadCode: content.downloadCode,
          mediaType: "image",
        };
      }

      if (repliedMsgType === "richText") {
        const richTextQuote = extractRichTextQuoteParts(content?.richText);
        if (richTextQuote) {
          const prefix =
            richTextQuote.summary && richTextQuote.summary !== "[图片]"
              ? `[引用消息: "${richTextQuote.summary}"]\n\n`
              : "[引用图片]\n\n";
          return {
            prefix,
            mediaDownloadCode: richTextQuote.pictureDownloadCode,
            mediaType: richTextQuote.pictureDownloadCode ? "image" : undefined,
          };
        }
      }

      if (repliedMsgType === "unknownMsgType") {
        return {
          prefix: "[引用文件]\n\n",
          isQuotedFile: true,
          fileCreatedAt: repliedMsg.createdAt,
          msgId: repliedMsg.msgId,
        };
      }

      if (repliedMsgType === "interactiveCard") {
        return {
          prefix: "[引用了机器人的回复]\n\n",
          isQuotedCard: true,
          processQueryKey: data.originalProcessQueryKey,
        };
      }

      // Has msgType but not one we handle — generic fallback.
      if (repliedMsgType) {
        return { prefix: "[引用了一条消息]\n\n" };
      }

      // No msgType — backward compat: extract text or richText from content.
      if (content?.text?.trim()) {
        return { prefix: `[引用消息: "${content.text.trim()}"]\n\n` };
      }

      if (content?.richText && Array.isArray(content.richText)) {
        const richTextQuote = extractRichTextQuoteParts(content.richText);
        if (richTextQuote?.summary) {
          return { prefix: `[引用消息: "${richTextQuote.summary}"]\n\n` };
        }
      }
    }

    if (textField?.isReplyMsg && !textField?.repliedMsg && data.originalMsgId) {
      return { prefix: `[这是一条引用消息，原消息ID: ${data.originalMsgId}]\n\n` };
    }

    if (data.quoteMessage) {
      const quoteText = data.quoteMessage.text?.content?.trim() || "";
      if (quoteText) {
        return { prefix: `[引用消息: "${quoteText}"]\n\n` };
      }
    }

    if (data.content?.quoteContent) {
      return { prefix: `[引用消息: "${data.content.quoteContent}"]\n\n` };
    }

    return null;
  };

  const quoted = formatQuotedContent();
  const quotedPrefix = quoted?.prefix || "";

  if (msgtype === "text") {
    return { text: quotedPrefix + (data.text?.content?.trim() || ""), messageType: "text", quoted: quoted ?? undefined };
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
      quoted: quoted ?? undefined,
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

  return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype, quoted: quoted ?? undefined };
}
