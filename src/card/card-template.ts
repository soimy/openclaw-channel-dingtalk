/** Card variable value that shows the stop button. */
export const STOP_ACTION_VISIBLE = true;
/** Card variable value that hides the stop button. */
export const STOP_ACTION_HIDDEN = false;

export const BUILTIN_DINGTALK_CARD_TEMPLATE_ID =
  process.env.DINGTALK_CARD_TEMPLATE_ID || "675cde2f-f526-40cb-b828-f5b2b57b8b77.schema";
export const BUILTIN_DINGTALK_CARD_CONTENT_KEY = "content";
export const BUILTIN_DINGTALK_CARD_BLOCK_LIST_KEY = "blockList";
export const BUILTIN_DINGTALK_CARD_COPY_CONTENT_KEY = "copy_content";

export interface DingTalkCardTemplateContract {
  templateId: string;
  contentKey: string;
  /** V2: key for the streaming markdown field (same as contentKey). */
  streamingKey: string;
  /** V2: key for the block-list loopArray variable. */
  blockListKey: string;
  /** V2: key for the plain-text copy content variable (String type for card copy action). */
  copyContentKey: string;
}

/** Frozen singleton — no allocation on every call. */
export const DINGTALK_CARD_TEMPLATE: Readonly<DingTalkCardTemplateContract> = Object.freeze({
  templateId: BUILTIN_DINGTALK_CARD_TEMPLATE_ID,
  contentKey: BUILTIN_DINGTALK_CARD_CONTENT_KEY,
  streamingKey: BUILTIN_DINGTALK_CARD_CONTENT_KEY,
  blockListKey: BUILTIN_DINGTALK_CARD_BLOCK_LIST_KEY,
  copyContentKey: BUILTIN_DINGTALK_CARD_COPY_CONTENT_KEY,
});

