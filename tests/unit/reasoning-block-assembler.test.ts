import { describe, expect, it } from "vitest";
import { createReasoningBlockAssembler } from "../../src/card/reasoning-block-assembler";

describe("reasoning-block-assembler", () => {
    it("emits nothing until a complete Reason block is closed", () => {
        const assembler = createReasoningBlockAssembler();

        expect(assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查")).toEqual([]);
        expect(
            assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查当前改动_"),
        ).toEqual([
            "Reason: 先检查当前改动",
        ]);
    });

    it("emits multiple completed think blocks from one snapshot in order", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n_Reason: 先检查当前目录_\n_Reason: 再确认 reply strategy 入口_",
            ),
        ).toEqual([
            "Reason: 先检查当前目录",
            "Reason: 再确认 reply strategy 入口",
        ]);
    });

    it("buffers completed unprefixed reasoning lines until a boundary flush", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n_先检查当前目录_\n_再确认 reply strategy 入口_",
            ),
        ).toEqual([]);

        expect(assembler.flushPendingAtBoundary()).toEqual([
            "先检查当前目录\n再确认 reply strategy 入口",
        ]);
    });

    it("does not re-emit blocks already consumed from a repeated snapshot", () => {
        const assembler = createReasoningBlockAssembler();
        const snapshot = "Reasoning:\n_Reason: 先检查当前目录_\n_Reason: 再确认入口_";

        expect(assembler.ingestSnapshot(snapshot)).toEqual([
            "Reason: 先检查当前目录",
            "Reason: 再确认入口",
        ]);
        expect(assembler.ingestSnapshot(snapshot)).toEqual([]);
    });

    it("emits only newly completed blocks when stream snapshots grow by prefix", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查当前目录_"),
        ).toEqual([
            "Reason: 先检查当前目录",
        ]);
        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n_Reason: 先检查当前目录_\n_Reason: 再确认 reply strategy 入口_",
            ),
        ).toEqual([
            "Reason: 再确认 reply strategy 入口",
        ]);
    });

    it("flushes unfinished pending reasoning as a final think block at boundaries", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n_Reason: 先检查当前目录\n还在整理发送链路",
            ),
        ).toEqual([]);

        expect(assembler.flushPendingAtBoundary()).toEqual([
            "Reason: 先检查当前目录\n还在整理发送链路",
        ]);
        expect(assembler.flushPendingAtBoundary()).toEqual([]);
    });

    it("flushes unfinished unprefixed reasoning lines as a final think block at boundaries", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n_先检查当前目录\n还在整理发送链路",
            ),
        ).toEqual([]);

        expect(assembler.flushPendingAtBoundary()).toEqual([
            "先检查当前目录\n还在整理发送链路",
        ]);
    });

    it("keeps the latest unprefixed reasoning snapshot and flushes the grown content at boundaries", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot("Reasoning:\n_用户再次_"),
        ).toEqual([]);
        expect(
            assembler.ingestSnapshot("Reasoning:\n_用户再次要求分步思考后给出结论_"),
        ).toEqual([]);

        expect(assembler.flushPendingAtBoundary()).toEqual([
            "用户再次要求分步思考后给出结论",
        ]);
    });

    it("ignores empty or malformed snapshots", () => {
        const assembler = createReasoningBlockAssembler();

        expect(assembler.ingestSnapshot(undefined)).toEqual([]);
        expect(assembler.ingestSnapshot("")).toEqual([]);
        expect(assembler.ingestSnapshot("   ")).toEqual([]);
        expect(assembler.ingestSnapshot("Reasoning:\n")).toEqual([]);
        expect(assembler.ingestSnapshot("just answer text")).toEqual([]);
        expect(assembler.flushPendingAtBoundary()).toEqual([]);
    });

    it("handles multi-paragraph reasoning snapshots with growing prefix (real upstream format)", () => {
        const assembler = createReasoningBlockAssembler();

        // Snapshot 1: first paragraph still open (no closing `_`)
        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n_Reason: 用户需要一个PNG格式的纳米香蕉图片，并建议使用'nanobanana'技能。我需要查看是否有相关的skill",
            ),
        ).toEqual([]);

        // Snapshot 2: first paragraph closed, second paragraph still open
        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n" +
                "_Reason: 用户需要一个PNG格式的纳米香蕉图片，并建议使用'nanobanana'技能。我需要查看是否有相关的skill_\n" +
                "_Reason: 从之前看到的可用技能列表中，我没有看到'nanobanana'这个技能",
            ),
        ).toEqual([
            "Reason: 用户需要一个PNG格式的纳米香蕉图片，并建议使用'nanobanana'技能。我需要查看是否有相关的skill",
        ]);

        // Snapshot 3: both paragraphs closed, third still open
        expect(
            assembler.ingestSnapshot(
                "Reasoning:\n" +
                "_Reason: 用户需要一个PNG格式的纳米香蕉图片，并建议使用'nanobanana'技能。我需要查看是否有相关的skill_\n" +
                "_Reason: 从之前看到的可用技能列表中，我没有看到'nanobanana'这个技能_\n" +
                "_Reason: Canvas需要一个node参数，我可以使用HTML文件包含SVG",
            ),
        ).toEqual([
            "Reason: 从之前看到的可用技能列表中，我没有看到'nanobanana'这个技能",
        ]);

        // Boundary flush emits the still-open third paragraph
        expect(assembler.flushPendingAtBoundary()).toEqual([
            "Reason: Canvas需要一个node参数，我可以使用HTML文件包含SVG",
        ]);
    });

    it("reset clears both consumed history and pending reasoning", () => {
        const assembler = createReasoningBlockAssembler();

        expect(
            assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查当前目录_"),
        ).toEqual([
            "Reason: 先检查当前目录",
        ]);
        expect(
            assembler.ingestSnapshot("Reasoning:\n_Reason: 再确认 reply strategy 入口"),
        ).toEqual([]);

        assembler.reset();

        expect(
            assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查当前目录_"),
        ).toEqual([
            "Reason: 先检查当前目录",
        ]);
        expect(assembler.flushPendingAtBoundary()).toEqual([]);
    });
});
