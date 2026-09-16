import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    analyzeImplicitNegativeFeedback,
    applyManualGlobalLearningRule,
    applyManualTargetLearningRule,
    buildLearningContextBlock,
    isManualGlobalRuleAllowed,
    recordExplicitFeedbackLearning,
    recordOutboundReplyForLearning,
    resolveLearningRuleTtlMs,
    resolveManualForcedReply,
} from "../../src/command/feedback-learning-service";
import type { LearnedRulePolicy } from "../../src/command/feedback-learning-service";
import {
    listActiveSessionLearningNotes,
    listFeedbackEvents,
    listLearnedRules,
    listOutboundReplySnapshots,
    listReflectionRecords,
} from "../../src/command/feedback-learning-store";
import type { MessageContent } from "../../src/platform/types";

/** Learning switches as the three rule-consuming paths receive them. */
function testPolicy(overrides: Partial<LearnedRulePolicy> = {}): LearnedRulePolicy {
    return {
        learningEnabled: true,
        allowManualGlobalRules: false,
        ruleTtlMs: 0,
        ...overrides,
    };
}

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
            policy: testPolicy(),
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

    describe("buildLearningContextBlock rule filtering", () => {
        const TTL_MS = 30 * 24 * 60 * 60 * 1000;

        it("skips owner-written account-wide rules unless manual global rules are allowed", () => {
            const storePath = createStorePath();
            applyManualGlobalLearningRule({
                storePath,
                accountId: "main",
                instruction: "全局规则：回答要带暗号。",
            });
            const params = {
                storePath,
                accountId: "main",
                targetId: "chat-a",
                content: createContent({ text: "随便聊聊" }),
            };

            expect(
                buildLearningContextBlock({ ...params, policy: testPolicy({ ruleTtlMs: TTL_MS }) }),
            ).not.toContain("回答要带暗号");

            const allowed = buildLearningContextBlock({
                ...params,
                policy: testPolicy({ allowManualGlobalRules: true, ruleTtlMs: TTL_MS }),
            });
            expect(allowed).toContain("回答要带暗号");
        });

        it("still injects target-scoped rules without the global switch", () => {
            const storePath = createStorePath();
            applyManualTargetLearningRule({
                storePath,
                accountId: "main",
                targetId: "chat-a",
                instruction: "本会话规则：先确认再回答。",
            });

            const block = buildLearningContextBlock({
                policy: testPolicy({ ruleTtlMs: TTL_MS }),
                storePath,
                accountId: "main",
                targetId: "chat-a",
                content: createContent({ text: "随便聊聊" }),
            });
            expect(block).toContain("本会话规则：先确认再回答");
        });

        it("stops injecting rules that are older than the TTL", () => {
            const storePath = createStorePath();
            applyManualTargetLearningRule({
                storePath,
                accountId: "main",
                targetId: "chat-a",
                instruction: "本会话规则：过期后不该出现。",
            });
            const base = {
                storePath,
                accountId: "main",
                targetId: "chat-a",
                content: createContent({ text: "随便聊聊" }),
            };
            const fresh = testPolicy({ allowManualGlobalRules: true, ruleTtlMs: TTL_MS });

            expect(buildLearningContextBlock({ ...base, policy: fresh })).toContain("过期后不该出现");
            expect(
                buildLearningContextBlock({
                    ...base,
                    policy: { ...fresh, now: Date.now() + 40 * 24 * 60 * 60 * 1000 },
                }),
            ).not.toContain("过期后不该出现");
            expect(
                buildLearningContextBlock({
                    ...base,
                    policy: {
                        allowManualGlobalRules: true,
                        ruleTtlMs: 0,
                        learningEnabled: true,
                        now: Date.now() + 400 * 24 * 60 * 60 * 1000,
                    },
                }),
            ).toContain("过期后不该出现");
        });
    });

    describe("resolveManualForcedReply", () => {
        const trigger = "暗号是多少";
        const content: MessageContent = { text: trigger, messageType: "text" };

        it("returns the rule, scope and target so the override can be audited", () => {
            const storePath = createStorePath();
            applyManualTargetLearningRule({
                storePath,
                accountId: "main",
                targetId: "cid_1",
                instruction: "当用户问“暗号是多少”时，必须回答“本会话答案”。",
            });

            const match = resolveManualForcedReply({
                storePath,
                accountId: "main",
                targetId: "cid_1",
                content,
                policy: testPolicy(),
            });

            expect(match).toMatchObject({ reply: "本会话答案", scope: "target", targetId: "cid_1" });
            expect(match?.ruleId).toBeTruthy();
        });

        it("skips account-wide rules unless global rules are allowed", () => {
            const storePath = createStorePath();
            applyManualGlobalLearningRule({
                storePath,
                accountId: "main",
                instruction: "当用户问“暗号是多少”时，必须回答“全局答案”。",
            });

            const gated = resolveManualForcedReply({
                storePath,
                accountId: "main",
                content,
                policy: testPolicy(),
            });
            expect(gated).toBeNull();

            const allowed = resolveManualForcedReply({
                storePath,
                accountId: "main",
                content,
                policy: testPolicy({ allowManualGlobalRules: true }),
            });
            expect(allowed).toMatchObject({ reply: "全局答案", scope: "global" });
        });

        it("stops matching rules older than the configured TTL", () => {
            const storePath = createStorePath();
            applyManualGlobalLearningRule({
                storePath,
                accountId: "main",
                instruction: "当用户问“暗号是多少”时，必须回答“全局答案”。",
            });
            const inFortyDays = Date.now() + 40 * 24 * 60 * 60 * 1000;

            const expired = resolveManualForcedReply({
                storePath,
                accountId: "main",
                content,
                policy: testPolicy({
                    allowManualGlobalRules: true,
                    ruleTtlMs: 30 * 24 * 60 * 60 * 1000,
                    now: inFortyDays,
                }),
            });
            expect(expired).toBeNull();

            const stillFresh = resolveManualForcedReply({
                storePath,
                accountId: "main",
                content,
                policy: testPolicy({
                    allowManualGlobalRules: true,
                    ruleTtlMs: 30 * 24 * 60 * 60 * 1000,
                    now: Date.now() + 60 * 1000,
                }),
            });
            expect(stillFresh).toMatchObject({ reply: "全局答案" });
        });

        it("keeps matching old rules when expiry is disabled", () => {
            const storePath = createStorePath();
            applyManualGlobalLearningRule({
                storePath,
                accountId: "main",
                instruction: "当用户问“暗号是多少”时，必须回答“全局答案”。",
            });

            const match = resolveManualForcedReply({
                storePath,
                accountId: "main",
                content,
                policy: testPolicy({
                    allowManualGlobalRules: true,
                    ruleTtlMs: 0,
                    now: Date.now() + 400 * 24 * 60 * 60 * 1000,
                }),
            });
            expect(match).toMatchObject({ reply: "全局答案" });
        });

        it("defaults to a 30 day rule TTL and no global forced replies", () => {
            expect(resolveLearningRuleTtlMs(undefined)).toBe(30 * 24 * 60 * 60 * 1000);
            expect(isManualGlobalRuleAllowed(undefined)).toBe(false);
            expect(isManualGlobalRuleAllowed({ learningAllowManualGlobalRules: true })).toBe(true);
        });
    });
});
