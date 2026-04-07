import { describe, expect, it } from "vitest";
import { buildBtwBlockquote } from "../../src/messaging/btw-deliver";

describe("buildBtwBlockquote", () => {
  it("formats a normal /btw question with sender prefix", () => {
    const result = buildBtwBlockquote("王滨", "/btw 这个函数为什么慢");
    expect(result).toBe("> 王滨: /btw 这个函数为什么慢\n\n");
  });

  it("omits sender prefix when senderName is empty", () => {
    const result = buildBtwBlockquote("", "/btw foo");
    expect(result).toBe("> /btw foo\n\n");
  });

  it("strips a single leading @mention", () => {
    const result = buildBtwBlockquote("王滨", "@Bot /btw foo");
    expect(result).toBe("> 王滨: /btw foo\n\n");
  });

  it("strips multiple leading @mentions", () => {
    const result = buildBtwBlockquote("王滨", "@Bot @Other /btw foo");
    expect(result).toBe("> 王滨: /btw foo\n\n");
  });

  it("truncates question over 80 characters with ellipsis", () => {
    const longQuestion = "/btw " + "a".repeat(200);
    const result = buildBtwBlockquote("王滨", longQuestion);
    // 80 chars (including "/btw " prefix) + …
    expect(result.startsWith("> 王滨: ")).toBe(true);
    expect(result).toContain("…\n\n");
    // The cleaned question portion (after "> 王滨: ") should be exactly 80 chars + …\n\n
    const inner = result.slice("> 王滨: ".length, -2); // strip "\n\n"
    expect(inner).toHaveLength(81); // 80 + …
    expect(inner.endsWith("…")).toBe(true);
  });

  it("does not truncate question at exactly 80 characters", () => {
    const exact80 = "/btw " + "a".repeat(75); // total 80 chars
    const result = buildBtwBlockquote("王滨", exact80);
    expect(result).toBe(`> 王滨: ${exact80}\n\n`);
    expect(result).not.toContain("…");
  });
});
