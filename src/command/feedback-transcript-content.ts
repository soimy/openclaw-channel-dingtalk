import { createHash } from "node:crypto";
import { feedbackTranscriptText } from "../card/feedback-transcript";
import type { FeedbackRecord } from "./feedback-store";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function resolveFeedbackTranscriptMessages(
  record: Pick<FeedbackRecord, "ownerUserId" | "answerHash" | "transcript">,
  events: unknown[],
):
  | {
      question: string;
      answer: string;
    }
  | undefined {
  const link = record.transcript;
  if (link?.status !== "linked") {
    return undefined;
  }
  let question: string | undefined;
  let answer: string | undefined;
  let questionIndex = -1;
  let answerIndex = -1;
  let duplicate = false;
  for (const [index, value] of events.entries()) {
    const entry = object(value);
    if (entry?.type === "session" && entry.id !== link.sessionId) {
      return undefined;
    }
    if (entry?.type !== "message") {
      continue;
    }
    const message = object(entry.message);
    if (entry.id === link.userMessageId) {
      if (questionIndex >= 0 || message?.role !== "user") {
        duplicate = true;
      }
      if (
        typeof message?.senderId === "string" &&
        message.senderId.replace(/^(?:dingtalk|dd|ding):/i, "") !== record.ownerUserId
      ) {
        return undefined;
      }
      if (message?.sourceChannel && message.sourceChannel !== "dingtalk") {
        return undefined;
      }
      question = feedbackTranscriptText(message);
      questionIndex = index;
    }
    if (entry.id === link.assistantMessageId) {
      if (answerIndex >= 0 || message?.role !== "assistant") {
        duplicate = true;
      }
      answer = feedbackTranscriptText(message);
      answerIndex = index;
    }
  }
  if (
    duplicate ||
    question === undefined ||
    answer === undefined ||
    questionIndex >= answerIndex ||
    createHash("sha256").update(answer).digest("hex") !== record.answerHash
  ) {
    return undefined;
  }
  return { question, answer };
}
