import { describe, expect, it } from "vitest";
import {
  buildImagePlaceholderText,
  classifyMarkdownImageUrl,
  extractMarkdownImageCandidates,
} from "../../src/card/card-markdown-image-reroute";

describe("card-markdown-image-reroute", () => {
  describe("classifyMarkdownImageUrl", () => {
    it("classifies public https images as public", () => {
      expect(classifyMarkdownImageUrl("https://example.com/a.png")).toBe("public");
    });

    it("classifies file URLs as local", () => {
      expect(classifyMarkdownImageUrl("file:///tmp/a.png")).toBe("local");
    });

    it("classifies relative paths as local", () => {
      expect(classifyMarkdownImageUrl("./artifacts/a.png")).toBe("local");
    });

    it("classifies plain relative paths as local", () => {
      expect(classifyMarkdownImageUrl("artifacts/a.png")).toBe("local");
    });

    it("classifies localhost URLs as local", () => {
      expect(classifyMarkdownImageUrl("http://127.0.0.1:3000/a.png")).toBe("local");
    });

    it("classifies LAN URLs as local", () => {
      expect(classifyMarkdownImageUrl("http://192.168.0.8/a.png")).toBe("local");
    });
  });

  describe("buildImagePlaceholderText", () => {
    it("uses markdown alt text when available", () => {
      expect(buildImagePlaceholderText({ alt: "系统架构图", url: "./arch.png" })).toBe("见下图系统架构图");
    });

    it("falls back to file name when alt text is empty", () => {
      expect(buildImagePlaceholderText({ alt: "", url: "./artifacts/arch.png" })).toBe("见下图arch.png");
    });

    it("falls back to generic label when no alt or file name exists", () => {
      expect(buildImagePlaceholderText({ alt: "", url: "file:///" })).toBe("见下图图片");
    });
  });

  describe("extractMarkdownImageCandidates", () => {
    it("extracts markdown image candidates with source positions", () => {
      const text = "前言\n\n![系统架构图](./artifacts/arch.png)\n\n结尾";
      expect(extractMarkdownImageCandidates(text)).toEqual([
        {
          alt: "系统架构图",
          url: "./artifacts/arch.png",
          raw: "![系统架构图](./artifacts/arch.png)",
          classification: "local",
          start: 4,
          end: 34,
        },
      ]);
    });

    it("does not extract ordinary markdown links", () => {
      const text = "请查看[设计文档](https://example.com/design.md)";
      expect(extractMarkdownImageCandidates(text)).toEqual([]);
    });

    it("extracts public markdown images without rewriting them yet", () => {
      const text = "![封面](https://example.com/cover.png)";
      expect(extractMarkdownImageCandidates(text)).toEqual([
        {
          alt: "封面",
          url: "https://example.com/cover.png",
          raw: "![封面](https://example.com/cover.png)",
          classification: "public",
          start: 0,
          end: 36,
        },
      ]);
    });
  });
});
