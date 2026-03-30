import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAttachmentText } from "../../src/messaging/attachment-text-extractor";

vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn().mockImplementation(() => ({
    getText: vi.fn(async () => ({ text: "PDF 第一段\nPDF 第二段" })),
    destroy: vi.fn(async () => undefined),
  })),
}));

vi.mock("mammoth", () => ({
  extractRawText: vi.fn(async () => ({ value: "DOCX 第一段\nDOCX 第二段" })),
}));

const tempFiles: string[] = [];

async function writeTempFile(name: string, content: string | Buffer): Promise<string> {
  const filePath = path.join(os.tmpdir(), `dingtalk-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  await fs.writeFile(filePath, content);
  tempFiles.push(filePath);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((filePath) => fs.rm(filePath, { force: true })));
});

describe("attachment-text-extractor", () => {
  it("extracts plain text files", async () => {
    const filePath = await writeTempFile("notes.txt", "第一行\n\n第二行");

    const result = await extractAttachmentText({
      path: filePath,
      mimeType: "text/plain",
      fileName: "notes.txt",
    });

    expect(result).toEqual({
      text: "第一行\n\n第二行",
      truncated: false,
      sourceType: "text",
    });
  });

  it("extracts html files as plain text", async () => {
    const filePath = await writeTempFile("page.html", "<html><body><h1>标题</h1><p>正文</p></body></html>");

    const result = await extractAttachmentText({
      path: filePath,
      mimeType: "text/html",
      fileName: "page.html",
    });

    expect(result).toEqual({
      text: "标题 正文",
      truncated: false,
      sourceType: "html",
    });
  });

  it("extracts pdf files through pdf-parse", async () => {
    const filePath = await writeTempFile("manual.pdf", Buffer.from("fake-pdf"));

    const result = await extractAttachmentText({
      path: filePath,
      mimeType: "application/pdf",
      fileName: "manual.pdf",
    });

    expect(result).toEqual({
      text: "PDF 第一段\nPDF 第二段",
      truncated: false,
      sourceType: "pdf",
    });
  });

  it("extracts docx files through mammoth", async () => {
    const filePath = await writeTempFile("manual.docx", Buffer.from("fake-docx"));

    const result = await extractAttachmentText({
      path: filePath,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "manual.docx",
    });

    expect(result).toEqual({
      text: "DOCX 第一段\nDOCX 第二段",
      truncated: false,
      sourceType: "docx",
    });
  });

  it("skips image files", async () => {
    const filePath = await writeTempFile("photo.png", Buffer.from("fake-image"));

    const result = await extractAttachmentText({
      path: filePath,
      mimeType: "image/png",
      fileName: "photo.png",
    });

    expect(result).toBeNull();
  });

  it("skips oversized text files before extraction", async () => {
    const filePath = await writeTempFile("huge.txt", Buffer.alloc(2 * 1024 * 1024 + 1, "a"));

    const result = await extractAttachmentText({
      path: filePath,
      mimeType: "text/plain",
      fileName: "huge.txt",
    });

    expect(result).toBeNull();
  });
});
