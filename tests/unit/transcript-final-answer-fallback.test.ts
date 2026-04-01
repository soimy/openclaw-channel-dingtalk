import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    readFileMock: vi.fn(),
    homedirMock: vi.fn(),
    debugMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
    readFile: shared.readFileMock,
}));

vi.mock("node:os", () => ({
    homedir: shared.homedirMock,
}));

vi.mock("../../src/logger-context", () => ({
    getLogger: () => ({
        debug: shared.debugMock,
    }),
}));

import { readLatestAssistantTextFromTranscript } from "../../src/transcript-final-answer-fallback";

describe("transcript-final-answer-fallback", () => {
    beforeEach(() => {
        shared.readFileMock.mockReset();
        shared.homedirMock.mockReset().mockReturnValue("/virtual-home");
        shared.debugMock.mockReset();
    });

    it("reads the latest assistant text via fs/promises.readFile", async () => {
        shared.readFileMock.mockImplementation(async (path: string) => {
            if (path === "/virtual-home/.openclaw/agents/main/sessions/sessions.json") {
                return JSON.stringify({
                    "agent:main:direct:manager8031": {
                        sessionFile: "/virtual-home/.openclaw/agents/main/sessions/abc.jsonl",
                    },
                });
            }
            if (path === "/virtual-home/.openclaw/agents/main/sessions/abc.jsonl") {
                return [
                    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "旧答案" }] } }),
                    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "最终答案" }] } }),
                ].join("\n");
            }
            throw new Error(`unexpected path: ${path}`);
        });

        await expect(
            readLatestAssistantTextFromTranscript({
                agentId: "main",
                sessionKey: "agent:main:direct:manager8031",
            }),
        ).resolves.toBe("最终答案");

        expect(shared.readFileMock).toHaveBeenCalledWith(
            "/virtual-home/.openclaw/agents/main/sessions/sessions.json",
            "utf-8",
        );
        expect(shared.readFileMock).toHaveBeenCalledWith(
            "/virtual-home/.openclaw/agents/main/sessions/abc.jsonl",
            "utf-8",
        );
    });

    it("ignores sessionFile values outside the expected sessions directory", async () => {
        shared.readFileMock.mockImplementation(async (path: string) => {
            if (path === "/virtual-home/.openclaw/agents/main/sessions/sessions.json") {
                return JSON.stringify({
                    "agent:main:direct:manager8031": {
                        sessionFile: "/tmp/escape.jsonl",
                    },
                });
            }
            throw new Error(`unexpected path: ${path}`);
        });

        await expect(
            readLatestAssistantTextFromTranscript({
                agentId: "main",
                sessionKey: "agent:main:direct:manager8031",
            }),
        ).resolves.toBeUndefined();

        expect(shared.readFileMock).toHaveBeenCalledTimes(1);
        expect(shared.readFileMock).toHaveBeenCalledWith(
            "/virtual-home/.openclaw/agents/main/sessions/sessions.json",
            "utf-8",
        );
    });
});
