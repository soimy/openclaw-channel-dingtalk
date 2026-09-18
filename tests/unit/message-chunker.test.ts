import { describe, expect, it } from "vitest";
import {
  CARD_BLOCK_CHUNK_LIMIT,
  MESSAGE_CHUNK_LIMIT,
  splitByCodePoints,
  splitMessageChunks,
} from "../../src/shared/message-chunker";

const codePoints = (s: string) => Array.from(s).length;

/** Build a CJK string of exactly n code points. */
const cjk = (n: number) => "中".repeat(n);

describe("splitMessageChunks", () => {
  it("returns single chunk for short text", () => {
    expect(splitMessageChunks("hello")).toEqual(["hello"]);
  });

  it("returns single chunk for text exactly at the limit", () => {
    const text = cjk(MESSAGE_CHUNK_LIMIT);
    expect(splitMessageChunks(text)).toEqual([text]);
  });

  it("splits CJK text above the limit by lines", () => {
    // Two 2500-char lines -> 5000 total > 3800.
    const text = `${cjk(2500)}\n${cjk(2500)}`;
    const chunks = splitMessageChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(codePoints)).toEqual([2500, 2500]);
    // Re-joining chunks reproduces the original text.
    expect(chunks.join("\n")).toBe(text);
  });

  it("splits a single line with no newlines", () => {
    const text = cjk(MESSAGE_CHUNK_LIMIT + 500);
    const chunks = splitMessageChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(MESSAGE_CHUNK_LIMIT);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("never inserts newlines into newline-free content (review regression)", () => {
    // Hard-split pieces of one long line must rejoin with NO added separators.
    const text = "x".repeat(7580);
    const chunks = splitMessageChunks(text, 3800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("\n");
    }
  });

  it("never splits surrogate pairs (emoji stay intact)", () => {
    const text = "😀".repeat(3000);
    const chunks = splitMessageChunks(text, 1000);
    for (const chunk of chunks) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(1000);
      // Every chunk must be a sequence of complete surrogate pairs.
      expect(chunk.length % 2).toBe(0);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("re-opens and re-closes code fences across chunk boundaries", () => {
    const lines = ["```js", ...Array.from({ length: 50 }, (_, i) => `line ${i} ${cjk(100)}`), "```"];
    const text = lines.join("\n");
    const chunks = splitMessageChunks(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must stay within the limit, fence markers included.
    for (const chunk of chunks) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(600);
    }
    // Even-index chunks open the fence, odd-index chunks close it, so the
    // concatenation of all chunks (minus the inserted fence markers) is
    // still a single balanced fenced block.
    for (const [i, chunk] of chunks.entries()) {
      if (i < chunks.length - 1) {
        expect(chunk.endsWith("```")).toBe(true);
      }
      if (i > 0) {
        expect(chunk.startsWith("```")).toBe(true);
      }
    }
  });

  it("keeps full-length lines inside a fence within the limit (regression)", () => {
    // Fence close/reopen markers must not push chunks past the limit.
    const text = `\`\`\`\n${"x".repeat(600)}\nb`;
    const chunks = splitMessageChunks(text, 600);
    for (const chunk of chunks) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(600);
    }
    // Content is preserved in order; hard-split pieces rejoin with newlines.
    const rejoined = chunks.join("").replace(/```/g, "");
    expect(rejoined.replace(/\n/g, "")).toBe(`${"x".repeat(600)}b`);
  });

  it("keeps reopened-fence content on its own line after a hard split (review regression)", () => {
    // A reopened fence must be followed by a newline, otherwise the content
    // lands on the fence info-string line and stops rendering.
    const text = "\u0060\u0060\u0060\n" + "A".repeat(5000) + "\n\u0060\u0060\u0060";
    const chunks = splitMessageChunks(text, 3800);
    for (const chunk of chunks) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(3800);
    }
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0) {
        expect(chunk.startsWith("```\n")).toBe(true);
      }
    }
  });

  it("does not leave a stray fence marker for text ending inside a fence", () => {
    const lines = ["```", cjk(500), cjk(500)];
    const chunks = splitMessageChunks(lines.join("\n"), 600);
    expect(chunks[0].endsWith("```")).toBe(true);
    expect(chunks[1].startsWith("```")).toBe(true);
  });

  it("handles the card block limit", () => {
    const text = cjk(CARD_BLOCK_CHUNK_LIMIT + 1);
    const chunks = splitMessageChunks(text, CARD_BLOCK_CHUNK_LIMIT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(codePoints(chunk)).toBeLessThanOrEqual(CARD_BLOCK_CHUNK_LIMIT);
    }
    expect(chunks.join("")).toBe(text);
  });
});

describe("splitByCodePoints", () => {
  it("short text is returned as-is", () => {
    expect(splitByCodePoints("abc", 10)).toEqual(["abc"]);
  });

  it("hard-splits at code-point boundaries", () => {
    expect(splitByCodePoints(cjk(7), 3)).toEqual(["中中中", "中中中", "中"]);
  });

  it("keeps emoji pairs together", () => {
    const chunks = splitByCodePoints("😀😀😀", 2);
    expect(chunks).toEqual(["😀😀", "😀"]);
  });
});
