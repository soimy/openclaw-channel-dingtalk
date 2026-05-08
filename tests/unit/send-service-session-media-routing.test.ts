import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/auth", () => ({
    getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

const messageContextMocks = vi.hoisted(() => ({
    upsertOutboundMessageContextMock: vi.fn(),
}));

vi.mock("../../src/message-context-store", async () => {
    const actual = await vi.importActual<typeof import("../../src/message-context-store")>(
        "../../src/message-context-store",
    );
    return {
        ...actual,
        upsertOutboundMessageContext: messageContextMocks.upsertOutboundMessageContextMock,
    };
});

vi.mock("../../src/media-utils", () => ({
    uploadMedia: vi.fn(),
    detectMediaTypeFromExtension: vi.fn(),
    getVoiceDurationMs: vi.fn(),
    prepareMediaInput: vi.fn(),
    resolveOutboundMediaType: vi.fn(),
}));

vi.mock("axios", () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import { sendBySession, sendMessage } from "../../src/send-service";
import { uploadMedia as uploadMediaUtil } from "../../src/media-utils";
import { AICardStatus } from "../../src/types";

const mockedAxios = vi.mocked(axios);
const mockedUploadMedia = vi.mocked(uploadMediaUtil);

describe("send-service sessionWebhook media routing", () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        mockedUploadMedia.mockReset();
        messageContextMocks.upsertOutboundMessageContextMock.mockReset();
    });

    it("embeds uploaded session images in markdown instead of using native image body", async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: "media_img_session",
            buffer: Buffer.from("img"),
        });
        mockedAxios.mockResolvedValueOnce({
            data: { success: true, result: true, messageId: "session_markdown_1" },
        } as any);

        await sendBySession(
            { clientId: "id", clientSecret: "sec" } as any,
            "https://session.webhook",
            "图片说明",
            { mediaPath: "/tmp/a.png", mediaType: "image" },
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.url).toBe("https://session.webhook");
        expect(req.data).toEqual({
            msgtype: "markdown",
            markdown: {
                title: "图片说明",
                text: "图片说明\n\n![a.png](media_img_session)",
            },
        });
    });

    it("routes session file replies through proactive media instead of native session file body", async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: "media_file_session",
            buffer: Buffer.from("file"),
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: "q_file_session" } } as any);

        const result = await sendMessage(
            { clientId: "id", clientSecret: "sec" } as any,
            "user_123",
            "",
            {
                sessionWebhook: "https://session.webhook",
                mediaPath: "/tmp/report.pdf",
                mediaType: "file",
                accountId: "main",
                storePath: "/tmp/sessions.json",
            } as any,
        );

        expect(result).toMatchObject({
            ok: true,
            data: { processQueryKey: "q_file_session" },
            messageId: "q_file_session",
        });
        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.url).toContain("/v1.0/robot/oToMessages/batchSend");
        expect(req.url).not.toBe("https://session.webhook");
        expect(req.data.msgKey).toBe("sampleFile");
        expect(JSON.parse(req.data.msgParam)).toEqual({
            mediaId: "media_file_session",
            fileName: "report.pdf",
            fileType: "pdf",
        });
        expect(messageContextMocks.upsertOutboundMessageContextMock).toHaveBeenCalledWith(
            expect.objectContaining({
                messageType: "outbound-proactive-media",
                delivery: expect.objectContaining({
                    processQueryKey: "q_file_session",
                    kind: "proactive-media",
                }),
            }),
        );
    });

    it("routes terminal card session file replies through proactive media", async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: "media_file_terminal_card",
            buffer: Buffer.from("file"),
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: "q_terminal_card_file" } } as any);

        const result = await sendMessage(
            { clientId: "id", clientSecret: "sec", messageType: "card" } as any,
            "user_123",
            "终态卡片附件",
            {
                card: {
                    cardInstanceId: "card_done",
                    state: AICardStatus.FINISHED,
                    lastUpdated: Date.now(),
                },
                sessionWebhook: "https://session.webhook",
                mediaPath: "/tmp/terminal-card-report.pdf",
                mediaType: "file",
                accountId: "main",
                storePath: "/tmp/sessions.json",
            } as any,
        );

        expect(result).toMatchObject({
            ok: true,
            data: { processQueryKey: "q_terminal_card_file" },
            messageId: "q_terminal_card_file",
        });
        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.url).toContain("/v1.0/robot/oToMessages/batchSend");
        expect(req.url).not.toBe("https://session.webhook");
        expect(req.data.msgKey).toBe("sampleFile");
        expect(JSON.parse(req.data.msgParam)).toEqual({
            mediaId: "media_file_terminal_card",
            fileName: "terminal-card-report.pdf",
            fileType: "pdf",
        });
    });

    it("falls back to a text description when sessionWebhook receives a non-image media request directly", async () => {
        mockedAxios.mockResolvedValueOnce({
            data: { success: true, result: true, messageId: "session_text_1" },
        } as any);

        await sendBySession(
            { clientId: "id", clientSecret: "sec" } as any,
            "https://session.webhook",
            "文件说明",
            { mediaPath: "/tmp/report.pdf", mediaType: "file" } as any,
        );

        expect(mockedUploadMedia).not.toHaveBeenCalled();
        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data).toEqual({
            msgtype: "markdown",
            markdown: {
                title: "文件说明",
                text: "文件说明\n\n📎 当前会话无法直接发送 file，兜底链接/路径：/tmp/report.pdf",
            },
        });
    });
});
