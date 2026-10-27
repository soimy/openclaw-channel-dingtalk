/** Metadata capture only: no filesystem reads, polling, extra hooks, or model calls. */
export type FeedbackTranscriptLink =
  | {
      status: "linked";
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string;
      source: "runtime-events";
      /** Local-only read hint from a trusted host event; never uploaded. */
      localFile?: string;
    }
  | {
      status: "unavailable";
      reason:
        | "events-unavailable"
        | "question-not-observed"
        | "answer-not-observed"
        | "session-id-missing"
        | "ambiguous-turn"
        | "content-mismatch"
        | "capture-limit";
    };

export interface FeedbackTranscriptTracker {
  bindRun(runId: string): void;
  resolve(answer: string, options?: { includeLocalFile?: boolean }): FeedbackTranscriptLink;
  dispose(): void;
}
type RunOwner = { sessionId(sessionId: string, agentId?: string, sessionKey?: string): void };
const activeRuns = new Map<string, RunOwner>();
const MAX_TEXT_CHARS = 128_000;
const MAX_CANDIDATES = 8;

/** Called from the channel's existing llm_output hook, not a new prompt/model hook. */
export function noteFeedbackRunSession(
  runId: string,
  sessionId: string | undefined,
  context?: { agentId?: string; sessionKey?: string },
): void {
  if (sessionId) {
    activeRuns.get(runId)?.sessionId(sessionId, context?.agentId, context?.sessionKey);
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
/** Visible text only. Thinking/tool blocks are not exposed by feedback detail. */
export function feedbackTranscriptText(message: unknown): string | undefined {
  const content = object(message)?.content;
  if (typeof content === "string") {
    return content.length <= MAX_TEXT_CHARS ? content : undefined;
  }
  if (!Array.isArray(content) || content.length > 1024) {
    return undefined;
  }
  const parts: string[] = [];
  let size = 0;
  for (const block of content) {
    const row = object(block);
    if (row?.type !== "text" || typeof row.text !== "string") {
      continue;
    }
    size += row.text.length + (parts.length ? 1 : 0);
    if (size > MAX_TEXT_CHARS) {
      return undefined;
    }
    parts.push(row.text);
  }
  return parts.length ? parts.join("\n") : undefined;
}
function mirrorTurn(message: Record<string, unknown>): string | undefined {
  const value = string(object(message.__openclaw)?.mirrorIdentity);
  return value ? /^(.*):(?:prompt|assistant)$/.exec(value)?.[1] : undefined;
}
function sender(value: string): string {
  return value.trim().replace(/^(?:dingtalk|dd|ding):/i, "");
}

export function createFeedbackTranscriptTracker(options: {
  agentId: string;
  sessionKey: string;
  senderId: string;
  questionTexts: readonly string[];
  questionSessionKeys?: readonly string[];
  subscribe?: (listener: (event: unknown) => void) => () => void;
}): FeedbackTranscriptTracker {
  let disposed = false;
  let ambiguous = false;
  let limitReached = false;
  let sessionFromRun: string | undefined;
  let question: { id: string; sessionId?: string; file?: string; mirror?: string } | undefined;
  const candidates: Array<{ id: string; sessionId?: string; text: string }> = [];
  const runIds = new Set<string>();
  const questionTexts = new Set(options.questionTexts.filter(Boolean));
  const questionKeys = new Set([options.sessionKey, ...(options.questionSessionKeys ?? [])]);
  const runOwner: RunOwner = {
    sessionId(id, agentId, sessionKey) {
      if (
        disposed ||
        (agentId && agentId !== options.agentId) ||
        (sessionKey && sessionKey !== options.sessionKey)
      ) {
        return;
      }
      if (sessionFromRun && sessionFromRun !== id) {
        ambiguous = true;
      }
      sessionFromRun = id;
    },
  };
  const accept = (value: unknown) => {
    if (disposed || ambiguous || limitReached) {
      return;
    }
    const event = object(value);
    const target = object(event?.target);
    const key = string(target?.sessionKey) ?? string(event?.sessionKey);
    const agent = string(target?.agentId) ?? string(event?.agentId);
    const message = object(event?.message);
    const acceptedKey =
      message?.role === "user" ? questionKeys.has(key ?? "") : key === options.sessionKey;
    if (!acceptedKey || agent !== options.agentId) {
      return;
    }
    const id = string(event?.messageId);
    if (!message || !id || !["user", "assistant"].includes(String(message.role))) {
      return;
    }
    const sessionId = string(target?.sessionId) ?? string(event?.sessionId);
    const file = string(event?.sessionFile);
    if (
      question &&
      ((question.sessionId && sessionId && question.sessionId !== sessionId) ||
        (question.file && file && question.file !== file))
    ) {
      ambiguous = true;
      return;
    }
    if (message.role === "user") {
      if (question?.id === id) {
        return;
      }
      if (question) {
        ambiguous = true;
        return;
      }
      if (message.sourceChannel && message.sourceChannel !== "dingtalk") {
        return;
      }
      if (
        typeof message.senderId === "string" &&
        sender(message.senderId) !== sender(options.senderId)
      ) {
        return;
      }
      const text = feedbackTranscriptText(message);
      if (text === undefined || !questionTexts.has(text)) {
        return;
      }
      question = { id, sessionId, file, mirror: mirrorTurn(message) };
      return;
    }
    if (
      !question ||
      ["error", "aborted", "toolUse", "tool_calls"].includes(String(message.stopReason))
    ) {
      return;
    }
    const mirror = mirrorTurn(message);
    if (question.mirror && mirror && question.mirror !== mirror) {
      return;
    }
    if (candidates.some((candidate) => candidate.id === id)) {
      return;
    }
    const text = feedbackTranscriptText(message);
    if (text === undefined || candidates.length >= MAX_CANDIDATES) {
      limitReached = true;
      return;
    }
    candidates.push({ id, sessionId, text });
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = options.subscribe?.(accept);
  } catch {
    /* Optional capability must not fail a reply. */
  }
  return {
    bindRun(runId) {
      if (disposed || !unsubscribe || !runId) {
        return;
      }
      const existing = activeRuns.get(runId);
      if (existing && existing !== runOwner) {
        ambiguous = true;
        return;
      }
      runIds.add(runId);
      activeRuns.set(runId, runOwner);
    },
    resolve(answer, captureOptions) {
      const unavailable = (
        reason: Extract<FeedbackTranscriptLink, { status: "unavailable" }>["reason"],
      ): FeedbackTranscriptLink => ({ status: "unavailable", reason });
      if (!unsubscribe) {
        return unavailable("events-unavailable");
      }
      if (ambiguous) {
        return unavailable("ambiguous-turn");
      }
      if (limitReached) {
        return unavailable("capture-limit");
      }
      if (!question) {
        return unavailable("question-not-observed");
      }
      if (!candidates.length) {
        return unavailable("answer-not-observed");
      }
      const matches = candidates.filter((candidate) => candidate.text === answer);
      if (matches.length !== 1) {
        return unavailable(matches.length ? "ambiguous-turn" : "content-mismatch");
      }
      const match = matches[0];
      const ids = new Set(
        [match.sessionId, question.sessionId, sessionFromRun].filter((id): id is string =>
          Boolean(id),
        ),
      );
      if (ids.size !== 1) {
        return unavailable(ids.size ? "ambiguous-turn" : "session-id-missing");
      }
      return {
        status: "linked",
        source: "runtime-events",
        sessionId: [...ids][0],
        userMessageId: question.id,
        assistantMessageId: match.id,
        ...(captureOptions?.includeLocalFile && question.file ? { localFile: question.file } : {}),
      };
    },
    dispose() {
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
        /* Capture cleanup must never break reply cleanup. */
      } finally {
        for (const id of runIds) {
          if (activeRuns.get(id) === runOwner) {
            activeRuns.delete(id);
          }
        }
        candidates.length = 0;
        runIds.clear();
        question = undefined;
      }
    },
  };
}
