import { AsyncLocalStorage } from "node:async_hooks";
import type {
  DingTalkConfig,
  DingTalkInboundMessage,
  HandleDingTalkMessageParams,
  Logger,
} from "../types";

export type DingTalkQuestionContext = {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
  onQuestionCardSent?: (event: { questionId: string; outTrackId: string }) => void | Promise<void>;
};

const questionContextStorage = new AsyncLocalStorage<DingTalkQuestionContext>();

export function withDingTalkQuestionContext<T>(
  context: DingTalkQuestionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return questionContextStorage.run(context, fn);
}

export function getDingTalkQuestionContext(): DingTalkQuestionContext | undefined {
  return questionContextStorage.getStore();
}
