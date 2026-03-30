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

    it("ignores empty or malformed snapshots", () => {
        const assembler = createReasoningBlockAssembler();

        expect(assembler.ingestSnapshot(undefined)).toEqual([]);
        expect(assembler.ingestSnapshot("")).toEqual([]);
        expect(assembler.ingestSnapshot("   ")).toEqual([]);
        expect(assembler.ingestSnapshot("Reasoning:\n")).toEqual([]);
        expect(assembler.ingestSnapshot("just answer text")).toEqual([]);
        expect(assembler.flushPendingAtBoundary()).toEqual([]);
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
