import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    analyzeImplicitNegativeFeedback,
    buildLearningContextBlock,
    recordExplicitFeedbackLearning,
    recordOutboundReplyForLearning,
} from "../../src/feedback-learning-service";
import {
    appendSessionLearningNote,
    listActiveSessionLearningNotes,
    listFeedbackEvents,
    listLearnedRules,
    listOutboundReplySnapshots,
    listReflectionRecords,
} from "../../src/feedback-learning-store";
import type { MessageContent } from "../../src/types";

describe("feedback-learning-service", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createStorePath(): string {
        const dir = path.join(
            os.tmpdir(),
            `openclaw-dingtalk-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        );
        tempDirs.push(dir);
        return path.join(dir, "session-store.json");
    }

    function createContent(overrides: Partial<MessageContent> = {}): MessageContent {
        return {
            text: "请你重新回答这张图里有什么",
            messageType: "text",
            ...overrides,
        };
    }

    it("records outbound snapshots and explicit negative feedback without auto-applying by default", () => {
        const storePath = createStorePath();
        recordOutboundReplyForLearning({
            enabled: true,
            storePath,
            accountId: "main",
            targetId: "chat-a",
            sessionKey: "session-a",
            question: "看下这张图",
            answer: "这是服务器状态图",
            processQueryKey: "pqk-1",
            mode: "card",
        });

        recordExplicitFeedbackLearning({
            enabled: true,
            storePath,
            accountId: "main",
            targetId: "chat-a",
            feedbackType: "feedback_down",
            userId: "user-1",
            processQueryKey: "pqk-1",
            noteTtlMs: 60_000,
        });

        const snapshots = listOutboundReplySnapshots({ storePath, accountId: "main", targetId: "chat-a" });
        const events = listFeedbackEvents({ storePath, accountId: "main", targetId: "chat-a" });
        const reflections = listReflectionRecords({ storePath, accountId: "main", targetId: "chat-a" });
        const notes = listActiveSessionLearningNotes({ storePath, accountId: "main", targetId: "chat-a" });
        const rules = listLearnedRules({ storePath, accountId: "main" });

        expect(snapshots).toHaveLength(1);
        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("explicit_negative");
        expect(reflections[0]?.category).toBe("missing_image_context");
        expect(notes).toHaveLength(0);
        expect(rules).toHaveLength(0);
    });

    it("promotes repeated negative signals into account-scoped global rules when auto-apply is enabled", () => {
        const storePath = createStorePath();
        for (const targetId of ["chat-a", "chat-b"]) {
            recordOutboundReplyForLearning({
                enabled: true,
                storePath,
                accountId: "main",
                targetId,
                sessionKey: `session-${targetId}`,
                question: "看下这张图",
                answer: "这是图片里的人物",
                mode: "markdown",
            });
            recordExplicitFeedbackLearning({
                enabled: true,
                autoApply: true,
                storePath,
                accountId: "main",
                targetId,
                feedbackType: "feedback_down",
            });
        }

        const rules = listLearnedRules({ storePath, accountId: "main" });
        expect(rules.find((item) => item.ruleId === "rule_missing_image_context")).toMatchObject({
            enabled: true,
            negativeCount: 2,
        });

        const block = buildLearningContextBlock({
            enabled: true,
            storePath,
            accountId: "main",
            targetId: "chat-c",
            content: createContent({ text: "帮我看图总结一下" }),
        });
        expect(block).toContain("高优先级学习约束");
        expect(block).toContain("以这些规则为准");
        expect(block).toContain("禁止臆测内容");
    });

    it("turns implicit dissatisfaction into session notes only when auto-apply is enabled", () => {
        const storePath = createStorePath();
        recordOutboundReplyForLearning({
            enabled: true,
            storePath,
            accountId: "main",
            targetId: "chat-a",
            sessionKey: "session-a",
            question: "引用里说了什么",
            answer: "引用里应该是在说部署问题",
            mode: "markdown",
        });

        analyzeImplicitNegativeFeedback({
            enabled: true,
            autoApply: true,
            storePath,
            accountId: "main",
            targetId: "chat-a",
            signalText: "不是这个意思，你别猜引用原文",
            content: createContent({ text: "不是这个意思，你别猜引用原文" }),
            noteTtlMs: 60_000,
        });

        const events = listFeedbackEvents({ storePath, accountId: "main", targetId: "chat-a" });
        const reflections = listReflectionRecords({ storePath, accountId: "main", targetId: "chat-a" });
        const notes = listActiveSessionLearningNotes({ storePath, accountId: "main", targetId: "chat-a" });

        expect(events[0]?.kind).toBe("implicit_negative");
        expect(reflections[0]?.category).toBe("quoted_context_missing");
        expect(notes[0]?.instruction).toContain("禁止根据上下文臆测引用内容");
    });

    it("clears target-scoped artifacts even when target only exists in persisted note buckets", () => {
        const storePath = createStorePath();
        appendSessionLearningNote({
            storePath,
            accountId: "main",
            targetId: "chat-orphan",
            note: {
                id: "note_1",
                targetId: "chat-orphan",
                instruction: "记住这条临时规则",
                source: "implicit_negative",
                category: "generic_negative",
                createdAt: Date.now(),
            },
            ttlMs: 60_000,
        });

        expect(listActiveSessionLearningNotes({
            storePath,
            accountId: "main",
            targetId: "chat-orphan",
        })).toHaveLength(1);

        expect(listActiveSessionLearningNotes({
            storePath,
            accountId: "main",
            targetId: "chat-orphan",
        })).toHaveLength(1);
    });
});
