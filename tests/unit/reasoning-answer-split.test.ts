import { describe, expect, it } from "vitest";
import { splitCardReasoningAnswerText } from "../../src/card/reasoning-answer-split";

describe("reasoning-answer-split", () => {
    it("extracts standalone Reasoning text as thinking content", () => {
        expect(
            splitCardReasoningAnswerText("Reasoning:\n_用户要求分步思考后给结论，纯推理任务。_"),
        ).toEqual({
            reasoningText: "用户要求分步思考后给结论，纯推理任务。",
            answerText: undefined,
        });
    });

    it("splits reasoning-first payloads into thinking and answer content", () => {
        expect(
            splitCardReasoningAnswerText("Reasoning:\n_Reason: 先检查当前目录_\n\n最终答案：/tmp"),
        ).toEqual({
            reasoningText: "Reason: 先检查当前目录",
            answerText: "最终答案：/tmp",
        });
    });

    it("splits answer-first payloads that end with a stable Reasoning block", () => {
        expect(
            splitCardReasoningAnswerText("结论：3天\n\nReasoning:\n_1. 任务总量设为 1。_\n_2. 团队总效率为 1/3。_"),
        ).toEqual({
            reasoningText: "1. 任务总量设为 1。\n2. 团队总效率为 1/3。",
            answerText: "结论：3天",
        });
    });

    it("does not split visible markdown process text that only embeds a Reasoning section", () => {
        const text =
            "**分步思考过程**：\n\n" +
            "**第一步：设定基准并计算单人效率**\n" +
            "- 设总任务量为 1\n" +
            "- 第1人效率：1 ÷ 10 = 1/10\n\n" +
            "Reasoning:\n_1. 设总任务量为1_\n_2. 团队总效率为1/3_";

        expect(splitCardReasoningAnswerText(text)).toEqual({
            answerText: text,
        });
    });

    it("extracts top-level thinking tags", () => {
        expect(
            splitCardReasoningAnswerText("<thinking>先检查目录</thinking>\n最终答案"),
        ).toEqual({
            reasoningText: "先检查目录",
            answerText: "最终答案",
        });
    });

    it("does not treat bare markdown underscores as reasoning content", () => {
        const text = "Reasoning:\n__\n\n最终答案";

        expect(splitCardReasoningAnswerText(text)).toEqual({
            answerText: text,
        });
    });
});
